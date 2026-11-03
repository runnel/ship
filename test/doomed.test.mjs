import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runCheck as realRunCheck } from '../lib/check.mjs';
import { acquire, ownerInfo, readOwner } from '../lib/lock.mjs';
import { acquireShared } from '../lib/shared.mjs';
import { mirrorPath } from '../lib/git.mjs';
import { watchDoomed } from '../lib/doomed.mjs';
import { setupCheck as setup, atTestEnd, git, tempDir, commitFiles, waitUntil, readPid, assertGone, killQuietly, stopBackground, tracked } from './helpers.mjs';

// However a test ends, the lane it held and the check waiting for it end with it.
afterEach(stopBackground, { timeout: 30_000 });
const runCheck = tracked(realRunCheck);

// A repo that asks for a fresh check when main gains a file under db/.
const RECHECK_CONFIG = (steps = ['true'], lane = 'heavy') =>
  `export default { repo: 't/r', docsOnly: ['*.md'], recheckOnMainChange: ['db/**'], checks: [${JSON.stringify({ name: 'unit', lane, paths: ['src/**'], steps })}] };\n`;

const FAST = { doomedPollMs: 25, doomedConfirmMs: 5 };
// The timed looks never fire: only the looks before queueing and when the lane is won are made.
const ONLY_AT_THE_GATES = { doomedPollMs: 1_000_000, doomedFreshMs: 0, doomedConfirmMs: 5 };

// Takes a lane the way a running check would, so that the check under test has to wait for it.
const holdLane = async (s, lane = 'heavy') => {
  const dir = join(s.deps.tmpRoot, 'lanes', lane);
  const release = atTestEnd(await acquire(dir, await ownerInfo({ repo: 't/r', command: 'test holder' }), { pollMs: 10 }));
  return { dir, release, nonce: (await readOwner(dir)).nonce };
};

const pushMain = async (s, files) => {
  await git(['checkout', '--quiet', 'main'], s.work);
  const sha = await commitFiles(s.work, files, 'main moves again');
  await git(['push', '--quiet', s.origin, 'main'], s.work);
  await git(['checkout', '--quiet', 'feat'], s.work);
  return sha;
};

const waitingForLane = (s) => waitUntil(() => s.lines.some((l) => l.includes('waiting for the')), 'the check waits for the lane');

// Nothing but the statuses of a check that was still queued or running: no verdict of any kind.
const assertNoVerdict = async (s) => {
  const states = (await s.statuses()).map((x) => x.state);
  assert.ok(states.length > 0 && states.every((x) => x === 'pending'), `posted: ${states.join(', ')}`);
};

// The stopped check gave its place in line back and the lane is still its holder's.
const assertLaneUntouched = async (s, holder) => {
  assert.deepEqual((await readdir(join(s.deps.tmpRoot, 'lanes'))).sort(), ['heavy'], 'no ticket left behind');
  assert.equal((await readOwner(holder.dir)).nonce, holder.nonce);
};

test('a PR merged while its check waits for the lane: the check stops, gives its place back, posts nothing', { timeout: 30_000 }, async () => {
  const s = await setup({ configText: RECHECK_CONFIG(['touch ran-step']) });
  const holder = await holdLane(s);
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } });
  await waitingForLane(s);
  await s.setPr({ state: 'MERGED' });
  assert.equal(await run, 2);
  assert.ok(s.lines.some((l) => /^✗ stopped checking PR #7 @ [0-9a-f]{7}: PR #7 was merged \(no verdict posted\)$/.test(l)), s.lines.join('\n'));
  await assertNoVerdict(s);
  await assertLaneUntouched(s, holder);
  assert.ok(!s.lines.some((l) => /^[✓✗] unit:/.test(l)), 'no step ran');
  await holder.release();
});

test('a PR closed while its check waits: stopped, and the same for a light-lane check', { timeout: 30_000 }, async () => {
  const s = await setup({ configText: RECHECK_CONFIG(['true'], 'light') });
  const holder = await holdLane(s, 'light');
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } });
  await waitingForLane(s);
  await s.setPr({ state: 'CLOSED' });
  assert.equal(await run, 2);
  assert.ok(s.lines.some((l) => /stopped checking PR #7 .*PR #7 was closed/.test(l)), s.lines.join('\n'));
  await assertNoVerdict(s);
  assert.deepEqual((await readdir(join(s.deps.tmpRoot, 'lanes'))).sort(), ['light']);
  await holder.release();
});

test('a head pushed while the check waits: stopped, and the new head is named', { timeout: 30_000 }, async () => {
  const s = await setup({ configText: RECHECK_CONFIG() });
  const holder = await holdLane(s);
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } });
  await waitingForLane(s);
  await s.setPr({ headRefOid: 'f'.repeat(40) });
  assert.equal(await run, 2);
  assert.ok(s.lines.some((l) => /stopped checking PR #7 .*the head of PR #7 moved to fffffff; run ship check --pr 7 for it/.test(l)), s.lines.join('\n'));
  await assertNoVerdict(s);
  await assertLaneUntouched(s, holder);
  await holder.release();
});

test('main gaining a file that makes ship merge refuse: stopped while waiting, with the file named', { timeout: 30_000 }, async () => {
  const s = await setup({ configText: RECHECK_CONFIG() });
  const holder = await holdLane(s);
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } });
  await waitingForLane(s);
  await pushMain(s, { 'db/001_add.sql': 'select 1;\n', 'src/other.ts': 'o\n' });
  assert.equal(await run, 2);
  assert.ok(s.lines.some((l) => /stopped checking PR #7 .*main gained db\/001_add\.sql since this check began \(vs main@[0-9a-f]{7}\), so ship merge would refuse the result; run ship check --pr 7 again/.test(l)), s.lines.join('\n'));
  await assertNoVerdict(s);
  await assertLaneUntouched(s, holder);
  await holder.release();
});

test('main moving in a way that does not void the check: it waits its turn, runs and passes', { timeout: 30_000 }, async () => {
  const s = await setup({ configText: RECHECK_CONFIG() });
  const holder = await holdLane(s);
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } });
  await waitingForLane(s);
  const moved = await pushMain(s, { 'src/other.ts': 'o\n', 'notes.md': 'n\n' });
  // The look at the moved main is under way once the mirror has it, and over once the next one starts.
  const views = async () => (await s.calls()).filter((c) => c[0] === 'pr' && c[1] === 'view').length;
  await waitUntil(async () => (await git(['--git-dir', mirrorPath('t/r', s.deps.mirrorRoot), 'rev-parse', 'refs/heads/main'], s.work).catch(() => '')).trim() === moved, 'a look at the moved main');
  const seen = await views();
  await waitUntil(async () => (await views()) >= seen + 2, 'two more looks');
  assert.ok(!s.lines.some((l) => l.includes('stopped checking')), s.lines.join('\n'));
  await holder.release();
  assert.equal(await run, 0, s.lines.join('\n'));
  assert.equal((await s.statuses()).at(-1).state, 'success');
});

test('a PR that is still open at its head does not stop a check that waits and runs', { timeout: 30_000 }, async () => {
  const s = await setup({ configText: RECHECK_CONFIG(['sleep 0.2']) });
  assert.equal(await runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } }), 0, s.lines.join('\n'));
  assert.equal((await s.statuses()).at(-1).state, 'success');
});

test('a check that cannot reach GitHub to look goes on', { timeout: 30_000 }, async () => {
  // The first answer (the one that starts the check) is fine; every look after it fails.
  const s = await setup({ configText: RECHECK_CONFIG(), ghOptions: { prSequence: [{}, { fail: true }] } });
  const holder = await holdLane(s);
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } });
  await waitingForLane(s);
  await waitUntil(async () => (await s.calls()).filter((c) => c[0] === 'pr' && c[1] === 'view').length >= 4, 'several failed looks');
  await holder.release();
  assert.equal(await run, 0, s.lines.join('\n'));
  assert.ok(!s.lines.some((l) => l.includes('stopped checking')));
});

test('a PR merged while its steps run: the running step and what it started are stopped, the next step does not start, the lane is free, nothing is posted', { timeout: 40_000 }, async () => {
  const dir = await tempDir();
  const pidFile = join(dir, 'step.pid');
  const childFile = join(dir, 'child.pid');
  const second = join(dir, 'second-ran');
  // The step starts a child of its own and waits for it, as a build does.
  const s = await setup({ configText: RECHECK_CONFIG([`echo $$ > ${pidFile}; sleep 30 & echo $! > ${childFile}; wait`, `touch ${second}`]) });
  atTestEnd(async () => {
    // The step may not have recorded its pids yet when the test ends.
    for (let i = 0; i < 100 && (await readPid(childFile)) === null; i++) await new Promise((r) => setTimeout(r, 25));
    killQuietly(await readPid(pidFile));
    killQuietly(await readPid(childFile));
  });
  const started = Date.now();
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } });
  await waitUntil(async () => (await readPid(pidFile)) !== null && (await readPid(childFile)) !== null, 'the step runs');
  await s.setPr({ state: 'MERGED' });
  assert.equal(await run, 2, s.lines.join('\n'));
  assert.ok(Date.now() - started < 20_000, 'the step was not waited for');
  await assertGone(pidFile, 'the step is stopped');
  await assertGone(childFile, 'what the step started is stopped too');
  assert.ok(s.lines.some((l) => /stopped checking PR #7 .*PR #7 was merged/.test(l)), s.lines.join('\n'));
  assert.ok(!s.lines.some((l) => l.startsWith('✗ unit')), 'the cut-short step is not reported as a failure');
  assert.ok(!s.lines.some((l) => l.includes('background process')), 'ship\'s own looks are not the step\'s strays');
  assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'lanes')), [], 'the lane is released');
  await assert.rejects(access(second), { code: 'ENOENT' }, 'the second step never started');
  await assertNoVerdict(s);
});

test('a stopped check leaves no result for a duplicate of the same commit to reuse', { timeout: 30_000 }, async () => {
  const s = await setup({ configText: RECHECK_CONFIG() });
  const holder = await holdLane(s);
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } });
  await waitingForLane(s);
  await s.setPr({ state: 'CLOSED' });
  assert.equal(await run, 2);
  const results = (await readdir(join(s.deps.tmpRoot, 'checks'))).filter((n) => n.endsWith('.json'));
  assert.deepEqual(results, []);
  await holder.release();
});

test('the look before queueing: a PR that was merged just after the check began never gets in line', { timeout: 30_000 }, async () => {
  // The first answer starts the check; the next one, the look before queueing, finds it merged.
  const s = await setup({ configText: RECHECK_CONFIG(['touch ran-step']), ghOptions: { prSequence: [{}, { state: 'MERGED' }] } });
  assert.equal(await runCheck({ cwd: s.work, deps: { ...s.deps, ...ONLY_AT_THE_GATES } }), 2, s.lines.join('\n'));
  assert.ok(s.lines.some((l) => /stopped checking PR #7 .*PR #7 was merged/.test(l)), s.lines.join('\n'));
  assert.ok(!s.lines.some((l) => l.includes('waiting for the')), 'it never queued');
  assert.deepEqual((await s.statuses()).map((x) => [x.state, x.description.split(' · ')[0]]), [['pending', 'queued']]);
  assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'lanes')).catch(() => []), []);
});

test('the look when the lane is won: a PR merged while the check waited stops it before its first step', { timeout: 30_000 }, async () => {
  const s = await setup({ configText: RECHECK_CONFIG(['touch ran-step']) });
  const holder = await holdLane(s);
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...ONLY_AT_THE_GATES } });
  await waitingForLane(s);
  await s.setPr({ state: 'MERGED' });
  await holder.release();
  assert.equal(await run, 2, s.lines.join('\n'));
  assert.ok(s.lines.some((l) => /stopped checking PR #7 .*PR #7 was merged/.test(l)), s.lines.join('\n'));
  assert.ok(!s.lines.some((l) => /^[✓✗] unit:/.test(l)), 'no step ran');
  // queued, and not "running": the check never started
  assert.deepEqual((await s.statuses()).map((x) => x.description.split(' · ')[0]), ['queued']);
  assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'lanes')), [], 'the lane it won is free again');
});

test('a PR aimed at another branch while its check waits: stopped', { timeout: 30_000 }, async () => {
  const s = await setup({ configText: RECHECK_CONFIG() });
  const holder = await holdLane(s);
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } });
  await waitingForLane(s);
  await s.setPr({ baseRefName: 'release' });
  assert.equal(await run, 2);
  assert.ok(s.lines.some((l) => /stopped checking PR #7 .*PR #7 now targets release; only PRs into main are gated/.test(l)), s.lines.join('\n'));
  await assertNoVerdict(s);
  await holder.release();
});

test('a main that was rewritten so that it no longer contains the checked one: stopped, as ship merge would refuse', { timeout: 30_000 }, async () => {
  const s = await setup({ configText: RECHECK_CONFIG() });
  const holder = await holdLane(s);
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } });
  await waitingForLane(s);
  const first = (await git(['rev-list', '--max-parents=0', 'main'], s.work)).trim();
  await git(['push', '--quiet', '--force', s.origin, `${first}:refs/heads/main`], s.work);
  assert.equal(await run, 2);
  assert.ok(s.lines.some((l) => /stopped checking PR #7 .*main no longer contains main@[0-9a-f]{7}/.test(l)), s.lines.join('\n'));
  await assertNoVerdict(s);
  await holder.release();
});

test('a head that GitHub shows once and then takes back (it lags after a push) does not stop the check', { timeout: 30_000 }, async () => {
  // start: ours; the look before queueing: another head; its second question: ours again
  const s = await setup({ configText: RECHECK_CONFIG(), ghOptions: { prSequence: [{}, { headRefOid: 'f'.repeat(40) }, {}] } });
  assert.equal(await runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } }), 0, s.lines.join('\n'));
  assert.ok(!s.lines.some((l) => l.includes('stopped checking')));
});

test('a caller\'s own abort that lands as the lane is won gives the lane back', async () => {
  const dir = join(await tempDir(), 'lane');
  let asked = 0;
  await assert.rejects(acquireShared(dir, await ownerInfo({}), { pollMs: 10, isAborted: () => asked++ > 0 }), { aborted: true });
  assert.equal(await readOwner(dir), null, 'the lane is free');
});

test('watchDoomed keeps the first reason, calls onDoomed once and ignores a look that fails', async () => {
  const answers = [new Error('offline'), null, 'PR #7 was merged', 'PR #7 was closed'];
  let looks = 0;
  const told = [];
  const w = watchDoomed({
    intervalMs: 1_000_000,
    probe: async () => { const a = answers[looks++]; if (a instanceof Error) throw a; return a; },
    onDoomed: async (why) => { told.push(why); },
  });
  assert.equal(await w.now(), null); // the failed look says nothing
  assert.equal(await w.now(), null);
  assert.equal(await w.now(), 'PR #7 was merged');
  assert.equal(await w.now(), 'PR #7 was merged'); // the reason stays; no further look is made
  assert.equal(w.reason(), 'PR #7 was merged');
  assert.equal(looks, 3);
  assert.deepEqual(told, ['PR #7 was merged']);
  w.stop();
});

test('watchDoomed does not wait for a look that hangs', async () => {
  const w = watchDoomed({ intervalMs: 1_000_000, lookTimeoutMs: 30, probe: () => new Promise(() => {}) });
  const started = Date.now();
  assert.equal(await w.now(), null);
  assert.ok(Date.now() - started < 2000);
  w.stop();
});

test('watchDoomed does not start a second look for a caller that waited for the one under way', async () => {
  let looks = 0;
  const w = watchDoomed({ intervalMs: 1_000_000, lookTimeoutMs: 80, probe: () => { looks++; return new Promise(() => {}); } });
  const [a, b] = await Promise.all([w.now(), w.now()]);
  assert.equal(a, null);
  assert.equal(b, null);
  assert.equal(looks, 1);
  w.stop();
});

test('watchDoomed reuses a look that is recent enough', async () => {
  let looks = 0;
  const w = watchDoomed({ intervalMs: 1_000_000, probe: async () => { looks++; return null; } });
  await w.now();
  await w.now(10_000);
  assert.equal(looks, 1);
  await w.now(0);
  assert.equal(looks, 2);
  w.stop();
});

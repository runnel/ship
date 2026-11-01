import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runCheck } from '../lib/check.mjs';
import { acquire, ownerInfo, readOwner } from '../lib/lock.mjs';
import { mirrorPath } from '../lib/git.mjs';
import { watchDoomed } from '../lib/doomed.mjs';
import { setupCheck as setup, git, tempDir, commitFiles, waitUntil, readPid, assertGone } from './helpers.mjs';

// A repo that asks for a fresh check when main gains a file under db/.
const RECHECK_CONFIG = (steps = ['true'], lane = 'heavy') =>
  `export default { repo: 't/r', docsOnly: ['*.md'], recheckOnMainChange: ['db/**'], checks: [${JSON.stringify({ name: 'unit', lane, paths: ['src/**'], steps })}] };\n`;

const FAST = { doomedPollMs: 25 };

// Takes a lane the way a running check would, so that the check under test has to wait for it.
const holdLane = async (s, lane = 'heavy') => {
  const dir = join(s.deps.tmpRoot, 'lanes', lane);
  const release = await acquire(dir, await ownerInfo({ repo: 't/r', command: 'test holder' }), { pollMs: 10 });
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
  const second = join(dir, 'second-ran');
  const s = await setup({ configText: RECHECK_CONFIG([`echo $$ > ${pidFile}; sleep 30`, `touch ${second}`]) });
  const started = Date.now();
  const run = runCheck({ cwd: s.work, deps: { ...s.deps, ...FAST } });
  await waitUntil(async () => (await readPid(pidFile)) !== null, 'the step runs');
  await s.setPr({ state: 'MERGED' });
  assert.equal(await run, 2, s.lines.join('\n'));
  assert.ok(Date.now() - started < 20_000, 'the step was not waited for');
  await assertGone(pidFile, 'the step is stopped');
  assert.ok(s.lines.some((l) => /stopped checking PR #7 .*PR #7 was merged/.test(l)), s.lines.join('\n'));
  assert.ok(!s.lines.some((l) => l.startsWith('✗ unit')), 'the cut-short step is not reported as a failure');
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

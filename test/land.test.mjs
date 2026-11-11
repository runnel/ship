import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { abortedError } from '../lib/shared.mjs';
import { fakeCloud } from './fake-cloud.mjs';
import { FILES, at, configText, healthy, inProcessDeploy } from './deploy-fixture.mjs';
import { addAcks } from '../lib/state.mjs';
import { landDeps, landInSlot, reusable, runLand } from '../lib/land.mjs';
import { runCheck } from '../lib/check.mjs';
import { ensureMirror, fetchCommit, mirrorPath } from '../lib/git.mjs';
import { postStatus } from '../lib/github.mjs';
import { acquire, ownerInfo, readOwner } from '../lib/lock.mjs';
import { headLockDir, landDir, slotDir } from '../lib/land-line.mjs';
import { atTestEnd, commitFiles, fakeGh, git, hangingRemote, makeOrigin, isGone, killQuietly, readPid, setupCheck, statusesOf, stopBackground, tempDir, tracked, waitUntil } from './helpers.mjs';

afterEach(stopBackground, { timeout: 30_000 });

// Short waits and no caffeinate: a land does the same, only faster.
const FAST_LAND = { mergeReadForMs: 50, mergePollMs: 5, mergeShaWaitMs: 500, mirrorWaitMs: 2000, keepAwake: () => ({ stop() {} }) };

// A repository whose PR #7 (branch feat) can be landed: the fake gh squash-merges into the origin and
// answers status reads with what was posted. A step can run `sh <ctl>/arm.sh`, which the test writes
// once it knows the paths (`arm(script)`).
async function setupLand({ ghOptions = {}, steps, ...opts } = {}) {
  const ctl = await tempDir('ctl-');
  await writeFile(join(ctl, 'arm.sh'), '');
  const s = await setupCheck({ ...(steps ? { steps: steps(ctl) } : {}), ...opts, ghOptions: { squash: true, liveStatuses: true, ...ghOptions } });
  return {
    ...s, ctl,
    deps: { ...landDeps(), ...s.deps, stateRoot: join(s.root, 'state'), ...FAST_LAND }, // never the real ~/.ship
    arm: (script) => writeFile(join(ctl, 'arm.sh'), script),
    originMain: async () => (await git(['--git-dir', s.origin, 'rev-parse', 'refs/heads/main'], s.work)).trim(),
    merges: async () => (await s.calls()).filter((c) => c[0] === 'pr' && c[1] === 'merge'),
    runs: async () => (await readFile(join(ctl, 'runs'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length,
  };
}

// landInSlot as runLand calls it: the mirror already has the head of PR #7.
async function inSlot(s, { keepBranch = false, deps = {} } = {}) {
  const d = { ...s.deps, ...deps };
  const mirror = await ensureMirror('t/r', { root: d.mirrorRoot, url: s.origin });
  const headSha = (await git(['rev-parse', 'feat'], s.work)).trim();
  await fetchCommit(mirror, headSha, 7);
  return landInSlot({ d, repo: 't/r', info: { number: 7, headSha, headRef: 'feat', base: 'main', fork: false, state: 'OPEN' }, main: 'main', mirror, keepBranch });
}

const COUNTED = (ctl) => [`echo run >> ${ctl}/runs`, 'test -f src/x.ts'];
const ARMED = (ctl) => ['test -f src/x.ts', `sh ${ctl}/arm.sh`];

test('a green land check merges onto exactly the main it checked, kept awake while it runs', async () => {
  const s = await setupLand();
  const before = await s.originMain();
  const awake = { started: 0, stopped: 0 };
  const res = await inSlot(s, { deps: { keepAwake: () => { awake.started += 1; return { stop() { awake.stopped += 1; } }; } } });
  assert.ok(res.merged, s.lines.join('\n'));
  assert.equal(res.merged.mainSha, before);
  assert.equal(res.merged.sha, await s.originMain());
  assert.equal((await git(['--git-dir', s.origin, 'rev-parse', `${res.merged.sha}^`], s.work)).trim(), before, 'squashed right onto the checked main');
  const last = (await s.statuses()).at(-1);
  assert.equal(last.state, 'success');
  assert.match(last.description, new RegExp(`^unit · vs main@${before.slice(0, 7)} · \\d+s$`), 'exactly the ship check description');
  assert.deepEqual(awake, { started: 1, stopped: 1 });
  assert.deepEqual((await s.merges())[0].slice(-3), ['--match-head-commit', (await git(['rev-parse', 'feat'], s.work)).trim(), '--delete-branch']);
});

test('a docs-only PR merges without a check run', async () => {
  const s = await setupLand({ featFiles: { 'README.md': 'r\n' }, steps: () => ['exit 9'] });
  assert.ok((await inSlot(s)).merged, s.lines.join('\n'));
  assert.match((await s.statuses()).at(-1).description, /^docs-only · vs main@[0-9a-f]{7}$/);
});

test('apiFail still fails a status post under setupLand', async () => {
  const s = await setupLand({ ghOptions: { apiFail: { match: 'state=success' } } });
  assert.deepEqual(await inSlot(s), { code: 4 }, s.lines.join('\n'));
  assert.equal((await s.merges()).length, 0);
});

test('red gives exit 1 and a merge conflict exit 2; neither merges', async () => {
  const red = await setupLand({ steps: () => ['echo boom; exit 3'] });
  assert.deepEqual(await inSlot(red), { code: 1 });
  assert.equal((await red.merges()).length, 0);
  assert.match(red.lines.join('\n'), /✗ local-ci failure: unit: echo boom; exit 3 failed/);
  const conflict = await setupLand({ featFiles: { 'a.txt': 'feature\n' }, mainFiles: { 'a.txt': 'main\n' } });
  assert.deepEqual(await inSlot(conflict), { code: 2 });
  assert.equal((await conflict.merges()).length, 0);
  assert.match(conflict.lines.at(-1), /^✗ not landing PR #7: a merge conflict with main@[0-9a-f]{7}; merge main into the branch, push, and land again$/);
});

// A clone that adds a commit to the origin's main each time the check's armed step runs, the first
// `times` times; `checks()` says how often the step ran.
async function mover(s, times) {
  const dir = join(await tempDir('mover-'), 'w');
  await git(['clone', '--quiet', s.origin, dir], s.work);
  await git(['config', 'user.name', 't'], dir);
  await git(['config', 'user.email', 't@localhost'], dir);
  const count = join(s.ctl, 'moves');
  await s.arm([
    `n=$(cat ${count} 2>/dev/null || echo 0); echo $((n+1)) > ${count}`,
    `if [ "$n" -lt ${times} ]; then`,
    `  git -C ${dir} pull --quiet --rebase origin main && git -C ${dir} commit --quiet --allow-empty -m "main moves $n" && git -C ${dir} push --quiet origin HEAD:main`,
    'fi',
    '',
  ].join('\n'));
  return { checks: async () => Number((await readFile(count, 'utf8')).trim()) };
}

test('main moved outside the queue before the merge: checked again against it, then merged onto it', async () => {
  const s = await setupLand({ steps: ARMED });
  const m = await mover(s, 1);
  const res = await inSlot(s);
  assert.ok(res.merged, s.lines.join('\n'));
  assert.equal(await m.checks(), 2);
  assert.match(s.lines.join('\n'), /! main moved outside the queue \([0-9a-f]{7} → [0-9a-f]{7}\): checking again against it/);
  assert.equal((await git(['--git-dir', s.origin, 'rev-parse', `${res.merged.sha}^`], s.work)).trim(), res.merged.mainSha);
});

test('main that keeps moving: after two more checks the land gives up with exit 2, nothing merged', async () => {
  const s = await setupLand({ steps: ARMED });
  const m = await mover(s, 99);
  assert.deepEqual(await inSlot(s), { code: 2 });
  assert.equal(await m.checks(), 3);
  assert.equal((await s.merges()).length, 0);
  assert.match(s.lines.at(-1), /^✗ not landing PR #7: main kept moving outside the queue \(now main@[0-9a-f]{7} after 2 more checks\); land again$/);
});

test('reusable: the rule of spec §6.1, case by case', () => {
  const MAIN = `52d4c19${'0'.repeat(33)}`;
  const cached = { state: 'success', exitCode: 0, description: 'unit · vs main@52d4c19 · 4s', mainSha: MAIN };
  const status = { state: 'success', description: 'unit · vs main@52d4c19 · 4s', bot: false };
  assert.equal(reusable({ cached, status, mainSha: MAIN }), true);
  assert.equal(reusable({ cached: null, status, mainSha: MAIN }), false);
  assert.equal(reusable({ cached: { ...cached, mainSha: 'f'.repeat(40) }, status, mainSha: MAIN }), false, 'a result for another main');
  assert.equal(reusable({ cached: { ...cached, state: 'failure', exitCode: 1 }, status, mainSha: MAIN }), false);
  assert.equal(reusable({ cached, status: { ...status, description: 'unit · vs main@52d4c19 · 9s' }, mainSha: MAIN }), false, 'GitHub shows another run');
  assert.equal(reusable({ cached, status: { ...status, bot: true }, mainSha: MAIN }), false);
  assert.equal(reusable({ cached, status: null, mainSha: MAIN }), false);
});

test('a green ship check of this head against this main is reused; one GitHub no longer shows is not', async () => {
  const s = await setupLand({ steps: COUNTED });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0, s.lines.join('\n'));
  assert.ok((await inSlot(s)).merged, s.lines.join('\n'));
  assert.equal(await s.runs(), 1);
  assert.ok(s.lines.some((l) => /^✓ local-ci success: unit · vs main@[0-9a-f]{7} · \d+s \(reused: this head was checked against this main\)$/.test(l)), s.lines.join('\n'));

  const t = await setupLand({ steps: COUNTED });
  assert.equal(await runCheck({ cwd: t.work, deps: t.deps }), 0);
  await postStatus({ repo: 't/r', sha: (await git(['rev-parse', 'feat'], t.work)).trim(), state: 'pending', description: 'queued · vs main@1234567', gh: t.gh });
  assert.ok((await inSlot(t)).merged, t.lines.join('\n'));
  assert.equal(await t.runs(), 2);
});

test('gh pr merge: no answer with the PR open gives 4; the PR unreadable after a failure gives 5; failing after it landed, merged', async () => {
  const hung = await setupLand({ ghOptions: { mergeDelayMs: 3000 } });
  assert.deepEqual(await inSlot(hung, { deps: { mergeTimeoutMs: 200 } }), { code: 4 });
  assert.equal(hung.lines.at(-1), '✗ PR #7 not merged: gh pr merge gave no answer within 0.2s and the PR is still open; landing again is safe');

  const dark = await setupLand({ ghOptions: { squash: false, mergeFail: 'connection reset', afterMerge: { fail: true } } });
  assert.deepEqual(await inSlot(dark), { code: 5 });
  assert.equal(dark.lines.at(-1), '✗ PR #7: the merge outcome is unknown: gh pr merge failed (connection reset) and the PR could not be read — check gh pr view 7');

  const late = await setupLand({ ghOptions: { mergeFail: 'failed to delete remote branch: HTTP 422' } });
  assert.ok((await inSlot(late)).merged, late.lines.join('\n'));
  assert.ok(late.lines.includes('! gh reported failed to delete remote branch: HTTP 422, but PR #7 is merged'), late.lines.join('\n'));
});

test('a time limit hit while holding the slot gives exit 4: a PR read that hangs, a fetch that hangs', { timeout: 60_000 }, async () => {
  const read = await setupLand({ steps: ARMED });
  await read.arm(`printf '{"hangMs":30000}' > ${join(read.root, 'pr-live.json')}\n`);
  assert.deepEqual(await inSlot(read, { deps: { ghTimeoutMs: 5000 } }), { code: 4 });
  assert.equal(read.lines.at(-1), '✗ PR #7 not merged: gh pr view gave no answer within 5 s; landing again is safe');
  assert.equal((await read.merges()).length, 0);

  const fetch = await setupLand({ steps: ARMED });
  const hang = await hangingRemote();
  await fetch.arm(`git --git-dir ${mirrorPath('t/r', fetch.deps.mirrorRoot)} remote set-url origin ${hang.url}\n`);
  try {
    assert.deepEqual(await inSlot(fetch, { deps: { fetchTimeoutMs: 2000 } }), { code: 4 });
  } finally {
    await hang.restore();
  }
  assert.equal(fetch.lines.at(-1), '✗ PR #7 not merged: git fetch of t/r took longer than 2 s; landing again is safe');

  // a merge lock that another process keeps: the land does not wait for ever behind it
  const locked = await setupLand();
  const other = atTestEnd(await acquire(join(locked.deps.tmpRoot, 'locks', 'merge-t__r'), await ownerInfo({ repo: 't/r', pr: 3, command: 'merge' })));
  assert.deepEqual(await inSlot(locked, { deps: { lockWaitMs: 300 } }), { code: 4 });
  assert.equal(locked.lines.at(-1), '✗ PR #7 not merged: the merge lock of t/r was held by another process for longer than 0.3 s; landing again is safe');
  assert.equal((await locked.merges()).length, 0);
  await other();
});

test('the land keeps its own limits: every wait on GitHub and on git is bounded', () => {
  const d = landDeps();
  for (const k of ['ghTimeoutMs', 'fetchTimeoutMs', 'mergeTimeoutMs', 'mergeReadForMs', 'mergeShaWaitMs', 'mirrorWaitMs', 'lockWaitMs']) {
    assert.ok(d[k] > 0, k);
  }
});

test('reusable: a success whose description GitHub cut at 140 characters is still the same run', () => {
  const MAIN = `52d4c19${'0'.repeat(33)}`;
  const description = `unit · vs main@52d4c19 · 4s · ${'lockfile changed · '.repeat(12)}`;
  assert.ok(description.length > 140);
  const cached = { state: 'success', exitCode: 0, description, mainSha: MAIN };
  const stored = `${description.slice(0, 139)}…`;
  assert.equal(reusable({ cached, status: { state: 'success', description: stored, bot: false }, mainSha: MAIN }), true);
  assert.equal(reusable({ cached, status: { state: 'success', description: `${stored.slice(0, 60)}x${stored.slice(61)}`, bot: false }, mainSha: MAIN }), false, 'a different run still is not');
});

test('a PR that gh could not merge, shown merged at another head, is not this land\'s merge', async () => {
  const s = await setupLand({ ghOptions: { squash: false, mergeFail: 'HTTP 502', afterMerge: { state: 'MERGED', headRefOid: 'e'.repeat(40), mergeCommit: { oid: 'f'.repeat(40) } } } });
  const res = await inSlot(s);
  assert.deepEqual(res, { code: 2 }, s.lines.join('\n'));
  assert.match(s.lines.at(-1), /^✗ not landing PR #7 @ [0-9a-f]{7}: it was merged by someone else at eeeeeee$/);
});

test('the status is read at the head the merge is pinned to', async () => {
  const s = await setupLand();
  const head = (await git(['rev-parse', 'feat'], s.work)).trim();
  assert.ok((await inSlot(s)).merged, s.lines.join('\n'));
  const reads = (await s.calls()).filter((c) => c[0] === 'api' && /\/commits\/[0-9a-f]+\/statuses/.test(c[1]));
  assert.ok(reads.length > 0);
  assert.ok(reads.every((c) => c[1].includes(`/commits/${head}/statuses`)), JSON.stringify(reads));
  assert.deepEqual((await s.merges())[0].slice(-3), ['--match-head-commit', head, '--delete-branch']);
});

// runLand in this process, with the land deps of a setup.
const land = tracked((s, { pr = '7', deps = {}, keepBranch = false } = {}) => runLand({ cwd: s.work, pr, keepBranch, deps: { ...s.deps, ...deps } }));
// Holds the land slot of t/r as another land would, so that the land under test waits in line.
const holdSlot = async (s) => atTestEnd(await acquire(slotDir(s.deps, 't/r'), await ownerInfo({ repo: 't/r', pr: 99, headSha: 'f'.repeat(40), land: true })));
const tickets = async (s) => (await readdir(landDir(s.deps, 't/r')).catch(() => [])).filter((n) => n.startsWith('slot.q-') && n.endsWith('.json'));
const headOf = async (s, branch = 'feat') => (await git(['rev-parse', branch], s.work)).trim();

test('refused without a status: a fork, a PR that is not open, one into another branch, a detached HEAD', async () => {
  for (const [prOverrides, text] of [
    [{ isCrossRepository: true }, /^✗ not landing: PR #7 comes from a fork/],
    [{ state: 'MERGED' }, /^✗ not landing: PR #7 is merged$/],
    [{ baseRefName: 'release' }, /^✗ not landing: PR #7 targets release; only PRs into main are landed$/],
  ]) {
    const s = await setupLand({ prOverrides });
    assert.equal(await land(s), 2);
    assert.match(s.lines.at(-1), text);
    assert.deepEqual(await s.statuses(), []);
  }
  const s = await setupLand();
  await git(['checkout', '--quiet', '--detach'], s.work);
  assert.equal(await runLand({ cwd: s.work, deps: s.deps }), 2);
  assert.match(s.lines.at(-1), /detached HEAD — run: ship land --pr <number>/);
});

test('the same PR and head landing twice: refused; a new head joins the line and the old land leaves at its probe', { timeout: 60_000 }, async () => {
  const s = await setupLand();
  const release = await holdSlot(s);
  const first = land(s, { deps: { doomedPollMs: 25, doomedConfirmMs: 5 } });
  await waitUntil(async () => (await tickets(s)).length === 1, 'the first land is in line');
  assert.equal(await land(s), 2);
  assert.match(s.lines.join('\n'), /✗ not landing: PR #7 @ [0-9a-f]{7} is already landing \(pid \d+\)/);
  const newHead = await commitFiles(s.work, { 'src/y.ts': 'y\n' }, 'second commit');
  await git(['push', '--quiet', s.origin, 'feat'], s.work);
  await s.setPr({ headRefOid: newHead });
  const second = land(s);
  assert.equal(await first, 2);
  assert.match(s.lines.join('\n'), /✗ not landing PR #7 @ [0-9a-f]{7}: the head of PR #7 moved to [0-9a-f]{7}; run ship land --pr 7 for it/);
  await waitUntil(async () => (await tickets(s)).length === 1, 'the new head waits in line on its own');
  await release();
  assert.equal(await second, 0, s.lines.join('\n'));
  assert.equal((await s.merges()).at(-1)[7], newHead);
});

test('the head probe of a waiting land has the gh time limit: no gh child outlives the land', { timeout: 60_000 }, async () => {
  const s = await setupLand();
  const pidsFile = join(s.root, 'gh-hung.pids');
  const pidsOf = async () => (await readFile(pidsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number);
  atTestEnd(() => { for (const pid of pidsOf.last ?? []) killQuietly(pid); });
  const release = await holdSlot(s);
  // The limit also applies to the land's own startup `gh` calls, so it must be far above what a loaded
  // machine needs to start the fake gh (1000 ms made the land fail at startup, never wait, and the wait
  // below time out); the hang is longer still, so only the limit ends a hung read.
  const landing = land(s, { deps: { doomedPollMs: 50, doomedConfirmMs: 5, ghTimeoutMs: 3000 } });
  await waitUntil(async () => (await tickets(s)).length === 1, 'the land waits in line');
  await writeFile(join(s.root, 'pr-live.json'), '{"hangMs":40000}');
  await waitUntil(async () => (await pidsOf()).length > 0, 'a probe read hangs');
  await waitUntil(async () => (await pidsOf()).length > 1, 'the hung probe read was given up, the next one started');
  await writeFile(join(s.root, 'pr-live.json'), '{}');
  // A read that hangs when the land ends is only ended by the limit (the land does not wait for it), so
  // let the one in flight run into it before the land is released.
  await new Promise((resolve) => setTimeout(resolve, 3500));
  await release();
  assert.equal(await landing, 0, s.lines.join('\n'));
  const pids = await pidsOf();
  pidsOf.last = pids;
  for (const pid of pids) assert.equal(await isGone(pid), true, `the hung gh child ${pid} is gone`);
});

test('an optional ship check of the same head: the land waits for it outside the line, then reuses its green', { timeout: 60_000 }, async () => {
  const s = await setupLand({ steps: (ctl) => [`echo run >> ${ctl}/runs; for i in $(seq 1 600); do test -f ${ctl}/go && exit 0; sleep 0.05; done; exit 1`, 'test -f src/x.ts'] });
  const check = tracked(runCheck)({ cwd: s.work, deps: s.deps });
  await waitUntil(async () => (await s.runs()) === 1, 'the optional check runs its step');
  const landing = land(s);
  await waitUntil(() => s.lines.some((l) => l.includes('an optional ship check of')), 'the land waits for it');
  assert.deepEqual(await tickets(s), [], 'no place in line while it waits');
  await writeFile(join(s.ctl, 'go'), '');
  assert.equal(await check, 0);
  assert.equal(await landing, 0, s.lines.join('\n'));
  assert.equal(await s.runs(), 1, 'checked once');
  assert.equal((await s.merges()).length, 1);
});

test('lands go in arrival order, a dead waiter is skipped, and the next check runs on the main the first one made', { timeout: 90_000 }, async () => {
  const s = await setupLand();
  // PR #8 adds src/z.ts on a branch from main: its check passes only if it sees PR #7's src/x.ts on main.
  await git(['checkout', '--quiet', '-b', 'feat2', 'main'], s.work);
  const head8 = await commitFiles(s.work, { 'src/z.ts': 'z\n' }, 'feat2');
  await git(['push', '--quiet', s.origin, 'feat2'], s.work);
  await git(['checkout', '--quiet', 'feat'], s.work);
  const gh8 = await fakeGh(await tempDir(), { pr: { number: 8, headRefOid: head8, headRefName: 'feat2', baseRefName: 'main', isCrossRepository: false, state: 'OPEN' }, origin: s.origin, squash: true, liveStatuses: true });
  const release = await holdSlot(s);
  const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await once(dead, 'close');
  await writeFile(join(landDir(s.deps, 't/r'), `slot.q-01-${String(Date.now() - 60_000).padStart(15, '0')}-000000-dead.json`),
    JSON.stringify({ pid: dead.pid, startTime: null, nonce: 'dead', repo: 't/r', pr: 5, headSha: 'e'.repeat(40), land: true }));
  const live = async () => (await tickets(s)).filter((n) => !n.endsWith('-dead.json'));
  const seven = land(s);
  await waitUntil(async () => (await live()).length === 1, 'PR #7 is in line');
  const eight = land(s, { pr: '8', deps: { gh: gh8.gh } });
  await waitUntil(async () => (await live()).length === 2, 'PR #8 is in line behind it');
  await release();
  assert.equal(await seven, 0, s.lines.join('\n'));
  assert.equal(await eight, 0, s.lines.join('\n'));
  const subjects = (await git(['--git-dir', s.origin, 'log', '--first-parent', '--format=%s', '-2', 'main'], s.work)).trim().split('\n');
  assert.deepEqual(subjects, ['feat2 (#8)', 'feat (#7)']);
  const merged7 = (await git(['--git-dir', s.origin, 'rev-parse', 'main~1'], s.work)).trim();
  assert.match(statusesOf(await gh8.calls()).at(-1).description, new RegExp(`vs main@${merged7.slice(0, 7)}`), 'PR #8 was checked against the main PR #7 made');
  assert.deepEqual(await tickets(s), [], 'the dead waiter\'s ticket is gone too');
  assert.equal(await readOwner(slotDir(s.deps, 't/r')), null);
});

test('red frees the slot and the head lock; so does a time limit hit in the slot (exit 4)', { timeout: 60_000 }, async () => {
  const red = await setupLand({ steps: () => ['exit 3'] });
  assert.equal(await land(red), 1);
  assert.equal(await readOwner(slotDir(red.deps, 't/r')), null);
  assert.equal(await readOwner(headLockDir(red.deps, 't/r', await headOf(red))), null);
  const hung = await setupLand({ steps: ARMED });
  await hung.arm(`printf '{"hangMs":5000}' > ${join(hung.root, 'pr-live.json')}\n`);
  assert.equal(await land(hung, { deps: { ghTimeoutMs: 300 } }), 4);
  assert.equal(await readOwner(slotDir(hung.deps, 't/r')), null);
  assert.equal(await readOwner(headLockDir(hung.deps, 't/r', await headOf(hung))), null);
});

// runLand in a child process that leads its own process group, as bin/ship.mjs makes ship do.
// `out.text` is what it prints; `exited` resolves with its exit code; the test's end kills the group.
function spawnLand(s, { pollMs = 10 } = {}) {
  const script = `
import { runLand } from ${JSON.stringify(new URL('../lib/land.mjs', import.meta.url).href)};
import { isInterrupted } from ${JSON.stringify(new URL('../lib/interrupt.mjs', import.meta.url).href)};
const a = JSON.parse(process.argv[1]);
const deps = { gh: a.gh, remoteUrl: () => a.origin, mirrorRoot: a.mirrorRoot, tmpRoot: a.tmpRoot, logRoot: a.logRoot, stateRoot: a.stateRoot, pollMs: a.pollMs ?? 10,
  keepAwake: () => ({ stop() {} }), out: (l) => process.stdout.write(l + '\\n') };
let code;
try { code = await runLand({ cwd: a.cwd, pr: '7', deps }); } catch (e) { code = e?.aborted || isInterrupted() ? 130 : 1; }
process.exitCode = code;
`;
  const args = JSON.stringify({ gh: s.gh, origin: s.origin, cwd: s.work, mirrorRoot: s.deps.mirrorRoot, tmpRoot: s.deps.tmpRoot, logRoot: s.deps.logRoot, stateRoot: s.deps.stateRoot, pollMs });
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, args], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  atTestEnd(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  const out = { text: '' };
  child.stdout.on('data', (b) => { out.text += b; });
  return { child, out, exited: new Promise((resolve) => child.on('close', (code) => resolve(code))) };
}

test('an interrupt while only queued leaves the line and posts no status', { timeout: 60_000 }, async () => {
  const s = await setupLand();
  const release = await holdSlot(s);
  // A poll longer than the test: the land's main flow cannot see the interrupt before the process exits.
  const l = spawnLand(s, { pollMs: 20_000 });
  await waitUntil(() => l.out.text.includes('waiting in the land line'), 'the land waits in line');
  process.kill(-l.child.pid, 'SIGINT');
  assert.equal(await l.exited, 130);
  assert.deepEqual((await ledger(s)).map((e) => [e.pr, e.code]), [[7, 130]], 'the interrupt unwind writes the ledger line');
  assert.deepEqual(statusesOf(await s.calls()), [], 'no status: an optional green on the head stays');
  assert.deepEqual(await tickets(s), []);
  assert.equal(await readOwner(headLockDir(s.deps, 't/r', await headOf(s))), null);
  assert.equal((await readOwner(slotDir(s.deps, 't/r'))).pr, 99, 'the holder is untouched');
  await release();
});

test('an interrupt during the land check posts error, frees the slot and the head lock, merges nothing (130)', { timeout: 60_000 }, async () => {
  const s = await setupLand({ steps: (ctl) => [`touch ${ctl}/started; for i in $(seq 1 600); do sleep 0.05; done`] });
  const l = spawnLand(s);
  await waitUntil(async () => (await readFile(join(s.ctl, 'started'), 'utf8').then(() => true, () => false)), 'the check step runs');
  process.kill(-l.child.pid, 'SIGINT');
  assert.equal(await l.exited, 130);
  assert.doesNotMatch(l.out.text, /not merged|landing again is safe/, 'an interrupt is not reported as a failure');
  const last = (await s.statuses()).at(-1);
  assert.equal(last.state, 'error');
  assert.match(last.description, /^ship interrupted · vs main@[0-9a-f]{7}$/);
  assert.equal(await readOwner(slotDir(s.deps, 't/r')), null);
  assert.equal(await readOwner(headLockDir(s.deps, 't/r', await headOf(s))), null);
  assert.equal((await s.merges()).length, 0);
  assert.equal((await ledger(s)).at(-1).code, 130, 'an interrupted land is in the ledger too');
});

const ledger = async (s, file = 't__r.jsonl') => (await readFile(join(s.deps.stateRoot, 'land', file), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

test('a PR with nothing to deploy is done at the merge, and every land leaves one ledger line, refused ones too', async () => {
  const s = await setupLand();
  assert.equal(await land(s), 0, s.lines.join('\n'));
  assert.match(s.lines.at(-1), /^✓ PR #7 landed as [0-9a-f]{7}: it touches no deployable and adds no migration, so it is done at the merge$/);
  const [entry] = await ledger(s);
  assert.deepEqual([entry.pr, entry.head, entry.code], [7, await headOf(s), 0]);
  for (const k of ['joinedAt', 'slotAt', 'mergedAt', 'endedAt']) assert.ok(!Number.isNaN(Date.parse(entry[k])), k);
  assert.equal(await land(s), 2, 'the PR is merged now: refused');
  const lines = await ledger(s);
  assert.equal(lines.length, 2, 'appended, not replaced');
  assert.deepEqual([lines[1].pr, lines[1].code, lines[1].joinedAt], [7, 2, null]);
  // a branch ref goes in its own field, and a detached HEAD is a land too
  const b = await setupLand();
  assert.equal(await runLand({ cwd: b.work, deps: b.deps }), 0, b.lines.join('\n'));
  assert.deepEqual([(await ledger(b))[0].pr, (await ledger(b))[0].branch], [7, 'feat']);
  await git(['checkout', '--quiet', '--detach'], b.work);
  assert.equal(await runLand({ cwd: b.work, deps: b.deps }), 2);
  assert.equal((await ledger(b)).at(-1).code, 2);
});

test('a ledger that cannot be written is said once, and the land still ends as it would', async () => {
  const s = await setupLand();
  await writeFile(join(s.deps.stateRoot, 'land'), 'in the way').catch(async () => { await mkdir(s.deps.stateRoot, { recursive: true }); await writeFile(join(s.deps.stateRoot, 'land'), 'in the way'); });
  assert.equal(await land(s), 0, s.lines.join('\n'));
  assert.equal(s.lines.filter((l) => l.startsWith('! could not write the land ledger: ')).length, 1);
  assert.match(s.lines.at(-1), /^✓ PR #7 landed as [0-9a-f]{7}/, 'the last line names the PR and the merge commit');
});

test('an error before the PR is read is exit 4, not 1, and leaves a ledger line: not a clone with a GitHub origin', async () => {
  const s = await setupLand();
  const nowhere = await tempDir('nowhere-');
  assert.equal(await runLand({ cwd: nowhere, pr: '7', deps: s.deps }), 4);
  assert.match(s.lines.at(-1), /^✗ PR 7 not merged: .*; landing again is safe$/);
  const [entry] = await ledger(s, 'unknown.jsonl');
  assert.deepEqual([entry.pr, entry.head, entry.code], [7, null, 4]);
  assert.equal(await runLand({ cwd: nowhere, deps: s.deps }), 4, 'no --pr either');
  assert.match(s.lines.at(-1), /^✗ not landed: /);
});

test('a land of another PR with the same head on the head lock is waited for, not refused as a duplicate', { timeout: 30_000 }, async () => {
  const s = await setupLand();
  const release = await acquire(headLockDir(s.deps, 't/r', await headOf(s)), await ownerInfo({ repo: 't/r', pr: 99, headSha: 'f'.repeat(40), land: true }));
  const head7 = (await headOf(s)).slice(0, 7);
  let done = false;
  const landing = land(s).then((c) => { done = true; return c; });
  await waitUntil(() => s.lines.some((l) => l === `… a land of PR #99 holds the head lock of ${'' + head7} — waiting for it`), 'the land says whom it waits for');
  assert.ok(!s.lines.some((l) => l.includes('optional ship check')), 'it is not an optional check');
  assert.equal(done, false, s.lines.join('\n'));
  await release();
  assert.equal(await landing, 0, s.lines.join('\n'));
});

test('after the merge: no merge commit named, or one the mirror never shows, is exit 3 and does not hold the slot for the mirror wait', async () => {
  const unnamed = await setupLand({ ghOptions: { afterMerge: { mergeCommit: null } } });
  const started = Date.now();
  assert.equal(await land(unnamed, { deps: { mergeShaWaitMs: 100, mergePollMs: 5, mirrorWaitMs: 30_000 } }), 3);
  assert.ok(Date.now() - started < 15_000, 'no mirror wait without a SHA');
  assert.match(unnamed.lines.at(-1), /^✗ PR #7 merged, but GitHub has not named the merge commit after 0\.1 s: ship land cannot tell when it is live — ship status$/);
  assert.equal(await readOwner(slotDir(unnamed.deps, 't/r')), null);
  const unseen = await setupLand({ ghOptions: { afterMerge: { mergeCommit: { oid: 'f'.repeat(40) } } } });
  assert.equal(await land(unseen, { deps: { mirrorWaitMs: 100, mergePollMs: 5 } }), 3);
  assert.match(unseen.lines.at(-1), /^✗ PR #7 merged as fffffff, but the mirror does not show it on main after 0\.1 s: ship land cannot tell when it is live — ship status$/);
  assert.equal((await ledger(unseen)).at(-1).code, 3);
});

test('an error after the merge is exit 3: "merged, but ship failed after the merge"', async () => {
  const s = await setupLand();
  let thrown = false;
  const out = (l) => { s.lines.push(l); if (!thrown && l.startsWith('✓ PR #7 landed')) { thrown = true; throw new Error('boom'); } };
  assert.equal(await land(s, { deps: { out } }), 3);
  assert.equal(s.lines.at(-1), '✗ PR #7 merged, but ship failed after the merge (boom) — ship status');
});

// PR #7 changes app (a deployable); the fake cloud has app and tick live at the first commit, and time
// moves only when the land sleeps. `requires` is a JS array literal for the config; `extra(cloudDir)`
// may add workers and repositories.
async function setupLandLive({ requires = '[]', workers = {}, remote = null, headConfig = null } = {}) {
  const cloudDir = join(await tempDir('cloud-'), 'cloud');
  const text = configText(join(cloudDir, 'bin', 'wrangler'), { requires, ...(headConfig ? { guard: 'true' } : {}) });
  const s = await setupLand({ configText: text, baseFiles: FILES, featFiles: { 'app/src/a.ts': 'export const a = 2;\n', ...(headConfig ? { 'ship.config.mjs': headConfig(text) } : {}) } });
  const first = (await git(['--git-dir', s.origin, 'rev-list', '--max-parents=0', 'main'], s.work)).trim();
  const cloud = await fakeCloud({ dir: cloudDir, workers: { 'example-app': at(first), 'example-tick': at(first), ...workers }, probe: healthy,
    hosts: { 'https://app.example.com': 'example-app', 'https://tick.example.com': 'example-tick' } });
  const stateRoot = join(s.root, 'state');
  await addAcks(stateRoot, 't/r', ['db/001.sql']);
  const clock = { t: Date.now() };
  const starts = [];
  const deps = {
    stateRoot, fetch: cloud.fetch, readCredentials: async () => ({ CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' }),
    probeWindowMs: 0, probeIntervalMs: 1000, now: () => clock.t, sleep: async (ms) => { clock.t += ms; },
    startDeploy: inProcessDeploy(starts), ...(remote ? { remoteUrl: remote(s.origin) } : {}),
  };
  return { s, cloud, deps, starts, clock };
}

test('ship land end to end: checked, merged, deployed detached once the line is quiet, and live', { timeout: 90_000 }, async () => {
  const { s, cloud, deps, starts } = await setupLandLive();
  assert.equal(await land(s, { deps }), 0, s.lines.join('\n'));
  assert.equal(starts.length, 1);
  const merged = await s.originMain();
  assert.equal(s.lines.at(-1), `✓ PR #7 is live (merged as ${merged.slice(0, 7)}): app at ${merged.slice(0, 7)}`);
  assert.match((await cloud.state('example-app')).deployments.at(-1).annotations['workers/message'], new RegExp(`^sha:${merged} `));
});

test('an interrupt while waiting for live: the land ends 130 and leaves its ledger line, the deploy is not started', { timeout: 90_000 }, async () => {
  const { s, deps, starts } = await setupLandLive();
  // Only the wait for live sleeps this long: the interrupt cannot come from anywhere earlier.
  const sleep = async (ms) => { if (ms === 30_000) throw abortedError(); return deps.sleep(ms); };
  await assert.rejects(land(s, { deps: { ...deps, sleep } }), (e) => e.aborted === true);
  assert.ok(s.lines.some((l) => /^▸ PR #7 merged as [0-9a-f]{7}; waiting until it is live \(app\)$/.test(l)), s.lines.join('\n'));
  assert.deepEqual(starts, []);
  assert.equal((await ledger(s)).at(-1).code, 130);
});

async function apiOrigin() {
  const other = await makeOrigin({ 'ship.config.mjs': `export default { repo: 't/api', checks: [{ name: 'u', paths: ['**'], steps: ['true'] }],
    deployables: [{ name: 'app', worker: 'example-api', cwd: '.', paths: ['src/**'], mode: 'direct' }],
    credentials: { file: '/unused', map: { CLOUDFLARE_API_TOKEN: 'T', CLOUDFLARE_ACCOUNT_ID: 'A' } } };\n`, 'src/x.ts': '1', 'wrangler.json': '{"name":"example-api"}' });
  return { other, apiMain: (await git(['rev-parse', 'HEAD'], other.work)).trim() };
}
const REQUIRES_API = "[{ repo: 't/api', deployable: 'app' }]";

test('the floors are read before the merge and recorded under the merge commit before the land waits', { timeout: 90_000 }, async () => {
  const { other, apiMain } = await apiOrigin();
  const { s, deps } = await setupLandLive({ requires: REQUIRES_API, workers: { 'example-api': at(apiMain) }, remote: (origin) => (repo) => (repo === 't/api' ? other.origin : origin) });
  let atWait = null;
  const out = (l) => {
    s.lines.push(l);
    if (/^▸ PR #7 merged as/.test(l)) atWait = readdirSync(join(landDir({ tmpRoot: s.deps.tmpRoot }, 't/r'), 'floors'));
  };
  assert.equal(await land(s, { deps: { ...deps, out } }), 0, s.lines.join('\n'));
  const merged = await s.originMain();
  assert.deepEqual(atWait, [`${merged}.json`], 'the record existed when afterMerge started');
  const rec = JSON.parse(await readFile(join(landDir({ tmpRoot: s.deps.tmpRoot }, 't/r'), 'floors', `${merged}.json`), 'utf8'));
  assert.deepEqual(rec.floors, { 't/api': apiMain });
});

test('floors that cannot be read are an error before the merge: exit 4, nothing merged', { timeout: 90_000 }, async () => {
  const { other, apiMain } = await apiOrigin();
  let broken = false;
  const { s, deps } = await setupLandLive({ requires: REQUIRES_API, workers: { 'example-api': at(apiMain) },
    remote: (origin) => (repo) => { if (repo === 't/api') { if (broken) throw new Error('unreachable'); return other.origin; } return origin; } });
  const before = await s.originMain();
  broken = true;
  assert.equal(await land(s, { deps }), 4, s.lines.join('\n'));
  assert.match(s.lines.at(-1), /^✗ PR #7 not merged: could not read the floors of the requirements \(.+\); landing again is safe$/);
  assert.equal((await s.merges()).length, 0);
  assert.equal(await s.originMain(), before);
});

test('a head whose config does not load on its own still lands: main\'s requirements are the floors', { timeout: 90_000 }, async () => {
  const { other, apiMain } = await apiOrigin();
  // Loads in the merged tree (which has b.txt, from main) but not at the head alone.
  const needsMain = (text) => `${text.replace('export default {', 'const cfg = {')}
export default async ({ root }) => {
  const { readFileSync } = await import('node:fs');
  readFileSync(root + '/b.txt');
  return cfg;
};\n`;
  const { s, deps } = await setupLandLive({ requires: REQUIRES_API, workers: { 'example-api': at(apiMain) }, headConfig: needsMain,
    remote: (origin) => (repo) => (repo === 't/api' ? other.origin : origin) });
  assert.equal(await land(s, { deps }), 0, s.lines.join('\n'));
  const merged = await s.originMain();
  const rec = JSON.parse(await readFile(join(landDir({ tmpRoot: s.deps.tmpRoot }, 't/r'), 'floors', `${merged}.json`), 'utf8'));
  assert.deepEqual(rec.floors, { 't/api': apiMain });
});

test('the floor record is written as soon as the merge commit is known, before the wait for the mirror', { timeout: 90_000 }, async () => {
  const { other, apiMain } = await apiOrigin();
  let s;
  let before = null;
  let atFirstLook = null;
  const dir = () => join(landDir({ tmpRoot: s.deps.tmpRoot }, 't/r'), 'floors');
  const mainNow = () => execFileSync('git', ['--git-dir', s.origin, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim();
  // seeMerge's first act is to read the mirror; the first read after main moved shows what exists by then.
  const remote = (origin) => (repo) => {
    if (repo === 't/api') return other.origin;
    if (s && before && atFirstLook === null && mainNow() !== before) atFirstLook = existsSync(dir()) ? readdirSync(dir()) : [];
    return origin;
  };
  const set = await setupLandLive({ requires: REQUIRES_API, workers: { 'example-api': at(apiMain) }, remote });
  s = set.s;
  before = mainNow();
  assert.equal(await land(s, { deps: set.deps }), 0, s.lines.join('\n'));
  assert.deepEqual(atFirstLook, [`${await s.originMain()}.json`]);
});

test('two lands started at the same moment: the one that meets the other on the head lock refuses as a duplicate (exit 2)', async () => {
  const s = await setupLand();
  const head = await headOf(s);
  // A land for this PR that took the head lock after the other's check-then-act (its owner names another head, so alreadyLanding does not see it).
  const release = atTestEnd(await acquire(headLockDir(s.deps, 't/r', head), await ownerInfo({ repo: 't/r', pr: 7, headSha: 'f'.repeat(40), land: true })));
  assert.equal(await land(s), 2, s.lines.join('\n'));
  assert.match(s.lines.at(-1), /^✗ not landing PR #7 @ [0-9a-f]{7}: PR #7 @ [0-9a-f]{7} is already landing \(pid \d+\)$/);
  assert.deepEqual(await tickets(s), []);
  assert.deepEqual(statusesOf(await s.calls()), []);
  assert.equal((await readOwner(headLockDir(s.deps, 't/r', head))).pr, 7, 'the holder is untouched');
  await release();
});

test('a PR retargeted while it was checked is not merged: exit 2, nothing squashed onto an unchecked base', async () => {
  const s = await setupLand({ steps: ARMED });
  await s.arm(`printf '{"baseRefName":"release"}' > ${join(s.root, 'pr-live.json')}\n`);
  assert.deepEqual(await inSlot(s), { code: 2 }, s.lines.join('\n'));
  assert.equal((await s.merges()).length, 0);
  assert.equal(s.lines.at(-1), '✗ not landing PR #7: it now targets release; only PRs into main are landed');
});

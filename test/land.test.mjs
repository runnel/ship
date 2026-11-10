import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { landDeps, landInSlot, reusable } from '../lib/land.mjs';
import { runCheck } from '../lib/check.mjs';
import { ensureMirror, fetchCommit, mirrorPath } from '../lib/git.mjs';
import { postStatus } from '../lib/github.mjs';
import { acquire, ownerInfo } from '../lib/lock.mjs';
import { atTestEnd, git, hangingRemote, setupCheck, stopBackground, tempDir } from './helpers.mjs';

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

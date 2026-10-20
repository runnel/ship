import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChecked, judgeStatus, staleFiles, staleReason, runMerge } from '../lib/merge.mjs';
import { setupCheck as setup, git, tempDir, commitFiles, fakeGh } from './helpers.mjs';

const HEAD = 'a'.repeat(40);

test('the checked main is read from the description of every success ship writes', () => {
  assert.deepEqual(parseChecked('app · vs main@52d4c19 · 4m19s'), { docsOnly: false, branch: 'main', sha: '52d4c19' });
  assert.deepEqual(parseChecked('app,workers · vs main@52d4c19 · 4m19s · lockfile changed'), { docsOnly: false, branch: 'main', sha: '52d4c19' });
  assert.deepEqual(parseChecked('unit · vs release@' + 'ab12cd3'.repeat(5) + 'ab12c · 9s'), { docsOnly: false, branch: 'release', sha: 'ab12cd3'.repeat(5) + 'ab12c' });
  assert.deepEqual(parseChecked('docs-only · vs main@52d4c19'), { docsOnly: true, branch: 'main', sha: '52d4c19' });
  // a check group that happens to be called docs-only still ran its steps
  assert.equal(parseChecked('docs-only · vs main@52d4c19 · 3s').docsOnly, false);
});

test('a description without a main commit is not read', () => {
  for (const d of ['', undefined, 'queued', 'unit · vs main@abc12 · 4s', 'unit · vs main@xyz1234 · 4s', 'merge conflict with main@52d4c19']) {
    assert.equal(parseChecked(d), null, String(d));
  }
});

test('only a success on the head, naming its main, allows a merge', () => {
  const ok = judgeStatus({ state: 'success', description: 'app · vs main@52d4c19 · 4s' }, { pr: 7, headSha: HEAD });
  assert.deepEqual(ok, { ok: true, docsOnly: false, branch: 'main', sha: '52d4c19' });
  assert.match(judgeStatus(null, { pr: 7, headSha: HEAD }).reason, /^no local-ci status on aaaaaaa; run ship check --pr 7$/);
  for (const state of ['pending', 'failure', 'error']) {
    const r = judgeStatus({ state, description: 'unit: npm test failed · vs main@52d4c19' }, { pr: 7, headSha: HEAD });
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(`^local-ci is ${state} on aaaaaaa \\(unit: npm test failed`));
  }
  const odd = judgeStatus({ state: 'success', description: 'done' }, { pr: 7, headSha: HEAD });
  assert.equal(odd.ok, false);
  assert.match(odd.reason, /cannot tell which main local-ci checked \("done"\); run ship check --pr 7 again$/);
});

test('stale files are the ones main gained that match recheckOnMainChange', () => {
  const changed = ['db/001_a.sql', 'db/seed.txt', 'src/x.ts', 'db/sub/002_b.sql'];
  assert.deepEqual(staleFiles({ changed, recheck: ['db/*.sql'] }), ['db/001_a.sql']);
  assert.deepEqual(staleFiles({ changed, recheck: ['db/**'] }), ['db/001_a.sql', 'db/seed.txt', 'db/sub/002_b.sql']);
  assert.deepEqual(staleFiles({ changed, recheck: [] }), []);
  assert.deepEqual(staleFiles({ changed: [], recheck: ['db/**'] }), []);
});

test('the refusal names the files, the main that was checked, and the command', () => {
  assert.equal(
    staleReason({ files: ['db/001_a.sql'], branch: 'main', sha: '52d4c19', pr: 7 }),
    'main gained db/001_a.sql since the check (vs main@52d4c19); run ship check --pr 7 again',
  );
  const many = staleReason({ files: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], branch: 'main', sha: '52d4c19', pr: 7 });
  assert.match(many, /^main gained a, b, c, d, e \+2 more since the check/);
});

// A repo whose config asks for a fresh check when main gains a file under db/. The function form
// reads the tree it is given, as a real config may.
const CONFIG_TEXT = `import { readFileSync } from 'node:fs';
export default ({ root }) => ({
  repo: 't/r', docsOnly: ['*.md'],
  recheckOnMainChange: [readFileSync(root + '/a.txt', 'utf8').trim() === 'a' ? 'db/**' : 'none/**'],
  checks: [{ name: 'unit', paths: ['src/**'], steps: ['true'] }],
});
`;

// The merge of PR #7 in a repo where local-ci passed against main as it was when this is called.
// `then(s)` runs after the check and before the merge (main moves, the branch is pushed again).
// `description(main7, head7)` is what the status says; `statusAt` names the commit that carries
// it (default: the head of the PR; `older` is the commit before it). `times` runs the command that
// often at once.
async function scenario({
  description = (main) => `unit · vs main@${main} · 4s`, state = 'success', status = true, statusAt = (head) => head, then = async () => {},
  mergeFail = null, mergeDelayMs = 0, prOverrides = {}, prSequence = [], mainFiles, times = 1, deps = {},
} = {}) {
  const s = await setup({ configText: CONFIG_TEXT, ...(mainFiles ? { mainFiles } : {}) });
  const head = (await git(['rev-parse', 'feat'], s.work)).trim();
  const older = (await git(['rev-parse', 'feat~1'], s.work)).trim();
  const main = (await git(['--git-dir', s.origin, 'rev-parse', 'refs/heads/main'], s.work)).trim();
  await then(s);
  const merged = 'f'.repeat(40);
  const pr = { number: 7, headRefOid: head, headRefName: 'feat', baseRefName: 'main', isCrossRepository: false, state: 'OPEN', mergeCommit: { oid: merged }, ...prOverrides };
  const statuses = status ? { [statusAt(head, older)]: [{ context: 'local-ci', state, description: description(main.slice(0, 7), head.slice(0, 7)) }] } : {};
  const fake = await fakeGh(await tempDir(), { pr, prSequence, statuses, mergeFail, mergeDelayMs });
  const codes = await Promise.all(Array.from({ length: times }, () => runMerge({ cwd: s.work, pr: '7', deps: { ...s.deps, gh: fake.gh, ...deps } })));
  const calls = await fake.calls();
  return {
    code: codes[0], codes, lines: s.lines, head, merged,
    merges: calls.filter((c) => c[0] === 'pr' && c[1] === 'merge'),
    statusCalls: calls.filter((c) => c[0] === 'api').map((c) => c[1]),
  };
}

const pushMain = async (s, files) => {
  await git(['checkout', '--quiet', 'main'], s.work);
  await commitFiles(s.work, files, 'main moves again');
  await git(['push', '--quiet', s.origin, 'main'], s.work);
  await git(['checkout', '--quiet', 'feat'], s.work);
};

test('a checked PR on an unchanged main is squash-merged, pinned to the head that was checked', async () => {
  const r = await scenario();
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.merges.length, 1);
  assert.deepEqual(r.merges[0], ['pr', 'merge', '7', '--repo', 't/r', '--squash', '--match-head-commit', r.head, '--delete-branch']);
  assert.ok(r.lines.includes(`✓ merged PR #7 into main as ${r.merged}`), r.lines.join('\n'));
  // the status of the head that is being merged, and no other commit's
  assert.deepEqual(r.statusCalls, [`repos/t/r/commits/${r.head}/status?per_page=100`]);
});

test('only an older head is green: the PR head has no local-ci, so nothing is merged', async () => {
  const r = await scenario({ statusAt: (head, older) => older });
  assert.equal(r.code, 2);
  assert.equal(r.merges.length, 0);
  assert.match(r.lines.at(-1), /^✗ no local-ci status on [0-9a-f]{7}; run ship check --pr 7$/);
  assert.equal(r.statusCalls[0], `repos/t/r/commits/${r.head}/status?per_page=100`);
});

test('main gained files outside recheckOnMainChange: the merge goes ahead and says so', async () => {
  const r = await scenario({ then: (s) => pushMain(s, { 'src/other.ts': 'o\n', 'notes.md': 'n\n' }) });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.merges.length, 1);
  assert.ok(r.lines.some((l) => /gained 2 file\(s\) since the check, none of them in recheckOnMainChange/.test(l)), r.lines.join('\n'));
});

test('main gained a file that forces a fresh check: refused, nothing merged', async () => {
  const r = await scenario({ then: (s) => pushMain(s, { 'db/001_add.sql': 'select 1;\n', 'src/other.ts': 'o\n' }) });
  assert.equal(r.code, 2);
  assert.equal(r.merges.length, 0);
  assert.match(r.lines.at(-1), /^✗ main gained db\/001_add\.sql since the check \(vs main@[0-9a-f]{7}\); run ship check --pr 7 again$/);
});

test('a file main gained earlier, before the checked main, does not count', async () => {
  const r = await scenario({ mainFiles: { 'db/000_old.sql': 'select 0;\n' } });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.merges.length, 1);
});

test('a docs-only verdict is not held back by what main gained', async () => {
  const r = await scenario({ description: (main) => `docs-only · vs main@${main}`, then: (s) => pushMain(s, { 'db/001_add.sql': 'select 1;\n' }) });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.merges.length, 1);
});

test('no local-ci, a red or running one, or one that names no main: refused, nothing merged', async () => {
  for (const [name, opts, text] of [
    ['none', { status: false }, /^✗ no local-ci status on [0-9a-f]{7}; run ship check --pr 7$/],
    ['failure', { state: 'failure' }, /^✗ local-ci is failure on /],
    ['pending', { state: 'pending' }, /^✗ local-ci is pending on /],
    ['unreadable', { description: () => 'done' }, /^✗ cannot tell which main local-ci checked/],
  ]) {
    const r = await scenario(opts);
    assert.equal(r.code, 2, name);
    assert.equal(r.merges.length, 0, name);
    assert.match(r.lines.at(-1), text, name);
  }
});

test('a status for a main that is not in the repository is refused', async () => {
  const r = await scenario({ description: () => 'unit · vs main@1234567 · 4s' });
  assert.equal(r.code, 2);
  assert.equal(r.merges.length, 0);
  assert.match(r.lines.at(-1), /^✗ main@1234567, the main that local-ci checked, is not in t\/r; run ship check --pr 7 again$/);
});

test('a status that checked another branch, or a main that was rewritten, is refused', async () => {
  const other = await scenario({ description: (main) => `unit · vs release@${main} · 4s` });
  assert.equal(other.code, 2);
  assert.equal(other.merges.length, 0);
  assert.match(other.lines.at(-1), /^✗ local-ci checked against release, not main; run ship check --pr 7 again$/);

  // the "main" it names is a commit that exists in the repository but is not on main
  const rewritten = await scenario({ description: (main, head) => `unit · vs main@${head} · 4s` });
  assert.equal(rewritten.code, 2);
  assert.equal(rewritten.merges.length, 0);
  assert.match(rewritten.lines.at(-1), /^✗ main no longer contains main@[0-9a-f]{7}, the main that local-ci checked; run ship check --pr 7 again$/);
});

test('a head GitHub has not caught up with is refused: the branch holds an unchecked commit', async () => {
  const r = await scenario({ then: async (s) => {
    await commitFiles(s.work, { 'src/y.ts': 'y\n' }, 'pushed after the check');
    await git(['push', '--quiet', s.origin, 'feat'], s.work);
  } });
  assert.equal(r.code, 2);
  assert.equal(r.merges.length, 0);
  assert.match(r.lines.at(-1), /^✗ the branch of #7 is at [0-9a-f]{7} but local-ci passed [0-9a-f]{7}; run ship check --pr 7$/);
});

test('closed, forked and wrongly based PRs are refused', async () => {
  for (const [prOverrides, text] of [
    [{ state: 'MERGED' }, /^✗ PR #7 is merged$/],
    [{ isCrossRepository: true }, /^✗ PR #7 comes from a fork/],
    [{ baseRefName: 'release' }, /^✗ PR #7 targets release; only PRs into main are gated$/],
  ]) {
    const r = await scenario({ prOverrides });
    assert.equal(r.code, 2);
    assert.equal(r.merges.length, 0);
    assert.match(r.lines.at(-1), text);
  }
});

test('--keep-branch leaves the branch to GitHub; --admin is never passed', async () => {
  const s = await setup({ configText: CONFIG_TEXT });
  const head = (await git(['rev-parse', 'feat'], s.work)).trim();
  const main = (await git(['--git-dir', s.origin, 'rev-parse', 'refs/heads/main'], s.work)).trim();
  const pr = { number: 7, headRefOid: head, headRefName: 'feat', baseRefName: 'main', isCrossRepository: false, state: 'OPEN' };
  const statuses = { [head]: [{ context: 'local-ci', state: 'success', description: `unit · vs main@${main.slice(0, 7)} · 4s` }] };
  const fake = await fakeGh(await tempDir(), { pr, statuses });
  assert.equal(await runMerge({ cwd: s.work, pr: '7', keepBranch: true, deps: { ...s.deps, gh: fake.gh } }), 0, s.lines.join('\n'));
  const merge = (await fake.calls()).find((c) => c[1] === 'merge');
  assert.ok(!merge.includes('--delete-branch'));
  assert.ok(!merge.includes('--admin'));
  assert.ok(s.lines.includes('✓ merged PR #7 into main (GitHub has not reported the merge commit yet)'), s.lines.join('\n'));
});

test('GitHub refusing the merge (protection, a conflict) is reported and fails', async () => {
  const r = await scenario({ mergeFail: 'Pull request is not mergeable: the base branch policy prohibits the merge.' });
  assert.equal(r.code, 1);
  assert.equal(r.merges.length, 1);
  assert.match(r.lines.at(-1), /^✗ gh pr merge refused PR #7: Pull request is not mergeable/);
});

test('gh failing after the PR was in fact merged: reported as merged, with the reason, exit 0', async () => {
  const r = await scenario({ mergeFail: 'failed to delete remote branch: HTTP 422', prSequence: [{}, { state: 'MERGED' }] });
  assert.equal(r.code, 0);
  assert.equal(r.merges.length, 1);
  assert.equal(r.lines.at(-1), `✓ merged PR #7 into main as ${r.merged}, but gh reported: failed to delete remote branch: HTTP 422`);
});

test('gh failing and the PR state unreadable: the outcome is unknown, exit 1', async () => {
  const r = await scenario({ mergeFail: 'connection reset', prSequence: [{}, { fail: true }] });
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-1), /^✗ gh pr merge failed for PR #7 \(.*connection reset.*\) and its state could not be read: the outcome is unknown, check gh pr view 7$/);
});

test('a hung gh pr merge is stopped after mergeTimeoutMs; the PR is looked at, not assumed', async () => {
  const hung = await scenario({ mergeDelayMs: 5000, deps: { mergeTimeoutMs: 300 } });
  assert.equal(hung.code, 1);
  assert.equal(hung.lines.at(-1), '✗ gh pr merge gave no answer for PR #7 within 0.3s; it is still open — check gh pr view 7 before merging again');
  const landed = await scenario({ mergeDelayMs: 5000, deps: { mergeTimeoutMs: 300 }, prSequence: [{}, { state: 'MERGED' }] });
  assert.equal(landed.code, 0);
  assert.equal(landed.lines.at(-1), `✓ merged PR #7 into main as ${landed.merged}, but gh reported: no answer after 0.3s`);
});

test('two ship merges of one repository take turns', async () => {
  const r = await scenario({ times: 2 });
  assert.deepEqual(r.codes, [0, 0], r.lines.join('\n'));
  assert.equal(r.merges.length, 2);
  assert.equal(r.lines.filter((l) => l === '… another ship merge of t/r is running — waiting for it').length, 1, r.lines.join('\n'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, mkdir, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureMirror, mirrorPath, fetchCommit, revParse, addWorktree, removeWorktree, mergeInto, changedFiles, showFile, isAncestor, listTree, commitsTouching, subject, lastCommitBefore } from '../lib/git.mjs';
import { validateConfig } from '../lib/config.mjs';
import { classify } from '../lib/classify.mjs';
import { capture } from '../lib/proc.mjs';
import { makeOrigin, commitFiles, git, tempDir } from './helpers.mjs';

async function branchAndMain({ feat, main }) {
  const o = await makeOrigin({ 'a.txt': 'a\n' });
  await git(['checkout', '--quiet', '-b', 'feat'], o.work);
  const head = await commitFiles(o.work, feat, 'feat');
  await git(['push', '--quiet', 'origin', 'feat'], o.work);
  await git(['checkout', '--quiet', 'main'], o.work);
  await commitFiles(o.work, main, 'main moves');
  await git(['push', '--quiet', 'origin', 'main'], o.work);
  const mirror = await ensureMirror('t/r', { root: join(o.root, 'mirrors'), url: o.origin });
  return { ...o, head, mirror };
}

test('mirror, worktree, merge with main, diff since the merge base', async () => {
  const { root, head, mirror } = await branchAndMain({ feat: { 'src/x.ts': 'x\n' }, main: { 'b.txt': 'b\n' } });
  await fetchCommit(mirror, head, 1);
  const mainSha = await revParse(mirror, 'refs/heads/main');
  const wt = join(root, 'wt');
  await addWorktree(mirror, wt, head);
  assert.deepEqual(await mergeInto(wt, mainSha), { ok: true });
  assert.equal(await readFile(join(wt, 'b.txt'), 'utf8'), 'b\n');
  assert.equal(await readFile(join(wt, 'src/x.ts'), 'utf8'), 'x\n');
  assert.deepEqual(await changedFiles(mirror, mainSha, head), ['src/x.ts']);
  assert.equal(await showFile(mirror, 'refs/heads/main', 'a.txt'), 'a\n');
  assert.equal(await showFile(mirror, 'refs/heads/main', 'missing.txt'), null);
  await removeWorktree(mirror, wt);
  await assert.rejects(() => access(wt));
});

test('showFile answers null only for a file that is not there; other git errors are not swallowed', async () => {
  const { mirror } = await branchAndMain({ feat: { 'src/x.ts': 'x\n' }, main: { 'b.txt': 'b\n' } });
  assert.equal(await showFile(mirror, 'refs/heads/main', 'nope.txt'), null);
  assert.equal(await showFile(mirror, 'refs/heads/main', 'b.txt'), 'b\n');
  await assert.rejects(() => showFile(mirror, 'f'.repeat(40), 'b.txt'));
  await assert.rejects(() => showFile(join(mirror, 'not-a-repository'), 'refs/heads/main', 'b.txt'));
});

test('a conflicting merge is reported, not thrown', async () => {
  const { root, head, mirror } = await branchAndMain({ feat: { 'a.txt': 'feature\n' }, main: { 'a.txt': 'main\n' } });
  const wt = join(root, 'wt');
  await addWorktree(mirror, wt, head);
  const r = await mergeInto(wt, await revParse(mirror, 'refs/heads/main'));
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  await removeWorktree(mirror, wt);
});

test('a merge that fails without a conflict is not reported as one', async () => {
  const { root, head, mirror } = await branchAndMain({ feat: { 'src/x.ts': 'x\n' }, main: { 'b.txt': 'b\n' } });
  const wt = join(root, 'wt');
  await addWorktree(mirror, wt, head);
  const r = await mergeInto(wt, 'f'.repeat(40)); // not a commit
  assert.equal(r.ok, false);
  assert.equal(r.conflict, false);
  await removeWorktree(mirror, wt);
});

test('a global commit.gpgsign=true does not derail the merge commit', async () => {
  const { root, head, mirror } = await branchAndMain({ feat: { 'src/x.ts': 'x\n' }, main: { 'b.txt': 'b\n' } });
  const wt = join(root, 'wt');
  await addWorktree(mirror, wt, head);
  const saved = { c: process.env.GIT_CONFIG_COUNT, k0: process.env.GIT_CONFIG_KEY_0, v0: process.env.GIT_CONFIG_VALUE_0, k1: process.env.GIT_CONFIG_KEY_1, v1: process.env.GIT_CONFIG_VALUE_1 };
  Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_1: 'gpg.program', GIT_CONFIG_VALUE_1: 'false' });
  try {
    assert.deepEqual(await mergeInto(wt, await revParse(mirror, 'refs/heads/main')), { ok: true });
  } finally {
    for (const [k, v] of Object.entries({ GIT_CONFIG_COUNT: saved.c, GIT_CONFIG_KEY_0: saved.k0, GIT_CONFIG_VALUE_0: saved.v0, GIT_CONFIG_KEY_1: saved.k1, GIT_CONFIG_VALUE_1: saved.v1 })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await removeWorktree(mirror, wt);
  }
});

test('ensureMirror fetches new commits on later calls', async () => {
  const o = await makeOrigin({ 'a.txt': 'a\n' });
  const root = join(await tempDir(), 'mirrors');
  const mirror = await ensureMirror('t/r', { root, url: o.origin });
  const sha = await commitFiles(o.work, { 'c.txt': 'c\n' }, 'more');
  await git(['push', '--quiet', 'origin', 'main'], o.work);
  await ensureMirror('t/r', { root, url: o.origin });
  assert.equal(await revParse(mirror, 'refs/heads/main'), sha);
});

test('fetchCommit throws for an unknown commit', async () => {
  const o = await makeOrigin({ 'a.txt': 'a\n' });
  const mirror = await ensureMirror('t/r', { root: join(o.root, 'mirrors'), url: o.origin });
  await assert.rejects(() => fetchCommit(mirror, 'f'.repeat(40), 1), /not found/);
});

test('a rename lists both the old and the new path, so moving code into a docs folder is still checked', async () => {
  const body = 'export const answer = 42;\n'.repeat(20);
  const o = await makeOrigin({ 'src/index.ts': body, 'a.txt': 'a\n' });
  await git(['checkout', '--quiet', '-b', 'feat'], o.work);
  await mkdir(join(o.work, 'docs'), { recursive: true });
  await git(['mv', 'src/index.ts', 'docs/index.md'], o.work);
  await git(['commit', '--quiet', '-m', 'move'], o.work);
  const head = (await git(['rev-parse', 'HEAD'], o.work)).trim();
  await git(['push', '--quiet', 'origin', 'feat'], o.work);
  const mirror = await ensureMirror('t/r', { root: join(o.root, 'mirrors'), url: o.origin });
  const base = await revParse(mirror, 'refs/heads/main');
  const files = await changedFiles(mirror, base, head);
  assert.deepEqual(files, ['docs/index.md', 'src/index.ts']);

  const config = validateConfig({ repo: 't/r', docsOnly: ['docs/**'], checks: [{ name: 'unit', paths: ['src/**'], steps: ['true'] }] });
  const plan = classify(files, config);
  assert.equal(plan.docsOnly, false);
  assert.deepEqual(plan.groups, ['unit']);
});

test('changedFiles returns unquoted, NUL-separated names for non-ASCII paths', async () => {
  const name = 'café notes.txt';
  const o = await makeOrigin({ 'a.txt': 'a\n' });
  await git(['checkout', '--quiet', '-b', 'feat'], o.work);
  const head = await commitFiles(o.work, { [name]: 'x\n' }, 'add');
  await git(['push', '--quiet', 'origin', 'feat'], o.work);
  const mirror = await ensureMirror('t/r', { root: join(o.root, 'mirrors'), url: o.origin });
  assert.deepEqual(await changedFiles(mirror, await revParse(mirror, 'refs/heads/main'), head), [name]);
});

test('a mirror left without the fetch refspec (an interrupted first clone) heals on the next call', async () => {
  const o = await makeOrigin({ 'a.txt': 'a\n' });
  const root = join(await tempDir(), 'mirrors');
  await mkdir(root, { recursive: true });
  const mirror = mirrorPath('t/r', root);
  await git(['clone', '--bare', '--quiet', o.origin, mirror]); // as far as an interrupted ensureMirror got
  const sha = await commitFiles(o.work, { 'c.txt': 'c\n' }, 'more');
  await git(['push', '--quiet', 'origin', 'main'], o.work);
  await ensureMirror('t/r', { root, url: o.origin });
  assert.equal(await revParse(mirror, 'refs/heads/main'), sha);
});

test('the first clone is renamed into place and leaves nothing beside it', async () => {
  const o = await makeOrigin({ 'a.txt': 'a\n' });
  const root = join(await tempDir(), 'mirrors');
  await ensureMirror('t/r', { root, url: o.origin });
  assert.deepEqual(await readdir(root), ['t__r.git']);
});

test('a failed first clone leaves no mirror and no staging directory', async () => {
  const root = join(await tempDir(), 'mirrors');
  await assert.rejects(() => ensureMirror('t/r', { root, url: join(root, 'no-such-origin') }));
  assert.deepEqual(await readdir(root), []);
});

test('an ensureMirror sweeps the stale staging directory of a clone that was killed', async () => {
  const o = await makeOrigin({ 'a.txt': 'a\n' });
  const root = join(await tempDir(), 'mirrors');
  await mkdir(join(root, 't__r.git.new-old'), { recursive: true });
  await mkdir(join(root, 't__r.git.new-fresh'));
  await mkdir(join(root, 'other__repo.git.new-old'));
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(join(root, 't__r.git.new-old'), twoHoursAgo, twoHoursAgo);
  await utimes(join(root, 'other__repo.git.new-old'), twoHoursAgo, twoHoursAgo);
  await ensureMirror('t/r', { root, url: o.origin });
  assert.deepEqual((await readdir(root)).sort(), ['other__repo.git.new-old', 't__r.git', 't__r.git.new-fresh']);
});

test('isAncestor, listTree, commitsTouching, subject', async () => {
  const { origin, work, root } = await makeOrigin({ 'app/a.ts': '1', 'db/001.sql': '' });
  const first = (await git(['rev-parse', 'HEAD'], work)).trim();
  await commitFiles(work, { 'app/a.ts': '2' }, 'app change (#11)');
  await commitFiles(work, { 'docs/x.md': 'x' }, 'docs only (#12)');
  const head = await commitFiles(work, { 'db/002.sql': '' }, 'add migration (#13)');
  await git(['push', '--quiet', 'origin', 'main'], work);
  const mirror = await ensureMirror('t/r', { root: join(root, 'm'), url: origin });
  assert.equal(await isAncestor(mirror, first, head), true);
  assert.equal(await isAncestor(mirror, head, first), false);
  assert.deepEqual((await listTree(mirror, head)).sort(), ['app/a.ts', 'db/001.sql', 'db/002.sql', 'docs/x.md']);
  assert.deepEqual((await commitsTouching(mirror, first, head, ['app/**', 'db/*.sql'])).map((c) => c.subject), ['add migration (#13)', 'app change (#11)']);
  assert.equal(await subject(mirror, head), 'add migration (#13)');
  assert.equal(await subject(mirror, 'f'.repeat(40)), null);
});

test('lastCommitBefore answers the newest commit made before a moment, or null', async () => {
  const dir = await tempDir('dated-');
  await git(['init', '--quiet', '--initial-branch=main', dir]);
  const commit = async (file, iso) => {
    await commitFiles(dir, { [file]: 'x\n' }, file); // the message is the file name; the date is set below
    await capture('git', ['commit', '--quiet', '--amend', '--no-edit', '--date', iso], { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: iso, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost' } });
    return (await git(['rev-parse', 'HEAD'], dir)).trim();
  };
  const one = await commit('one.txt', '2026-01-01T00:00:10Z');
  const two = await commit('two.txt', '2026-01-01T00:00:20Z');
  const gitDir = join(dir, '.git');
  assert.equal(await lastCommitBefore(gitDir, 'refs/heads/main', '2026-01-01T00:00:05.000Z'), null);
  assert.equal(await lastCommitBefore(gitDir, 'refs/heads/main', '2026-01-01T00:00:15.123456Z'), one);
  assert.equal(await lastCommitBefore(gitDir, 'refs/heads/main', '2026-01-01T00:00:30.000Z'), two);
});

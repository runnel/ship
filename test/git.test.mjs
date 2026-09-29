import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureMirror, fetchCommit, revParse, addWorktree, removeWorktree, mergeInto, changedFiles, showFile } from '../lib/git.mjs';
import { validateConfig } from '../lib/config.mjs';
import { classify } from '../lib/classify.mjs';
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureMirror, fetchCommit, revParse, addWorktree, removeWorktree, mergeInto, changedFiles, showFile } from '../lib/git.mjs';
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
  await removeWorktree(mirror, wt);
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

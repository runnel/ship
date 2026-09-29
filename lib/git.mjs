import { mkdir, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { capture } from './proc.mjs';
import { SHIP_HOME } from './paths.mjs';

// ship never touches the developer's checkout: every fetch and worktree comes from this bare
// mirror outside any synced folder.
export const MIRROR_ROOT = join(SHIP_HOME, 'mirrors');

export function mirrorPath(repo, root = MIRROR_ROOT) {
  return join(root, `${repo.replace('/', '__')}.git`);
}

const g = (mirror, args) => capture('git', ['--git-dir', mirror, ...args]);

export async function ensureMirror(repo, { root = MIRROR_ROOT, url = `https://github.com/${repo}.git` } = {}) {
  const mirror = mirrorPath(repo, root);
  const exists = await access(mirror).then(() => true, () => false);
  if (!exists) {
    await mkdir(root, { recursive: true });
    await capture('git', ['clone', '--bare', '--quiet', url, mirror]);
    await g(mirror, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*']);
  }
  await g(mirror, ['fetch', '--quiet', '--prune', 'origin']);
  await g(mirror, ['worktree', 'prune']);
  return mirror;
}

const hasCommit = (mirror, sha) => g(mirror, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);

export async function fetchCommit(mirror, sha, prNumber) {
  if (await hasCommit(mirror, sha)) return;
  await g(mirror, ['fetch', '--quiet', 'origin', `pull/${prNumber}/head`]).catch(() => {});
  if (!(await hasCommit(mirror, sha))) throw new Error(`commit ${sha} not found in ${mirror}`);
}

export async function revParse(mirror, ref) {
  return (await g(mirror, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

export async function addWorktree(mirror, path, sha) {
  await g(mirror, ['worktree', 'add', '--quiet', '--detach', '--force', path, sha]);
}

export async function removeWorktree(mirror, path) {
  await g(mirror, ['worktree', 'remove', '--force', path]).catch(() => {});
  await rm(path, { recursive: true, force: true });
}

export async function mergeInto(worktree, sha) {
  try {
    await capture('git', ['-C', worktree, '-c', 'user.name=ship', '-c', 'user.email=ship@localhost', 'merge', '--no-edit', '--quiet', sha]);
    return { ok: true };
  } catch (e) {
    await capture('git', ['-C', worktree, 'merge', '--abort']).catch(() => {});
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

export async function changedFiles(mirror, base, head) {
  return (await g(mirror, ['diff', '--name-only', `${base}...${head}`])).split('\n').filter(Boolean);
}

export async function showFile(mirror, ref, path) {
  try {
    return await g(mirror, ['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

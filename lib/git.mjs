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

// A conflict leaves unmerged paths behind; anything else (a signing setup, a killed git, an unknown
// commit) is a failure of the merge, not a conflict with main.
export async function mergeInto(worktree, sha) {
  try {
    await capture('git', ['-C', worktree, '-c', 'user.name=ship', '-c', 'user.email=ship@localhost', '-c', 'commit.gpgsign=false', 'merge', '--no-edit', '--quiet', sha]);
    return { ok: true };
  } catch (e) {
    const unmerged = (await capture('git', ['-C', worktree, 'diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
    await capture('git', ['-C', worktree, 'merge', '--abort']).catch(() => {});
    return { ok: false, conflict: unmerged.length > 0, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// --no-renames: a moved file counts as a deletion plus an addition, so the old path is
// classified too (moving src/a.ts to docs/a.md must not read as a docs-only change). -z: NUL
// separated and never quoted, whatever core.quotePath says.
export async function changedFiles(mirror, base, head) {
  return (await g(mirror, ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`])).split('\0').filter(Boolean);
}

// null only when the path is not in the tree; every other git failure propagates, so that a
// transient error can never read as "there is no such file".
export async function showFile(mirror, ref, path) {
  const listed = await g(mirror, ['ls-tree', '--name-only', ref, '--', path]);
  if (!listed.trim()) return null;
  return await g(mirror, ['show', `${ref}:${path}`]);
}

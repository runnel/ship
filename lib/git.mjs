import { mkdir, mkdtemp, access, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { capture } from './proc.mjs';
import { SHIP_HOME } from './paths.mjs';
import { matchesAny } from './glob.mjs';

// ship never touches the developer's checkout: every fetch and worktree comes from this bare
// mirror outside any synced folder.
export const MIRROR_ROOT = join(SHIP_HOME, 'mirrors');

export function mirrorPath(repo, root = MIRROR_ROOT) {
  return join(root, `${repo.replace('/', '__')}.git`);
}

const g = (mirror, args) => capture('git', ['--git-dir', mirror, ...args]);

const STALE_STAGING_MS = 60 * 60 * 1000;

// A ship killed outright (SIGKILL) during the first clone leaves its staging directory behind, in a
// durable directory nothing else sweeps. Callers hold the mirror lock, so an old one is abandoned.
async function sweepStaging(root, base) {
  for (const name of await readdir(root).catch(() => [])) {
    if (!name.startsWith(`${base}.new-`)) continue;
    const st = await stat(join(root, name)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > STALE_STAGING_MS) await rm(join(root, name), { recursive: true, force: true });
  }
}

export async function ensureMirror(repo, { root = MIRROR_ROOT, url = `https://github.com/${repo}.git` } = {}) {
  const mirror = mirrorPath(repo, root);
  await mkdir(root, { recursive: true });
  await sweepStaging(root, basename(mirror));
  const exists = await access(mirror).then(() => true, () => false);
  if (!exists) {
    // Clone beside the final path and rename: a ship killed mid-clone must not leave a mirror behind
    // that later runs would take for a finished one.
    const staging = await mkdtemp(`${mirror}.new-`);
    try {
      await capture('git', ['clone', '--bare', '--quiet', url, staging]);
      await rename(staging, mirror);
    } catch (e) {
      await rm(staging, { recursive: true, force: true });
      throw e;
    }
  }
  // Every run, not only after cloning: without this refspec `fetch` never moves refs/heads/*, and every
  // check would silently merge against the main of the day the mirror was cloned.
  await g(mirror, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*']);
  await g(mirror, ['fetch', '--quiet', '--prune', 'origin']);
  await g(mirror, ['worktree', 'prune']);
  return mirror;
}

export const hasCommit = (mirror, sha) => g(mirror, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);

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

// true / false from the exit status; any other failure (an unknown commit) propagates.
export async function isAncestor(mirror, ancestor, descendant) {
  try {
    await g(mirror, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (e) {
    if (e.code === 1) return false;
    throw e;
  }
}

export async function listTree(mirror, ref) {
  return (await g(mirror, ['ls-tree', '-r', '--name-only', '-z', ref])).split('\0').filter(Boolean);
}

// Commits in from..to, newest first, that change a file matching `globs`.
export async function commitsTouching(mirror, from, to, globs) {
  const text = await g(mirror, ['-c', 'core.quotePath=false', 'log', '--no-renames', '--format=%x01%H%x02%s', '--name-only', `${from}..${to}`]);
  const out = [];
  for (const chunk of text.split('\x01').filter(Boolean)) {
    const [head, ...rest] = chunk.split('\n');
    const [sha, subj] = head.split('\x02');
    if (rest.filter(Boolean).some((f) => matchesAny(f, globs))) out.push({ sha, subject: subj });
  }
  return out;
}

export async function subject(mirror, sha) {
  if (!(await hasCommit(mirror, sha))) return null;
  return (await g(mirror, ['log', '-1', '--format=%s', sha])).trim();
}

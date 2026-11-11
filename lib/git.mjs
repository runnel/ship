import { mkdir, mkdtemp, access, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { capture, captureWithin } from './proc.mjs';
import { SHIP_HOME } from './paths.mjs';
import { matchesAny } from './glob.mjs';

// ship never touches the developer's checkout: every fetch and worktree comes from this bare
// mirror outside any synced folder.
export const MIRROR_ROOT = join(SHIP_HOME, 'mirrors');

export function mirrorPath(repo, root = MIRROR_ROOT) {
  return join(root, `${repo.replace('/', '__')}.git`);
}

// Git reads the working directory before it looks at --git-dir, so a process whose directory was
// removed under it would fail every call: each one runs in the directory that holds the mirror, which
// ensureMirror created. (Not in the mirror itself: in a bare repository `refs/heads/main` would then
// also name a file, and git refuses an argument that is both.)
const home = (mirror) => dirname(mirror);
const g = (mirror, args, opts) => capture('git', ['--git-dir', mirror, ...args], { cwd: home(mirror), ...opts });

// A fetch that hangs (a half-open connection) must not hold up whoever waits for the mirror: with
// `timeoutMs` > 0 it is killed then, and the error says so.
async function fetching(mirror, args, timeoutMs, what) {
  if (!(timeoutMs > 0)) return g(mirror, args);
  try {
    return await captureWithin('git', ['--git-dir', mirror, ...args], timeoutMs, { cwd: home(mirror) });
  } catch (e) {
    if (e.timedOut) throw Object.assign(new Error(`git fetch of ${what} took longer than ${timeoutMs / 1000} s`), { timedOut: true });
    throw e;
  }
}

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

// Git takes a `<file>.lock` beside a ref (and packed-refs, HEAD, config) while it changes it, for
// milliseconds: its own wait for one is at most a second. A git killed outright (a fetch past its time
// limit) leaves its locks behind, and every later fetch then fails on them. Callers hold the mirror
// lock, so a lock older than this belongs to nobody. A younger one is left alone: an overflow check
// moves its own refs under refs/ship/ without the mirror lock.
const STALE_LOCK_MS = 60 * 1000;

async function sweepStaleLocks(mirror) {
  const names = [
    'packed-refs.lock', 'HEAD.lock', 'config.lock',
    ...(await readdir(join(mirror, 'refs'), { recursive: true }).catch(() => []))
      .filter((n) => n.endsWith('.lock')).map((n) => join('refs', n)),
  ];
  for (const name of names) {
    const st = await stat(join(mirror, name)).catch(() => null);
    if (st?.isFile() && Date.now() - st.mtimeMs > STALE_LOCK_MS) await rm(join(mirror, name), { force: true });
  }
}

export async function ensureMirror(repo, { root = MIRROR_ROOT, url = `https://github.com/${repo}.git`, fetchTimeoutMs = 0 } = {}) {
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
  await sweepStaleLocks(mirror);
  // Every run, not only after cloning: without this refspec `fetch` never moves refs/heads/*, and every
  // check would silently merge against the main of the day the mirror was cloned.
  await g(mirror, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*']);
  await fetching(mirror, ['fetch', '--quiet', '--prune', 'origin'], fetchTimeoutMs, repo);
  await g(mirror, ['worktree', 'prune']);
  return mirror;
}

export const hasCommit = (mirror, sha) => g(mirror, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);

export async function fetchCommit(mirror, sha, prNumber, { timeoutMs = 0 } = {}) {
  if (await hasCommit(mirror, sha)) return;
  await fetching(mirror, ['fetch', '--quiet', 'origin', `pull/${prNumber}/head`], timeoutMs, `pull/${prNumber}/head`)
    .catch((e) => { if (e.timedOut) throw e; });
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

// Commits in from..to, newest first, that change a file matching `globs` (or, given a function,
// one it accepts).
export async function commitsTouching(mirror, from, to, globs) {
  const wanted = typeof globs === 'function' ? globs : (f) => matchesAny(f, globs);
  const text = await g(mirror, ['-c', 'core.quotePath=false', 'log', '--no-renames', '--format=%x01%H%x02%s', '--name-only', `${from}..${to}`]);
  const out = [];
  for (const chunk of text.split('\x01').filter(Boolean)) {
    const [head, ...rest] = chunk.split('\n');
    const [sha, subj] = head.split('\x02');
    if (rest.filter(Boolean).some(wanted)) out.push({ sha, subject: subj });
  }
  return out;
}

// When `sha` was committed (its committer time), in ms.
export async function commitTimeMs(mirror, sha) {
  return Number((await g(mirror, ['log', '-1', '--format=%ct', sha])).trim()) * 1000;
}

// The newest commit on the history of `ref` that added `path`, as { sha, subject }, or null.
export async function addedIn(mirror, ref, path) {
  const out = (await g(mirror, ['-c', 'core.quotePath=false', 'log', '-1', '--diff-filter=A', '--format=%H%x02%s', ref, '--', path])).trim();
  if (!out) return null;
  const [sha, subj] = out.split('\x02');
  return { sha, subject: subj };
}

export async function subject(mirror, sha) {
  if (!(await hasCommit(mirror, sha))) return null;
  return (await g(mirror, ['log', '-1', '--format=%s', sha])).trim();
}

// The newest commit on `ref`'s first-parent line (the commits that were the branch's tip) made
// before `iso` by commit date, or null when there is none. A commit that sat on a side branch when
// `iso` passed and was merged later is not what the branch held at that moment.
export async function lastCommitBefore(mirror, ref, iso) {
  const sha = (await g(mirror, ['rev-list', '-1', '--first-parent', `--before=${iso}`, ref])).trim();
  return sha || null;
}

// --- a commit for a remote machine to check out ---------------------------------------------------------

// The tip of `branch` at `url` fetched into `ref` of the mirror, so that a push after it sends only what
// is new; null while the branch does not exist. A remote that cannot be read throws. A missing login fails
// at once instead of asking for one.
export async function fetchBranchTip(mirror, url, branch, ref, { timeoutMs = 120_000 } = {}) {
  const opts = { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: timeoutMs, killSignal: 'SIGKILL' };
  const listed = await g(mirror, ['ls-remote', url, `refs/heads/${branch}`], opts);
  if (!listed.split('\n').some((l) => l.endsWith(`\trefs/heads/${branch}`))) return null;
  await g(mirror, ['fetch', '--quiet', url, `+refs/heads/${branch}:${ref}`], opts);
  return revParse(mirror, ref);
}

// A commit of the tree `tree` with `files` ({ name: content }) under `dir`, whatever was under `dir`
// before being left out, on top of `parent` (none when null). The index is a scratch one and nothing is
// checked out: only objects are written to the mirror. Returns { commit, tree }.
export async function overlayCommit(mirror, { tree, dir, files, parent = null, message }) {
  const scratch = await mkdtemp(join(tmpdir(), 'ship-overlay-'));
  try {
    // update-index insists on a work tree, even to drop an entry; the scratch directory is an empty one.
    const index = (args) => g(mirror, ['--work-tree', scratch, ...args], { env: { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') } });
    await index(['read-tree', tree]);
    const old = (await g(mirror, ['ls-tree', '-r', '-z', '--name-only', tree, '--', dir])).split('\0').filter(Boolean);
    for (let i = 0; i < old.length; i += 200) await index(['update-index', '--force-remove', '--', ...old.slice(i, i + 200)]);
    const entries = [];
    for (const [name, content] of Object.entries(files)) {
      const file = join(scratch, 'content');
      await writeFile(file, content);
      entries.push(`100644,${(await index(['hash-object', '-w', '--no-filters', file])).trim()},${dir}/${name}`);
    }
    await index(['update-index', '--add', '--replace', ...entries.flatMap((e) => ['--cacheinfo', e])]);
    const written = (await index(['write-tree'])).trim();
    const commit = (await g(mirror, ['-c', 'user.name=ship', '-c', 'user.email=ship@localhost', '-c', 'commit.gpgsign=false', 'commit-tree', written, ...(parent ? ['-p', parent] : []), '-m', message])).trim();
    return { commit, tree: written };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Points `ref` of the mirror at `sha`.
export const setRef = (mirror, ref, sha) => g(mirror, ['update-ref', ref, sha]);

// Makes `branch` at `url` point at `sha`, whatever it pointed at.
export const forcePush = (mirror, url, sha, branch, { timeoutMs = 300_000 } = {}) =>
  g(mirror, ['push', '--quiet', '--force', url, `${sha}:refs/heads/${branch}`], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: timeoutMs, killSignal: 'SIGKILL' });

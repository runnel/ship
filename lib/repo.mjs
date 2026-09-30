import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { capture } from './proc.mjs';
import { ensureMirror, revParse, addWorktree, removeWorktree, showFile, MIRROR_ROOT } from './git.mjs';
import { parseRepoFromUrl, defaultBranch } from './github.mjs';
import { loadConfigSource } from './config.mjs';
import { ownerInfo } from './lock.mjs';
import { onInterrupt, isInterrupted } from './interrupt.mjs';
import { lockWithCleanup, sharedCleanup, repoKeyOf, sweepWorktrees } from './shared.mjs';
import { readCredentials } from './cloudflare.mjs';
import { SHIP_TMP, SHIP_HOME } from './paths.mjs';

export function deployDeps() {
  return {
    gh: 'gh',
    remoteUrl: (repo) => `https://github.com/${repo}.git`,
    mirrorRoot: MIRROR_ROOT,
    tmpRoot: SHIP_TMP,
    logRoot: join(SHIP_HOME, 'logs'),
    stateRoot: SHIP_HOME, // holds/ and acks/
    out: (line) => process.stdout.write(`${line}\n`),
    pollMs: 5000,
    fetch: globalThis.fetch,
    readCredentials,
    probeWindowMs: 60_000,
    probeIntervalMs: 3000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function repoFromCwd(cwd) {
  return parseRepoFromUrl(await capture('git', ['-C', cwd, 'remote', 'get-url', 'origin']));
}

// Fetches the mirror under its lock and returns main's tip.
export async function syncMirror({ repo, d }) {
  const key = repoKeyOf(repo);
  const release = await lockWithCleanup(join(d.tmpRoot, 'locks', `mirror-${key}`), await ownerInfo({ repo }), { pollMs: d.pollMs });
  try {
    const mirror = await ensureMirror(repo, { root: d.mirrorRoot, url: d.remoteUrl(repo) });
    const mainBranch = await defaultBranch({ repo, gh: d.gh });
    const mainSha = await revParse(mirror, `refs/heads/${mainBranch}`);
    return { repo, key, mirror, mainBranch, mainSha };
  } finally {
    await release();
  }
}

// A fresh worktree at `sha`, with the config of that commit evaluated against it. `close` removes
// it (also run by an interrupt) and may be called more than once.
export async function openTree({ d, r, sha, label }) {
  await sweepWorktrees(join(d.tmpRoot, 'w'));
  const wt = join(d.tmpRoot, 'w', `${label}-${sha.slice(0, 7)}-${randomBytes(2).toString('hex')}`);
  const remove = sharedCleanup(() => removeWorktree(r.mirror, wt));
  const off = onInterrupt(remove);
  const close = async () => {
    await remove();
    if (!isInterrupted()) off();
  };
  try {
    await addWorktree(r.mirror, wt, sha);
    const source = await showFile(r.mirror, sha, 'ship.config.mjs');
    if (source === null) throw new Error(`no ship.config.mjs at ${r.mainBranch}@${sha.slice(0, 7)}`);
    const config = await loadConfigSource(source, { root: wt });
    if (config.mainBranch !== r.mainBranch) throw new Error(`config mainBranch ${config.mainBranch} is not ${r.mainBranch}`);
    return { wt, config, close };
  } catch (e) {
    await close();
    throw e;
  }
}

export const prRefs = (subjects) =>
  subjects.map((s) => s.match(/\(#(\d+)\)\s*$/)?.[1]).filter(Boolean).map((n) => `#${n}`).join(' ');

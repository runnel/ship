import { join } from 'node:path';
import { changedFiles, commitTimeMs, commitsTouching, hasCommit, isAncestor, listTree } from './git.mjs';
import { matchesAny, pendingFile } from './glob.mjs';
import { ownerInfo, tryLock } from './lock.mjs';
import { openTree, syncMirror } from './repo.mjs';
import { cloudflareFor } from './cloudflare.mjs';
import { planDeploy } from './plan.mjs';
import { landDir, readJson, writeJsonAtomic } from './land-line.mjs';
import { NOT_RUNNABLE } from './deploy.mjs';

// What a merge brings, read from the merge commit itself: its config, the deployables it touches (a
// pending file in the merge commit's own diff) and the migration files it adds.
export async function landedChanges({ d, r, mergeSha }) {
  const tree = await openTree({ d, r, sha: mergeSha, label: 'l' });
  try {
    const { config } = tree;
    const files = await changedFiles(r.mirror, `${mergeSha}^`, mergeSha);
    const touched = config.deployables.filter((dep) => files.some(pendingFile(dep, config.docsOnly))).map((dep) => dep.name);
    let added = [];
    if (config.migrations) {
      const present = new Set(await listTree(r.mirror, mergeSha));
      added = files.filter((f) => matchesAny(f, config.migrations.paths) && present.has(f));
    }
    return { config, touched, added };
  } finally {
    await tree.close();
  }
}

// What is live in a repository, for every land that waits there: one file, refreshed by whichever
// land holds the small refresh lock, and read by the others. A poll makes no Cloudflare calls of its
// own: reading a repository's deployables costs dozens of paginated API calls.
const cacheFile = (d, repo) => join(landDir(d, repo), 'live.json');

export const readLiveCache = (d, repo) => readJson(cacheFile(d, repo));

// When the oldest commit on main that a deployable has not shipped was made: the deploy deadline
// counts from it. A deployable a deploy would not run (held, blocked, or skipped because it waits for
// one that is) is left out: its backlog waits for the owner, and counting it would put every deadline
// in the past while the hold lasts.
async function oldestUnlive({ r, config, entries }) {
  let oldest = null;
  for (const e of entries) {
    if (e.live.state !== 'known' || NOT_RUNNABLE.has(e.status) || !(await hasCommit(r.mirror, e.live.sha))) continue;
    const pending = await commitsTouching(r.mirror, e.live.sha, r.mainSha, pendingFile(e.dep, config.docsOnly));
    if (pending.length === 0) continue;
    const at = await commitTimeMs(r.mirror, pending.at(-1).sha);
    oldest = oldest === null ? at : Math.min(oldest, at);
  }
  return oldest;
}

export async function refreshLiveCache({ d, repo }) {
  const release = await tryLock(join(landDir(d, repo), 'refresh'), await ownerInfo({ repo, command: 'land live read' }));
  if (!release) return null;
  try {
    // Stamped before anything is read: a refresh that was under way when a deploy ended may show what
    // was live before it, so it must count as older than that end.
    const readAt = new Date(d.now()).toISOString();
    const r = await syncMirror({ repo, d });
    const tree = await openTree({ d, r, sha: r.mainSha, label: 'v' });
    try {
      const { config } = tree;
      const deployables = {};
      let entries = [];
      if (config.deployables.length > 0) {
        const { cf } = await cloudflareFor(d, config.credentials);
        entries = await planDeploy({ r, config, selected: new Set(config.deployables.map((x) => x.name)), target: r.mainSha, cf, stateRoot: d.stateRoot });
        for (const e of entries) deployables[e.dep.name] = { state: e.live.state, sha: e.live.sha ?? null, status: e.status, reason: e.live.reason ?? null };
      }
      const cache = { readAt, mainSha: r.mainSha, oldestUnliveAtMs: await oldestUnlive({ r, config, entries }), deployables };
      await writeJsonAtomic(cacheFile(d, repo), cache);
      return cache;
    } finally {
      await tree.close();
    }
  } finally {
    await release();
  }
}

// The cache, read again first when it is older than `liveCacheMs` or than `staleBeforeMs` (a deploy
// that ended after it was read). A refresh another land is making is not waited for: an old file
// will do, unless it was read before `staleBeforeMs`: judging by what was live before a deploy would
// call a deploy that worked a failure. Then the caller's tick waits (`notYet`).
export async function liveFor({ d, repo, staleBeforeMs = 0 }) {
  const cache = await readLiveCache(d, repo);
  const readAt = cache ? Date.parse(cache.readAt) : -Infinity;
  if (readAt >= staleBeforeMs && d.now() - readAt < d.liveCacheMs) return cache;
  const fresh = await refreshLiveCache({ d, repo });
  if (fresh) return fresh;
  const current = await readLiveCache(d, repo);
  if (current && Date.parse(current.readAt) >= staleBeforeMs) return current;
  const why = current ? 'is being read again after a deploy' : 'has not been read yet';
  throw Object.assign(new Error(`what is live in ${repo} ${why}; waiting for it`), { notYet: true });
}

// Whether `sha` has `ancestor` in its history. A commit the mirror lacks (main's newest, deployed by
// another land since this one fetched) is fetched for once.
export async function contains({ d, repo, mirror, ancestor, sha }) {
  if (!(await hasCommit(mirror, sha))) await syncMirror({ repo, d });
  if (!(await hasCommit(mirror, sha)) || !(await hasCommit(mirror, ancestor))) return false;
  return isAncestor(mirror, ancestor, sha);
}

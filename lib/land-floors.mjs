import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hasCommit, isAncestor, mirrorPath } from './git.mjs';
import { syncMirror } from './repo.mjs';
import { iso, landDir, readJson } from './land-line.mjs';
import { writeJsonAtomic } from './shared.mjs';

// Whether `sha` has `ancestor` in its history. A commit the mirror lacks (main's newest, deployed by
// another land since this one fetched) is fetched for once.
export async function contains({ d, repo, mirror, ancestor, sha }) {
  if (!(await hasCommit(mirror, sha))) await syncMirror({ repo, d });
  if (!(await hasCommit(mirror, sha)) || !(await hasCommit(mirror, ancestor))) return false;
  return isAncestor(mirror, ancestor, sha);
}

// The floors a land recorded at its merge, one file per merge commit: a deploy of a tip carries every
// merge below it, so it must meet the newest floor among them, not only the floor of the land that
// happens to start it. Records older than a day decide nothing any more and are removed.
const floorsDir = (d, repo) => join(landDir(d, repo), 'floors');
const FLOORS_KEEP_MS = 24 * 60 * 60_000;

// Written once per merge commit: a second call (the merge commit named late, after the early write)
// leaves the first record, and its time, as it was. `headSha` names the pending record it replaces.
export async function recordFloors({ d, repo, mergeSha, floors, headSha = null }) {
  const file = join(floorsDir(d, repo), `${mergeSha}.json`);
  if (!(await readJson(file))) await writeJsonAtomic(file, { mergeSha, floors, at: iso(d) });
  if (headSha) await dropPendingFloors({ d, repo, headSha });
}

// Before the merge, a land records its floors under the head it merges: GitHub can name the merge
// commit late, and until then no deploy can tell whether its tip carries the merge. So every tip is
// held to a pending record, until the record under the merge commit replaces it or the merge is known
// not to have happened. One left behind (a land that was killed, a merge commit never named) holds
// every deploy of the repository to its floors until it is a day old: stricter, never looser.
const pendingFile = (d, repo, headSha) => join(floorsDir(d, repo), `pending-${headSha}.json`);

export async function recordPendingFloors({ d, repo, headSha, floors }) {
  await writeJsonAtomic(pendingFile(d, repo, headSha), { headSha, pending: true, floors, at: iso(d) });
}

export async function dropPendingFloors({ d, repo, headSha }) {
  await rm(pendingFile(d, repo, headSha), { force: true });
}

// Per required repository, the newest floor among the recorded merges that `tip` carries, every
// pending record, and this land's own (`own`, when the caller has one not recorded yet). Newest is
// the one the others are ancestors of; floors that diverge (a force-push) go to the later record, so
// the pick is the same whichever land looks.
export async function combinedFloors({ d, repo, tip, mirror, own = null }) {
  const dir = floorsDir(d, repo);
  const now = (d.now ?? Date.now)();
  const records = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const rec = await readJson(join(dir, name));
    if (!rec) continue;
    if (now - Date.parse(rec.at) > FLOORS_KEEP_MS) await rm(join(dir, name), { force: true });
    else records.push(rec);
  }
  if (own && !records.some((x) => x.mergeSha === own.mergeSha)) records.push({ ...own, at: iso(d) });
  records.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const out = {};
  for (const rec of records) {
    if (!rec.pending && !(await contains({ d, repo, mirror, ancestor: rec.mergeSha, sha: tip }))) continue;
    for (const [req, floor] of Object.entries(rec.floors ?? {})) {
      if (!floor) continue;
      if (!out[req] || !(await contains({ d, repo: req, mirror: mirrorPath(req, d.mirrorRoot), ancestor: floor, sha: out[req] }))) out[req] = floor;
    }
  }
  return out;
}

// The hook ship land's runner gives `runDeploy`: the combined floors for the deploy's actual target,
// whatever main has become since the land decided. `fallback` (the floors the deploy was started
// with) stands for a required repository with no record, so a lost record cannot loosen the gate.
export const floorsAtFor = ({ d, repo, fallback = {} }) => async (sha) => ({
  ...fallback,
  ...(await combinedFloors({ d, repo, tip: sha, mirror: mirrorPath(repo, d.mirrorRoot) })),
});

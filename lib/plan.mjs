import { resolveLive } from './live.mjs';
import { changedFiles, hasCommit, isAncestor } from './git.mjs';
import { pendingFile } from './glob.mjs';
import { readHold } from './state.mjs';
import { deployOrder, dependentsOf } from './order.mjs';
import { importsOutside } from './imports.mjs';
import { timeOr } from './report.mjs';

export const ICON = { live: '✓', deployed: '✓', 'dry-run': '·', pending: '·', held: '!', blocked: '✗', skipped: '!', failed: '✗', 'rolled-back': '✗', stuck: '✗' };
const SHOWN_IMPORTS = 5;
const STOPS = new Set(['held', 'blocked', 'failed', 'rolled-back', 'stuck']);

const heldFields = (hold) => ({ status: 'held', reason: `held since ${timeOr(hold.at)}: ${hold.reason}`, hold });

async function planOne({ r, dep, selected, target, cf, stateRoot, wt, redeploy, docsOnly }) {
  const [hold, deployments, versions] = await Promise.all([readHold(stateRoot, r.repo, dep.name), cf.deployments(dep.worker), cf.versions(dep.worker)]);
  const live = resolveLive({ deployments, versions });
  const e = { dep, selected: selected.has(dep.name), status: 'pending', reason: '', live, files: [], history: { deployments, versions } };
  if (hold) {
    return { ...e, ...heldFields(hold) };
  }
  if (wt && e.selected) {
    const outside = await importsOutside(wt, dep, docsOnly);
    if (outside.length > 0) {
      const shown = outside.slice(0, SHOWN_IMPORTS).map((o) => `${o.from} → ${o.to}`).join(', ');
      const more = outside.length > SHOWN_IMPORTS ? ` and ${outside.length - SHOWN_IMPORTS} more` : '';
      return { ...e, status: 'blocked', reason: `imports files outside its paths: ${shown}${more} — add them to its paths in ship.config.mjs` };
    }
  }
  // The one block that can clear by itself: a split deployment during a rollout reads as unknown.
  if (live.state === 'unknown') return { ...e, status: 'blocked', transient: true, reason: `live unknown (${live.reason}); the owner runs: ship adopt --at <sha> ${dep.name}` };
  if (live.state === 'none') return { ...e, reason: 'first deploy' };
  const short = live.sha.slice(0, 7);
  if (!(await hasCommit(r.mirror, live.sha))) return { ...e, status: 'blocked', reason: `live commit ${short} is not in ${r.repo}` };
  if (!(await isAncestor(r.mirror, live.sha, target))) {
    return { ...e, status: 'blocked', reason: `live ${short} is not an ancestor of ${r.mainBranch}: code that is not on ${r.mainBranch} is deployed` };
  }
  const files = (await changedFiles(r.mirror, live.sha, target)).filter(pendingFile(dep, docsOnly));
  if (files.length === 0 && redeploy.has(dep.name)) return { ...e, reason: `redeploy of ${short} requested` };
  if (files.length === 0) return { ...e, status: 'live', reason: `already live (${short})` };
  return { ...e, files, reason: `${files.length} changed file(s) since ${short}` };
}

export async function planDeploy({ r, config, selected, target, cf, stateRoot, wt = null, redeploy = new Set() }) {
  const entries = await Promise.all(deployOrder(config.deployables).map((dep) =>
    planOne({ r, dep, selected, target, cf, stateRoot, wt, redeploy, docsOnly: config.docsOnly })));
  return propagate(entries, config.deployables);
}

// A plan is made before a deploy waits for its turn; a hold written meanwhile stops that deployable
// (and what waits for it) all the same. Returns the entries that were pending and are held now.
export async function recheckHolds({ entries, deployables, stateRoot, repo }) {
  const stopped = [];
  for (const e of entries) {
    if (!e.selected || e.status !== 'pending') continue;
    const hold = await readHold(stateRoot, repo, e.dep.name);
    if (!hold) continue;
    Object.assign(e, heldFields(hold));
    stopped.push(e);
  }
  propagate(entries, deployables);
  return stopped;
}

// Entries are in deploy order, so a dependency is settled before its dependents are looked at.
export function propagate(entries, deployables) {
  const byName = new Map(entries.map((e) => [e.dep.name, e]));
  for (const e of entries) {
    const unselectedPending = e.status === 'pending' && !e.selected;
    if (!STOPS.has(e.status) && !unselectedPending) continue;
    const why = unselectedPending ? `${e.dep.name} has undeployed changes; deploy it too (ship deploy ${e.dep.name} …)` : `waits for ${e.dep.name} (${e.status})`;
    for (const name of dependentsOf(deployables, e.dep.name)) {
      const x = byName.get(name);
      if (x?.status === 'pending') {
        x.status = 'skipped';
        x.reason = why;
      }
    }
  }
  return entries;
}

import { resolveLive } from './live.mjs';
import { changedFiles, hasCommit, isAncestor } from './git.mjs';
import { matchesAny } from './glob.mjs';
import { readHold } from './state.mjs';
import { deployOrder, dependentsOf } from './order.mjs';
import { importsOutside } from './imports.mjs';

export const ICON = { live: '✓', deployed: '✓', 'dry-run': '·', pending: '·', held: '!', blocked: '✗', skipped: '!', failed: '✗', 'rolled-back': '✗', stuck: '✗' };
const STOPS = new Set(['held', 'blocked', 'failed', 'rolled-back', 'stuck']);

async function planOne({ r, dep, selected, target, cf, stateRoot, wt, redeploy, docsOnly }) {
  const [hold, deployments, versions] = await Promise.all([readHold(stateRoot, r.repo, dep.name), cf.deployments(dep.worker), cf.versions(dep.worker)]);
  const live = resolveLive({ deployments, versions });
  const e = { dep, selected: selected.has(dep.name), status: 'pending', reason: '', live, files: [], history: { deployments, versions } };
  if (hold) return { ...e, status: 'held', reason: `held since ${hold.at ?? '?'}: ${hold.reason}`, hold };
  if (wt && e.selected) {
    const outside = await importsOutside(wt, dep);
    if (outside.length > 0) {
      return { ...e, status: 'blocked', reason: `imports files outside its paths: ${outside.slice(0, 5).map((o) => `${o.from} → ${o.to}`).join(', ')} — add them to its paths in ship.config.mjs` };
    }
  }
  if (live.state === 'unknown') return { ...e, status: 'blocked', reason: `live unknown (${live.reason}); the owner runs: ship adopt --at <sha> ${dep.name}` };
  if (live.state === 'none') return { ...e, reason: 'first deploy' };
  const short = live.sha.slice(0, 7);
  if (!(await hasCommit(r.mirror, live.sha))) return { ...e, status: 'blocked', reason: `live commit ${short} is not in ${r.repo}` };
  if (!(await isAncestor(r.mirror, live.sha, target))) {
    return { ...e, status: 'blocked', reason: `live ${short} is not an ancestor of ${r.mainBranch}: code that is not on ${r.mainBranch} is deployed` };
  }
  const files = (await changedFiles(r.mirror, live.sha, target))
    .filter((f) => matchesAny(f, dep.paths) && !matchesAny(f, dep.ignore) && !matchesAny(f, docsOnly));
  if (files.length === 0 && redeploy.has(dep.name)) return { ...e, reason: `redeploy of ${short} requested` };
  if (files.length === 0) return { ...e, status: 'live', reason: `already live (${short})` };
  return { ...e, files, reason: `${files.length} changed file(s) since ${short}` };
}

export async function planDeploy({ r, config, selected, target, cf, stateRoot, wt = null, redeploy = new Set() }) {
  const entries = await Promise.all(deployOrder(config.deployables).map((dep) =>
    planOne({ r, dep, selected, target, cf, stateRoot, wt, redeploy, docsOnly: config.docsOnly })));
  return propagate(entries, config.deployables);
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

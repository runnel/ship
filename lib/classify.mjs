import { matchesAny } from './glob.mjs';

// Changes to CI definitions or to the gate's own config are checked with everything.
const SELECT_ALL = ['.github/**', 'ship.config.mjs'];

export function classify(files, config) {
  const remaining = files.filter((f) => !matchesAny(f, config.docsOnly));
  if (remaining.length === 0) return { docsOnly: true, groups: [], reasons: {} };

  const all = config.checks.map((c) => c.name);
  const selected = new Set();
  const reasons = {};
  for (const f of remaining) {
    if (matchesAny(f, SELECT_ALL)) {
      all.forEach((n) => selected.add(n));
      reasons[f] = 'all';
      continue;
    }
    const hits = config.checks.filter((c) => matchesAny(f, c.paths)).map((c) => c.name);
    if (hits.length === 0) {
      // Safe default: a file nobody claimed (e.g. a root package.json) gets every check.
      all.forEach((n) => selected.add(n));
      reasons[f] = 'unmatched -> all';
      continue;
    }
    hits.forEach((n) => selected.add(n));
    reasons[f] = hits.join(',');
  }
  // Config order: a group listed first (e.g. one that installs dependencies) runs first.
  return { docsOnly: false, groups: all.filter((n) => selected.has(n)), reasons };
}

export function laneFor(groups, config) {
  return config.checks.some((c) => groups.includes(c.name) && c.lane === 'heavy') ? 'heavy' : 'light';
}

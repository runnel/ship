import { basename } from 'node:path';

// Numbered migrations run in prefix order, so two files with one prefix are a collision whatever
// their names. A file without a leading `<digits>_` is not numbered and never clashes.
export function migrationPrefix(path) {
  return basename(path).match(/^(\d+)_/)?.[1] ?? null;
}

export function prefixClashes({ ours, others }) {
  const wanted = new Set(ours.map(migrationPrefix).filter(Boolean));
  const out = [];
  for (const pr of others) {
    for (const file of pr.files) {
      const prefix = migrationPrefix(file);
      if (prefix && wanted.has(prefix)) out.push({ prefix, number: pr.number, file });
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

// How the migrations on main stand in the ledger, for `ship status`: the ones ship applied and then
// proved from the database, and the ones that were only acked (the owner's word, never checked).
// `clearances` is state.readClearances; a file that is not in it is not cleared and not counted.
export function clearanceLines(migrations, clearances, { show = 3, time = String } = {}) {
  const cleared = migrations.filter((f) => clearances.has(f)).sort((a, b) => basename(a).localeCompare(basename(b)));
  const proven = cleared.filter((f) => clearances.get(f).kind === 'applied');
  const bare = cleared.filter((f) => clearances.get(f).kind !== 'applied');
  const out = [`  proof: ${proven.length} applied and proven by ship, ${bare.length} acked only (never checked against the database)`];
  if (proven.length > 0) {
    out.push(`  newest proven: ${proven.slice(-show).reverse().map((f) => {
      const c = clearances.get(f);
      return `${basename(f)} (${c.checks} post-conditions, ${c.by ?? '?'}, ${time(c.at)})`;
    }).join(', ')}`);
  }
  if (bare.length > 0) out.push(`  newest acked only: ${bare.slice(-show).reverse().map((f) => `${basename(f)} (acked ${time(clearances.get(f).at)})`).join(', ')}`);
  return out;
}

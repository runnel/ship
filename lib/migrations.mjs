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

// Migration paths in number order; files without a number sort by name after the numbered ones.
export function byNumber(a, b) {
  const pa = migrationPrefix(a);
  const pb = migrationPrefix(b);
  if (pa !== null && pb !== null) {
    const [x, y] = [BigInt(pa), BigInt(pb)];
    return x < y ? -1 : x > y ? 1 : basename(a).localeCompare(basename(b));
  }
  return pa !== null ? -1 : pb !== null ? 1 : basename(a).localeCompare(basename(b));
}

// How the migrations on main stand in the ledger, for `ship status`: the ones ship applied and
// proved from the database, the ones it found already in place and recorded, and the ones that were
// only acked (the owner's word, never checked). `clearances` is state.readClearances; a file that is
// not in it is not cleared and not counted.
export function clearanceLines(migrations, clearances, { show = 3, time = String } = {}) {
  const cleared = migrations.filter((f) => clearances.has(f)).sort(byNumber);
  const of = (kind) => cleared.filter((f) => clearances.get(f).kind === kind);
  const [applied, verified, bare] = [of('applied'), of('verified'), of('ack')];
  const newest = (files, describe) => files.slice(-show).reverse().map(describe).join(', ');
  const proof = (f) => {
    const c = clearances.get(f);
    return `${basename(f)} (${c.checks} post-conditions, ${c.by ?? '?'}, ${time(c.at)})`;
  };
  const out = [`  proof: ${applied.length} applied and proven by ship, ${verified.length} found in place and recorded, ${bare.length} acked only (never checked against the database)`];
  if (applied.length > 0) out.push(`  newest applied: ${newest(applied, proof)}`);
  if (verified.length > 0) out.push(`  newest found in place: ${newest(verified, proof)}`);
  if (bare.length > 0) out.push(`  newest acked only: ${newest(bare, (f) => `${basename(f)} (acked ${time(clearances.get(f).at)})`)}`);
  return out;
}

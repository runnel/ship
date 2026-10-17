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

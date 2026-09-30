import { stripComments } from './imports.mjs';

// Settings a versioned upload + promote never applies. State keys have a value on the Worker that
// can be read back and compared; config keys are compared as config text.
export const STATE_KEYS = ['triggers', 'workers_dev', 'preview_urls'];
export const CONFIG_KEYS = ['routes', 'route', 'migrations', 'logpush', 'tail_consumers', 'streaming_tail_consumers', 'observability'];
export const NON_VERSIONED = [...STATE_KEYS, ...CONFIG_KEYS];
export const WRANGLER_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

const empty = () => Object.fromEntries(NON_VERSIONED.map((k) => [k, '']));
const parseJsonc = (text) => JSON.parse(stripComments(text).replace(/,(\s*[}\]])/g, '$1'));

function fromJson(text) {
  const obj = parseJsonc(text);
  const out = empty();
  for (const k of NON_VERSIONED) out[k] = obj[k] === undefined ? '' : JSON.stringify(obj[k]);
  return out;
}

// `#` starts a comment outside quotes.
function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

// Per key, the normalised text of its top-level key line (a multi-line array continued until its
// brackets balance) or of its [table] / [[array-of-tables]] blocks. A dotted header such as
// [observability.logs] belongs to its first segment.
function fromToml(text) {
  const out = empty();
  const lines = text.split('\n').map((l) => stripTomlComment(l).trim()).filter(Boolean);
  let table = null; // null = top level
  let open = null; // key whose multi-line value is being read
  let depth = 0;
  const count = (line, ch) => (line.match(new RegExp(`\\${ch}`, 'g')) ?? []).length;
  const add = (key, line) => { out[key] += `${line}\n`; };
  for (const line of lines) {
    if (open) {
      add(open, line);
      depth += count(line, '[') - count(line, ']');
      if (depth <= 0) open = null;
      continue;
    }
    const header = line.match(/^\[\[?\s*([^\]\s]+)\s*\]\]?$/);
    if (header) {
      table = header[1].split('.')[0];
      if (NON_VERSIONED.includes(table)) add(table, line);
      continue;
    }
    if (table === null) {
      const key = line.match(/^([A-Za-z_]+)\s*=/)?.[1];
      if (key && NON_VERSIONED.includes(key)) {
        add(key, line);
        depth = count(line, '[') - count(line, ']');
        if (depth > 0) open = key;
      }
    } else if (NON_VERSIONED.includes(table)) {
      add(table, line);
    }
  }
  return out;
}

export function nonVersionedSettings(text, fileName) {
  if (text == null) return empty();
  return fileName.endsWith('.toml') ? fromToml(text) : fromJson(text);
}

export function changedSettings(before, after, fileName, keys = NON_VERSIONED) {
  const a = nonVersionedSettings(before, fileName);
  const b = nonVersionedSettings(after, fileName);
  return keys.filter((k) => a[k] !== b[k]);
}

// What the Worker's state keys should be under this config: explicit values, else wrangler's
// defaults (workers.dev on unless routes are listed; previews follow workers.dev). crons is null
// when the config does not list any (wrangler then leaves the Worker's schedules alone).
export function expectedState(text, fileName) {
  let workersDev = null;
  let previewUrls = null;
  let crons = null;
  let hasRoutes = false;
  if (fileName.endsWith('.toml')) {
    const s = fromToml(text);
    const bool = (t) => (/=\s*true\b/.test(t) ? true : /=\s*false\b/.test(t) ? false : null);
    if (s.workers_dev) workersDev = bool(s.workers_dev);
    if (s.preview_urls) previewUrls = bool(s.preview_urls);
    const m = s.triggers.match(/crons\s*=\s*\[([\s\S]*?)\]/);
    if (m) crons = [...m[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2]);
    hasRoutes = Boolean(s.routes || s.route);
  } else {
    const o = parseJsonc(text);
    if (typeof o.workers_dev === 'boolean') workersDev = o.workers_dev;
    if (typeof o.preview_urls === 'boolean') previewUrls = o.preview_urls;
    if (Array.isArray(o.triggers?.crons)) crons = o.triggers.crons;
    hasRoutes = Boolean(o.route || (Array.isArray(o.routes) && o.routes.length > 0));
  }
  const dev = workersDev ?? !hasRoutes;
  return { workersDev: dev, previewUrls: previewUrls ?? dev, crons };
}

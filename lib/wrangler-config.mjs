import { stripComments } from './imports.mjs';

// Settings a versioned upload + promote never applies. State keys have a value on the Worker that
// can be read back and compared; config keys are compared as config text.
export const STATE_KEYS = ['triggers', 'workers_dev', 'preview_urls'];
export const CONFIG_KEYS = ['routes', 'route', 'migrations', 'logpush', 'tail_consumers', 'streaming_tail_consumers', 'observability'];
export const NON_VERSIONED = [...STATE_KEYS, ...CONFIG_KEYS];
// In the order wrangler itself looks for its config.
export const WRANGLER_FILES = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'];

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

// A TOML key path: bare or quoted parts joined by dots, with optional spaces around the dots.
const KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const KEY_PATH = String.raw`${KEY_PART}(?:\s*\.\s*${KEY_PART})*`;
const HEADER = new RegExp(String.raw`^(?:\[\[\s*(${KEY_PATH})\s*\]\]|\[\s*(${KEY_PATH})\s*\])$`);
const KEY_LINE = new RegExp(String.raw`^(${KEY_PATH})\s*=`);
const FIRST_PART = new RegExp(`^(${KEY_PART})`);

// The first segment of a key path, unquoted: `"observability" . logs` -> observability.
const firstSegment = (path) => {
  const part = path.match(FIRST_PART)[1];
  return /^["']/.test(part) ? part.slice(1, -1) : part;
};

// Net change in bracket depth along one line, ignoring brackets inside strings.
function bracketDepth(line) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\' && quote === '"') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return depth;
}

// Per key, the normalised text of its top-level key lines (a multi-line array continued until its
// brackets balance) or of its [table] / [[array-of-tables]] blocks. A dotted or quoted key or header
// belongs to its first segment: `observability.enabled = true`, `["observability"]` and
// `[observability . logs]` all count as `observability`. A line that opens with `[` but is not a
// header is an error, never text attributed to another table.
function fromToml(text) {
  const out = empty();
  const lines = text.split('\n').map((l) => stripTomlComment(l).trim()).filter(Boolean);
  let table = null; // null = top level
  let sink = null; // setting the multi-line value being read belongs to, if any
  let depth = 0; // open brackets of that value
  const add = (key, line) => { if (key) out[key] += `${line}\n`; };
  const versioned = (key) => (NON_VERSIONED.includes(key) ? key : null);
  for (const line of lines) {
    if (depth > 0) {
      add(sink, line);
      depth += bracketDepth(line);
      continue;
    }
    if (line.startsWith('[')) {
      const header = line.match(HEADER);
      if (!header) throw new Error(`unparseable TOML table header: ${line}`);
      table = firstSegment(header[1] ?? header[2]);
      add(versioned(table), line);
      continue;
    }
    const key = line.match(KEY_LINE);
    sink = table === null ? (key ? versioned(firstSegment(key[1])) : null) : versioned(table);
    add(sink, line);
    if (key) depth = Math.max(0, bracketDepth(line));
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
    const m = s.triggers.match(/["']?crons["']?\s*=\s*\[([\s\S]*?)\]/);
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

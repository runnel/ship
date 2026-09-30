import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
import { matchesAny } from './glob.mjs';

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.open-next', '.wrangler', 'dist']);
const SUFFIXES = [
  '', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.jsx', '.cjs',
  '/index.ts', '/index.tsx', '/index.mts', '/index.cts', '/index.js', '/index.mjs', '/index.jsx', '/index.cjs',
];
// A specifier written with a JavaScript extension may be a TypeScript source (NodeNext style).
const TS_SOURCE_OF = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts', '.jsx': '.tsx' };
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}(?:\/[^'"\n]*)?)\1/gm;

// Blanks // and /* */ comments; string and template literals are copied as they are.
export function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export const relativeSpecifiers = (src) => [...src.matchAll(SPEC)].map((m) => m[2]);

const posix = (p) => p.split(sep).join('/');
const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);

async function* sources(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (e.isFile() && SOURCE.test(e.name)) yield p;
  }
}

async function resolveSpecifier(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  const ext = extname(base);
  const candidates = SUFFIXES.map((s) => base + s);
  if (TS_SOURCE_OF[ext]) candidates.splice(1, 0, base.slice(0, -ext.length) + TS_SOURCE_OF[ext]);
  for (const c of candidates) if (await isFile(c)) return c;
  return null;
}

// Relative imports of a deployable's sources that leave what the deploy plan watches: files outside
// its `paths`, and files inside them that a change to would not make it pending (`ignore`, and the
// repo's `docsOnly`), which is as good as outside.
export async function importsOutside(root, deployable, docsOnly = []) {
  const rel = (abs) => posix(relative(root, abs));
  const unwatched = (to) => to.startsWith('../') || !matchesAny(to, deployable.paths) || matchesAny(to, deployable.ignore ?? []) || matchesAny(to, docsOnly);
  const queue = [];
  for await (const f of sources(join(root, deployable.cwd))) if (matchesAny(rel(f), deployable.paths)) queue.push(f);
  const seen = new Set(queue);
  const outside = [];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const spec of relativeSpecifiers(stripComments(await readFile(file, 'utf8')))) {
      const target = await resolveSpecifier(file, spec);
      if (!target) continue;
      const to = rel(target);
      if (unwatched(to)) {
        outside.push({ from: rel(file), to });
      } else if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return outside;
}

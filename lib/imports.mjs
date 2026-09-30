import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { matchesAny } from './glob.mjs';

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.open-next', '.wrangler', 'dist']);
const SUFFIXES = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"\n]*)\1/gm;

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
  for (const s of SUFFIXES) if (await isFile(base + s)) return base + s;
  return null;
}

export async function importsOutside(root, deployable) {
  const rel = (abs) => posix(relative(root, abs));
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
      if (to.startsWith('../') || !matchesAny(to, deployable.paths)) {
        outside.push({ from: rel(file), to });
      } else if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return outside;
}

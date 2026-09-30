// Minimal glob -> RegExp: `**`, `*`, `?` and literal characters. Paths use '/'.
// Globs are anchored at the repository root, so '*.md' matches 'README.md' but not 'docs/a.md'.
const cache = new Map();

export function globToRegExp(glob) {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // '**/' = zero or more directories
          i += 2;
        } else {
          re += '.*'; // trailing '**' = everything below
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const compiled = new RegExp(re + '$');
  cache.set(glob, compiled);
  return compiled;
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

// A file whose change makes a deployable pending: inside its paths, not ignored, not docs-only.
export const pendingFile = (dep, docsOnly = []) => (f) => matchesAny(f, dep.paths) && !matchesAny(f, dep.ignore ?? []) && !matchesAny(f, docsOnly);

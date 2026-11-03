import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { changedFiles, showFile } from './git.mjs';
import { loadConfigSource } from './config.mjs';
import { runGroups } from './shared.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// { <group>: { NAME: value } } with `{root}` in a value replaced by the checkout; null when `parsed` is not that.
function expandEnv(parsed, root) {
  if (!isObject(parsed) || !Object.values(parsed).every((g) => isObject(g) && Object.values(g).every((v) => typeof v === 'string'))) return null;
  return Object.fromEntries(Object.entries(parsed).map(([group, vars]) => [group, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.replaceAll('{root}', root)]))]));
}

// What a run on a remote machine executes (docs/overflow.md, "Overflow to GitHub Actions" and "Overflow to
// Cloudflare Workers Builds"): the named groups of the config on main, by the same code a check uses
// here, on the merged tree in `cwd`. It posts nothing: the only answer it gives is its exit code. 0
// passed, 1 failed, 2 the arguments do not fit that config.
// The config is main's in the clone's history and the changed files are the difference between main
// and the head. A shallow clone has neither, so the caller can hand over the config (`configFile`), the
// changed files, one per line (`filesFile`), and variables per group (`envFile`, a JSON object).
export async function runGroupsHere({ cwd, groups, mainSha, headSha, configFile = null, filesFile = null, envFile = null, logFile = join(process.env.RUNNER_TEMP ?? tmpdir(), 'ship-groups.log'), out = (l) => process.stdout.write(`${l}\n`) }) {
  const gitDir = join(cwd, '.git');
  let source = null;
  let files = null;
  let handedEnv = {};
  try {
    if (configFile) source = await readFile(configFile, 'utf8');
    if (filesFile) files = (await readFile(filesFile, 'utf8')).split('\n').filter(Boolean);
    if (envFile) handedEnv = JSON.parse(await readFile(envFile, 'utf8'));
  } catch (e) {
    out(`✗ cannot read what was handed over: ${e.path ?? e.message}`);
    return 2;
  }
  source ??= await showFile(gitDir, mainSha, 'ship.config.mjs');
  if (!source) { out(`✗ no ship.config.mjs on ${mainSha}`); return 2; }
  const config = await loadConfigSource(source, { root: cwd });
  const unknown = groups.filter((g) => !config.checks.some((c) => c.name === g));
  if (groups.length === 0 || unknown.length > 0) { out(`✗ not check groups of that config: ${unknown.join(', ') || '(none given)'}`); return 2; }
  const extraEnv = expandEnv(handedEnv, resolve(cwd));
  const strange = Object.keys(extraEnv ?? {}).filter((g) => !config.checks.some((c) => c.name === g));
  if (!extraEnv || strange.length > 0) { out(`✗ ${envFile} must map check groups of that config to { "NAME": "value" }${strange.length ? ` (not groups: ${strange.join(', ')})` : ''}`); return 2; }
  const r = await runGroups({ config, groups, root: cwd, files: files ?? await changedFiles(gitDir, mainSha, headSha), logFile, out, extraEnv });
  return r.ok ? 0 : 1;
}

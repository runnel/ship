import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export class ConfigError extends Error {}

const TOP_KEYS = new Set(['repo', 'mainBranch', 'docsOnly', 'checks', 'deployables', 'migrations', 'requires', 'credentials', 'runtime']);
const CHECK_KEYS = new Set(['name', 'lane', 'paths', 'cwd', 'install', 'env', 'stubEnv', 'steps', 'timeoutMin', 'onDeploy']);
const LANES = new Set(['heavy', 'light']);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

function normaliseStep(s) {
  if (typeof s === 'string') return { run: s, env: {} };
  if (s && typeof s === 'object' && typeof s.run === 'string') return { run: s.run, env: s.env ?? {} };
  return null;
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new ConfigError('config must export an object');
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) throw new ConfigError(`unknown key: ${k}`);
  if (typeof raw.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(raw.repo)) throw new ConfigError('repo must be "owner/name"');
  const docsOnly = raw.docsOnly ?? [];
  if (!isStringArray(docsOnly)) throw new ConfigError('docsOnly must be an array of globs');
  const deployables = raw.deployables ?? [];
  if (!Array.isArray(deployables)) throw new ConfigError('deployables must be an array');
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) throw new ConfigError('checks must be a non-empty array');

  const names = new Set();
  const checks = raw.checks.map((c) => {
    for (const k of Object.keys(c)) if (!CHECK_KEYS.has(k)) throw new ConfigError(`check ${c.name ?? '?'}: unknown key ${k}`);
    if (typeof c.name !== 'string' || !c.name) throw new ConfigError('every check needs a name');
    if (names.has(c.name)) throw new ConfigError(`duplicate check name: ${c.name}`);
    names.add(c.name);
    const lane = c.lane ?? 'light';
    if (!LANES.has(lane)) throw new ConfigError(`check ${c.name}: lane must be "heavy" or "light"`);
    if (!isStringArray(c.paths) || c.paths.length === 0) throw new ConfigError(`check ${c.name}: paths must be a non-empty array of globs`);
    const steps = Array.isArray(c.steps) ? c.steps.map(normaliseStep) : [];
    if (steps.length === 0 || steps.includes(null)) throw new ConfigError(`check ${c.name}: steps must be a non-empty array of commands or { run, env }`);
    const timeoutMin = c.timeoutMin ?? 30;
    if (typeof timeoutMin !== 'number' || !(timeoutMin > 0)) throw new ConfigError(`check ${c.name}: timeoutMin must be a positive number`);
    return {
      name: c.name,
      lane,
      paths: c.paths,
      cwd: c.cwd ?? '.',
      install: c.install ?? null,
      env: c.env ?? {},
      stubEnv: c.stubEnv ?? {},
      steps,
      timeoutMin,
      onDeploy: Boolean(c.onDeploy),
    };
  });

  return {
    repo: raw.repo,
    mainBranch: raw.mainBranch ?? 'main',
    docsOnly,
    checks,
    deployables,
    migrations: raw.migrations ?? null,
    requires: raw.requires ?? [],
    credentials: raw.credentials ?? null,
    runtime: raw.runtime ?? {},
  };
}

// `source` is the text of a ship.config.mjs (read from git, not from disk, so the gate comes
// from the base branch). It is written to a private temp file and imported from there.
export async function loadConfigSource(source, { root }) {
  const dir = await mkdtemp(join(tmpdir(), 'ship-config-'));
  const file = join(dir, 'ship.config.mjs');
  try {
    await writeFile(file, source);
    const mod = await import(pathToFileURL(file).href);
    const exported = mod.default;
    const raw = typeof exported === 'function' ? await exported({ root }) : exported;
    return validateConfig(raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

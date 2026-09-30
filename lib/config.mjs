import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deployOrder } from './order.mjs';

export class ConfigError extends Error {}

const TOP_KEYS = new Set(['repo', 'mainBranch', 'docsOnly', 'checks', 'deploySetup', 'deployables', 'migrations', 'requires', 'credentials', 'runtime']);
const CHECK_KEYS = new Set(['name', 'lane', 'paths', 'cwd', 'install', 'env', 'stubEnv', 'steps', 'timeoutMin', 'onDeploy']);
const LANES = new Set(['heavy', 'light']);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

function normaliseStep(s) {
  if (typeof s === 'string') return { run: s, env: {} };
  if (s && typeof s === 'object' && typeof s.run === 'string') return { run: s.run, env: s.env ?? {} };
  return null;
}

const DEPLOYABLE_KEYS = new Set(['name', 'adapter', 'worker', 'cwd', 'paths', 'ignore', 'mode', 'install', 'build', 'env', 'envFiles',
  'bundleCheck', 'wrangler', 'wranglerConfig', 'preDeploy', 'probes', 'liveHost', 'warmup', 'liveMarker', 'after', 'timeoutMin', 'uploadTimeoutMin']);
const PROBE_KEYS = new Set(['path', 'status', 'method', 'followRedirects']);
const METHODS = new Set(['GET', 'HEAD', 'POST']);
const MODES = new Set(['versioned', 'direct']);
export const DEPLOYABLE_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRelPath = (p) => typeof p === 'string' && p.length > 0 && !isAbsolute(p) && !p.split('/').includes('..');
const isStringMap = (v) => isObject(v) && Object.values(v).every((x) => typeof x === 'string');
const positive = (v, dflt, what) => {
  const n = v ?? dflt;
  if (typeof n !== 'number' || !(n > 0)) throw new ConfigError(`${what} must be a positive number`);
  return n;
};

// Steps of deploySetup/preDeploy may also name a cwd (relative to the worktree / deployable cwd).
function normaliseDeployStep(s, where) {
  if (typeof s === 'string') return { run: s, env: {}, cwd: null };
  if (isObject(s) && typeof s.run === 'string' && Object.keys(s).every((k) => ['run', 'env', 'cwd'].includes(k))
      && (s.env === undefined || isStringMap(s.env)) && (s.cwd == null || isRelPath(s.cwd))) {
    return { run: s.run, env: s.env ?? {}, cwd: s.cwd ?? null };
  }
  throw new ConfigError(`${where}: steps must be commands or { run, env, cwd } with a relative cwd`);
}

function normaliseProbe(p, where) {
  if (!isObject(p)) throw new ConfigError(`${where}: probes must be objects`);
  for (const k of Object.keys(p)) if (!PROBE_KEYS.has(k)) throw new ConfigError(`${where}: unknown probe key ${k}`);
  if (typeof p.path !== 'string' || !p.path.startsWith('/')) throw new ConfigError(`${where}: probe path must start with /`);
  if (!Number.isInteger(p.status) || p.status < 100 || p.status > 599) throw new ConfigError(`${where}: probe status must be an HTTP status`);
  const method = p.method ?? 'GET';
  if (!METHODS.has(method)) throw new ConfigError(`${where}: probe method must be GET, HEAD or POST`);
  return { path: p.path, status: p.status, method, followRedirects: Boolean(p.followRedirects) };
}

function normaliseDeployable(x) {
  if (!isObject(x)) throw new ConfigError('deployables must be objects');
  const where = `deployable ${x.name ?? '?'}`;
  for (const k of Object.keys(x)) if (!DEPLOYABLE_KEYS.has(k)) throw new ConfigError(`${where}: unknown key ${k}`);
  if (typeof x.name !== 'string' || !DEPLOYABLE_NAME.test(x.name)) throw new ConfigError(`deployable name must match ${DEPLOYABLE_NAME} (got ${JSON.stringify(x.name)})`);
  if ((x.adapter ?? 'workers') !== 'workers') throw new ConfigError(`${where}: adapter must be "workers"`);
  if (typeof x.worker !== 'string' || !x.worker) throw new ConfigError(`${where}: worker (the Cloudflare script name) is required`);
  if (!MODES.has(x.mode)) throw new ConfigError(`${where}: mode must be "versioned" or "direct"`);
  const cwd = x.cwd ?? '.';
  if (!isRelPath(cwd)) throw new ConfigError(`${where}: cwd must be a relative path inside the repo`);
  if (!isStringArray(x.paths) || x.paths.length === 0) throw new ConfigError(`${where}: paths must be a non-empty array of globs`);
  if (x.ignore !== undefined && !isStringArray(x.ignore)) throw new ConfigError(`${where}: ignore must be an array of globs`);
  const wrangler = x.wrangler ?? (cwd === '.' ? 'node_modules/.bin/wrangler' : `${cwd}/node_modules/.bin/wrangler`);
  if (!isRelPath(wrangler)) throw new ConfigError(`${where}: wrangler must be a path relative to the repo root`);
  if (x.wranglerConfig != null && !isRelPath(x.wranglerConfig)) throw new ConfigError(`${where}: wranglerConfig must be relative to cwd`);
  for (const k of ['install', 'build']) if (x[k] != null && typeof x[k] !== 'string') throw new ConfigError(`${where}: ${k} must be a command`);
  if (x.env !== undefined && !isStringMap(x.env)) throw new ConfigError(`${where}: env must map names to strings`);
  const envFiles = x.envFiles ?? [];
  if (!Array.isArray(envFiles) || !envFiles.every((f) => isObject(f) && typeof f.from === 'string' && isAbsolute(f.from) && isRelPath(f.to))) {
    throw new ConfigError(`${where}: envFiles must be [{ from: <absolute path>, to: <repo-relative path> }]`);
  }
  let bundleCheck = null;
  if (x.bundleCheck != null) {
    const b = x.bundleCheck;
    let ok = isObject(b) && typeof b.file === 'string' && typeof b.pattern === 'string' && isStringArray(b.allow);
    if (ok) try { new RegExp(b.pattern, 'g'); } catch { ok = false; }
    if (!ok) throw new ConfigError(`${where}: bundleCheck must be { file, pattern (a valid RegExp), allow: [strings] }`);
    bundleCheck = { file: b.file, pattern: b.pattern, allow: b.allow };
  }
  const probes = (x.probes ?? []).map((p) => normaliseProbe(p, where));
  if (x.mode === 'versioned' && probes.length === 0) throw new ConfigError(`${where}: a versioned deployable needs probes`);
  const liveHost = x.liveHost ?? null;
  if (probes.length > 0 && (typeof liveHost !== 'string' || !/^https:\/\/[^/\s]+$/.test(liveHost))) {
    throw new ConfigError(`${where}: liveHost must be https://host with no path or trailing slash`);
  }
  const warmup = x.warmup ?? [];
  if (!isStringArray(warmup) || !warmup.every((p) => p.startsWith('/'))) throw new ConfigError(`${where}: warmup must be paths starting with /`);
  let liveMarker = null;
  if (x.liveMarker != null) {
    const m = x.liveMarker;
    if (x.mode !== 'versioned') throw new ConfigError(`${where}: liveMarker is only for versioned deployables`);
    if (!isObject(m) || typeof m.path !== 'string' || !m.path.startsWith('/') || !isRelPath(m.file)) throw new ConfigError(`${where}: liveMarker must be { path: '/…', file: <relative to cwd> }`);
    liveMarker = { path: m.path, file: m.file };
  }
  const after = x.after ?? [];
  if (!isStringArray(after)) throw new ConfigError(`${where}: after must be an array of deployable names`);
  return {
    name: x.name, adapter: 'workers', worker: x.worker, cwd, paths: x.paths, ignore: x.ignore ?? [], mode: x.mode,
    install: x.install ?? null, build: x.build ?? null, env: x.env ?? {}, envFiles, bundleCheck,
    wrangler, wranglerConfig: x.wranglerConfig ?? null,
    preDeploy: (x.preDeploy ?? []).map((s) => normaliseDeployStep(s, `${where} preDeploy`)),
    probes, liveHost, warmup, liveMarker, after,
    timeoutMin: positive(x.timeoutMin, 30, `${where}: timeoutMin`),
    uploadTimeoutMin: positive(x.uploadTimeoutMin, 10, `${where}: uploadTimeoutMin`),
  };
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new ConfigError('config must export an object');
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) throw new ConfigError(`unknown key: ${k}`);
  if (typeof raw.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(raw.repo)) throw new ConfigError('repo must be "owner/name"');
  const docsOnly = raw.docsOnly ?? [];
  if (!isStringArray(docsOnly)) throw new ConfigError('docsOnly must be an array of globs');
  if (!Array.isArray(raw.deployables ?? [])) throw new ConfigError('deployables must be an array');
  const deployables = (raw.deployables ?? []).map(normaliseDeployable);
  const seen = new Set();
  for (const d of deployables) {
    if (seen.has(d.name)) throw new ConfigError(`duplicate deployable name: ${d.name}`);
    seen.add(d.name);
  }
  try { deployOrder(deployables); } catch (e) { throw new ConfigError(e.message); }
  if (!Array.isArray(raw.deploySetup ?? [])) throw new ConfigError('deploySetup must be an array');
  const deploySetup = (raw.deploySetup ?? []).map((s) => normaliseDeployStep(s, 'deploySetup'));
  const migrations = raw.migrations ?? null;
  if (migrations !== null && !(isObject(migrations) && isStringArray(migrations.paths) && migrations.paths.length > 0)) {
    throw new ConfigError('migrations must be { paths: [globs] }');
  }
  const requires = raw.requires ?? [];
  if (!Array.isArray(requires) || !requires.every((r) => isObject(r) && /^[\w.-]+\/[\w.-]+$/.test(r.repo ?? '') && typeof r.deployable === 'string')) {
    throw new ConfigError('requires must be [{ repo: "owner/name", deployable }]');
  }
  const credentials = raw.credentials ?? null;
  if (credentials !== null && !(isObject(credentials) && typeof credentials.file === 'string' && isAbsolute(credentials.file) && isStringMap(credentials.map))) {
    throw new ConfigError('credentials must be { file: <absolute path>, map: { ENV_NAME: "FILE_KEY" } }');
  }
  if (deployables.length > 0) {
    if (!credentials) throw new ConfigError('deployables need credentials');
    for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
      if (!credentials.map[k]) throw new ConfigError(`credentials.map needs ${k}`);
    }
  }
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
    deploySetup,
    deployables,
    migrations,
    requires,
    credentials,
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

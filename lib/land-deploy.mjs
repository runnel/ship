import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isStale, processStartTime, readOwner } from './lock.mjs';
import { deployDeps } from './repo.mjs';
import { REQUIRES_REFUSED, UNCLEARED, runDeploy } from './deploy.mjs';
import { firstLine, repoKeyOf } from './shared.mjs';
import { isInterrupted } from './interrupt.mjs';
import { isPid } from './proc.mjs';
import { ensurePrivateDir } from './paths.mjs';
import { iso, landDir, readJson, writeJsonAtomic } from './land-line.mjs';
import { floorsAtFor } from './land-floors.mjs';

// The deploys ship land starts, in `$SHIP_TMP/land/<owner>__<repo>/deploys/`: `<tip>-<id>.start.json`
// when one is started (its runner's process), `<tip>-<id>.end.json` when it ended (its exit code).
// `tip` is the main commit the land saw when it started it.
const deploysDir = (d, repo) => join(landDir(d, repo), 'deploys');
const RECORD_KEEP_MS = 24 * 60 * 60_000; // older records decide nothing any more: every land that saw them has ended

export async function recordDeployStart({ d, repo, id, tip, log, owner }) {
  await writeJsonAtomic(join(deploysDir(d, repo), `${tip}-${id}.start.json`), { id, tip, log, at: iso(d), ...owner });
}

export async function recordDeployEnd({ d, repo, id, tip, code, log, migrationsWaiting = false, requiresWaiting = false }) {
  await writeJsonAtomic(join(deploysDir(d, repo), `${tip}-${id}.end.json`), { id, tip, code, log, migrationsWaiting, requiresWaiting, endedAt: iso(d) });
}

// The deploys that run (started, not ended, the runner alive) and the ones that ended, oldest first.
// What can no longer matter is removed on the way: a start whose runner is gone without an end (its
// tip may simply be deployed again) and anything older than a day, so a tick's cost stays flat.
export async function readDeploys({ d, repo }) {
  const dir = deploysDir(d, repo);
  const now = (d.now ?? Date.now)();
  const drop = (name) => rm(join(dir, name), { force: true });
  const starts = [];
  const ends = new Map();
  for (const name of await readdir(dir).catch(() => [])) {
    const kind = name.endsWith('.start.json') ? 'start' : name.endsWith('.end.json') ? 'end' : null;
    const rec = kind ? await readJson(join(dir, name)) : null;
    if (!rec) continue;
    const stem = name.replace(/\.(start|end)\.json$/, '');
    if (kind === 'start') {
      starts.push({ name, stem, rec });
    } else if (now - Date.parse(rec.endedAt) > RECORD_KEEP_MS) {
      await drop(name);
      await drop(name.replace(/\.end\.json$/, '.start.json'));
    } else {
      ends.set(stem, rec);
    }
  }
  const running = [];
  for (const { name, stem, rec } of starts) {
    if (ends.has(stem)) continue;
    if (now - Date.parse(rec.at) > RECORD_KEEP_MS || (await isStale(rec))) await drop(name);
    else running.push(rec);
  }
  return { running, ended: [...ends.values()].sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt)) };
}

// A deploy of the repository is under way: one a land started, or any other that holds the deploy lock.
export async function deployRunning({ d, repo }) {
  if ((await readDeploys({ d, repo })).running.length > 0) return true;
  const owner = await readOwner(join(d.tmpRoot, 'locks', `deploy-${repoKeyOf(repo)}`));
  return Boolean(owner) && !(await isStale(owner));
}

// The runner: the ship deploy path, with the land's floor for `requires`, and a record of how it
// ended. What it prints goes to its process's stdout: the `.out` file it was started with. A deploy
// that refused because main holds a migration nobody has cleared (one merged after the land decided)
// is not a failure of the tip it was started for: the record says so, and the lands wait at the
// migration gate instead of giving up.
export async function runDetachedDeploy({ cwd, repo, tip, floors = {}, id, log, deps = {} }, injected = {}) {
  const base = { ...deployDeps(), ...deps, ...injected };
  const gate = migrationRefusal();
  const out = (line) => {
    gate.see(line);
    base.out(line);
  };
  const d = { ...base, out };
  let code;
  try {
    code = await runDeploy({ cwd, floors, floorsAt: floorsAtFor({ d: base, repo, fallback: floors }), deps: { ...deps, ...injected, out } });
  } catch (e) {
    code = e?.aborted || isInterrupted() ? 130 : 1;
    d.out(`✗ ship deploy: ${firstLine(e.message)}`);
  }
  await recordDeployEnd({ d, repo, id, tip, code, log, migrationsWaiting: code !== 0 && gate.refused(), requiresWaiting: code !== 0 && gate.requiresRefused() });
  return code;
}

// Whether a deploy's output ends in the migration gate's refusal, or in a requires refusal (a floor
// not met). Only the last `✗` line counts: a refusal replayed from a deploy this one joined, followed
// by a failure of its own, is a failure.
export function migrationRefusal() {
  let last = '';
  return {
    see(line) {
      if (line.startsWith('✗')) last = line;
    },
    refused: () => last.startsWith(UNCLEARED),
    requiresRefused: () => last.startsWith(REQUIRES_REFUSED),
  };
}

const RUNNER = `
const { runDetachedDeploy } = await import(process.argv[1]);
process.exitCode = await runDetachedDeploy(JSON.parse(process.argv[2]));
`;
// The intermediate: starts the runner in a session of its own with the `.out` file (its own stderr)
// as the runner's output, says the runner's pid on stdout and exits, so the runner's parent is init.
const STARTER = `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--input-type=module', '-e', process.argv[1], process.argv[2], process.argv[3]], {
  cwd: process.cwd(), detached: true, stdio: ['ignore', 2, 2], env: process.env,
});
child.on('error', () => process.exit(1));
child.unref();
if (!child.pid) process.exit(1);
process.stdout.write(child.pid + '\\n', () => process.exit(0));
`;
const STARTER_WAIT_MS = 30_000;
const stamp = () => `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;

// Starts the deploy in a session and process group of its own, its output in a `.out` file under the
// logs and nothing tying it to the land: a session that closes, or an interrupt of the land, cannot
// reach it in its promote step, where an interrupt leaves a hold. Not even through its parent: a
// short-lived intermediate starts the runner and exits at once, so the runner's parent is init and a
// walk down the land's process tree does not find it. It runs in $SHIP_TMP, not in the session's
// checkout, which may be removed while it deploys; the checkout is named once, for `git -C` to read
// the repository from at the start. It is ship that runs there, so it gets ship's own environment, as
// bin/ship.mjs passes it, and the land's time limits for gh and fetches; its steps get the minimal
// environment as always.
export async function startDetachedDeploy({ d, repo, cwd, tip, floors = {}, runnerUrl = import.meta.url, spawnFn = spawn }) {
  const id = randomUUID().slice(0, 8);
  await ensurePrivateDir(d.tmpRoot);
  await mkdir(d.logRoot, { recursive: true });
  const log = join(d.logRoot, `${repoKeyOf(repo)}-land-deploy-${tip.slice(0, 7)}-${stamp()}-${id}.out`);
  const deps = { tmpRoot: d.tmpRoot, mirrorRoot: d.mirrorRoot, logRoot: d.logRoot, stateRoot: d.stateRoot, gh: d.gh, ghTimeoutMs: d.ghTimeoutMs, fetchTimeoutMs: d.fetchTimeoutMs };
  const fd = openSync(log, 'a', 0o600);
  let starter;
  try {
    starter = spawnFn(process.execPath, ['--input-type=module', '-e', STARTER, RUNNER, runnerUrl, JSON.stringify({ cwd, repo, tip, floors, id, log, deps })], {
      cwd: d.tmpRoot, stdio: ['ignore', 'pipe', fd], env: { ...process.env, SHIP_GROUP_LEADER: '1' },
    });
  } finally {
    closeSync(fd);
  }
  starter.on('error', () => {}); // a failed spawn is reported below, by its missing pid
  if (!starter.pid) throw new Error('could not start the deploy runner');
  const pid = await runnerPid(starter);
  if (!isPid(pid)) throw new Error('could not start the deploy runner');
  const startTime = (await processStartTime(pid)) ?? (await processStartTime(pid));
  await recordDeployStart({ d, repo, id, tip, log, owner: { pid, pgid: pid, startTime } });
  return { id, log, pid };
}

// The runner's pid, as the intermediate reports it; null when it fails, exits non-zero, says nothing
// valid or does not finish in time.
function runnerPid(starter) {
  return new Promise((resolve) => {
    let out = '';
    const timer = setTimeout(() => { try { starter.kill('SIGKILL'); } catch { /* gone */ } resolve(null); }, STARTER_WAIT_MS);
    starter.stdout?.on('data', (b) => { out += b; });
    starter.on('error', () => { clearTimeout(timer); resolve(null); });
    starter.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && /^\d+\n$/.test(out) ? Number(out) : null);
    });
  });
}

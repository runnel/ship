import { mkdir, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquire, ownerInfo } from './lock.mjs';
import { onInterrupt, isInterrupted } from './interrupt.mjs';
import { run, buildEnv } from './proc.mjs';
import { duration, localTime } from './report.mjs';

const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const STALE_WORKTREE_MS = 12 * 60 * 60 * 1000;

export const repoKeyOf = (repo) => repo.replace('/', '__');

export const firstLine = (text) => String(text ?? '').trim().split('\n')[0];
export const once = (fn) => { let done = false; return (...a) => { if (!done) { done = true; fn(...a); } }; };
export const everyMinute = (fn) => { let last = 0; return (...a) => { if (Date.now() - last >= 60_000) { last = Date.now(); fn(...a); } }; };

// A cleanup that runs once however many ask for it: the flow's own and the interrupt's unwind share
// one promise, so whoever comes second waits for the first instead of exiting, or removing twice,
// while it is still running.
export const sharedCleanup = (fn) => {
  let promise = null;
  return () => (promise ??= Promise.resolve().then(fn));
};

export const abortedError = () => Object.assign(new Error('interrupted'), { aborted: true });

// A command line that cannot be run as given. The CLI prints the message with the command's usage
// line and exits 2; nothing has been changed when it is thrown.
export class UsageError extends Error {}

// A lock with a shared release. Not taken once the process is interrupted, and given back if it was
// won at the last moment. With `priority` the wait is a place in a line (see lock.mjs); an
// interrupt takes the place back, so a waiter that is stopped does not hold the others up. A caller's
// own `isAborted` ends the wait the same way (an error with `aborted: true`, the place given back).
export async function acquireShared(dir, owner, opts) {
  let offTicket = () => {};
  let release;
  const stopped = opts?.isAborted ?? (() => false);
  try {
    release = sharedCleanup(await acquire(dir, owner, { ...opts, isAborted: () => isInterrupted() || stopped(), onQueue: (leave) => { offTicket = onInterrupt(leave); } }));
  } finally {
    if (!isInterrupted()) offTicket(); // after an interrupt it stays, as a lock's does: the unwind may still be running it
  }
  if (isInterrupted()) {
    await release();
    throw abortedError();
  }
  return release;
}

// A lock that an interrupt releases too. After an interrupt its handler stays registered, so that
// the unwind waits for a release that is still in flight.
export async function lockWithCleanup(dir, owner, opts) {
  const release = await acquireShared(dir, owner, opts);
  const off = onInterrupt(release);
  return async () => {
    await release();
    if (!isInterrupted()) off();
  };
}

// Worktrees left by a ship that was killed outright (SIGKILL) before it could clean up.
export async function sweepWorktrees(dir) {
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir).catch(() => [])) {
    const p = join(dir, name);
    const st = await stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > STALE_WORKTREE_MS) await rm(p, { recursive: true, force: true });
  }
}

export async function newLogFile(logRoot, repo, label) {
  await mkdir(logRoot, { recursive: true });
  for (const f of await readdir(logRoot).catch(() => [])) {
    const p = join(logRoot, f);
    const st = await stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > LOG_RETENTION_MS) await rm(p, { force: true });
  }
  const stamp = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  return join(logRoot, `${repoKeyOf(repo)}-${label}-${stamp}.log`);
}

// Runs steps in order in `cwd` (a step's own `cwd` is relative to it) with an explicit
// environment; prints one line per step and, on failure, the tail and the log path. Once
// `isStopped()` is true (the caller has stopped the running command itself) no further step starts
// and nothing is printed for the one that was cut short: the result is `{ ok: false, stopped: true }`.
export async function runSteps({ label, steps, cwd, env = {}, logFile, timeoutMin = 30, out, isStopped = () => false }) {
  for (const step of steps) {
    if (isStopped()) return { ok: false, stopped: true, step };
    const r = await run(step.run, {
      cwd: step.cwd ? join(cwd, step.cwd) : cwd,
      env: buildEnv({ ...env, ...step.env }),
      logFile,
      timeoutMs: timeoutMin * 60_000,
    });
    if (isStopped()) return { ok: false, stopped: true, step };
    if (r.code !== 0) {
      out(`✗ ${label}: ${step.run} (${duration(r.durationMs)})`);
      for (const l of r.tail) out(`  ${l}`);
      out(`  log: ${logFile}`);
      return { ok: false, step };
    }
    out(`✓ ${label}: ${step.run} (${duration(r.durationMs)})`);
  }
  return { ok: true };
}

// The command that clears migration files. `ship migrations ack` takes a bare file name only while it
// is unambiguous among the migrations on main; otherwise the hint carries the path.
export function ackCommand(unacked, migrations) {
  const bare = (f) => f.split('/').pop();
  const count = new Map();
  for (const f of migrations) count.set(bare(f), (count.get(bare(f)) ?? 0) + 1);
  return `ship migrations ack ${unacked.map((f) => (count.get(bare(f)) > 1 ? f : bare(f))).join(' ')}`;
}

// Who holds a lock, for a waiting message: a check names its PR, a deploy its command.
export const holderText = (h) => `${h?.repo ?? '?'} ${h?.pr ? `PR #${h.pr}` : h?.command ?? '?'} since ${h?.since ? localTime(h.since) : '?'}`;

// Who goes first in a lane: a deploy has passed its checks, and the builds that follow hold up
// everything it is going to put live, so it goes ahead of the pull request checks that wait.
// Within one priority the line is first come, first served.
export const LANE_PRIORITY = { deploy: 0, check: 1 };

export const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')}`;

// The waiting line of a lane: said when the wait starts, whenever the place in line changes, and
// otherwise once a minute, so a wait that is moving up shows it.
export function laneWaitReporter(d, lane) {
  let said = { position: 0, at: 0 };
  return (holder, line) => {
    const position = line?.position ?? 0;
    if (position === said.position && Date.now() - said.at < 60_000) return;
    said = { position, at: Date.now() };
    const place = line ? ` (${ordinal(line.position)} in line)` : '';
    const next = line?.ahead[0];
    const who = holder ? holderText(holder) : next ? `free, next in line: ${holderText(next)}` : 'changing hands';
    d.out(`… waiting for the ${lane} lane${place}: ${who}`);
  };
}

// One slot of a machine-wide lane for the duration of fn: checks and deploy builds share them, so
// two 6 GB builds never run at once. Deploy work, so a deploy's priority unless told otherwise.
export async function withLane({ d, lane, owner, fn, priority = LANE_PRIORITY.deploy }) {
  const release = await acquireShared(join(d.tmpRoot, 'lanes', lane), await ownerInfo(owner), {
    pollMs: d.pollMs,
    priority,
    onWait: laneWaitReporter(d, lane),
  });
  const off = onInterrupt(release);
  try {
    return await fn();
  } finally {
    await release();
    if (!isInterrupted()) off();
  }
}

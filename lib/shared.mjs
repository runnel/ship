import { mkdir, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquire, ownerInfo } from './lock.mjs';
import { onInterrupt, isInterrupted } from './interrupt.mjs';
import { run, buildEnv } from './proc.mjs';
import { duration, localTime } from './report.mjs';
import { byNumber } from './migrations.mjs';

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

// A lock with a shared release. Not taken once the process is interrupted (or the caller's own
// `isAborted` is true), and given back if it was won at the last moment. With `priority` the wait is a place in a line (see lock.mjs); an
// interrupt takes the place back, so a waiter that is stopped does not hold the others up. A caller's
// own `isAborted` ends the wait the same way (an error with `aborted: true`, the place given back).
// A wait ended by `leaveWhen` answers null.
export async function acquireShared(dir, owner, opts) {
  let offTicket = () => {};
  let release;
  const stopped = opts?.isAborted ?? (() => false);
  try {
    const won = await acquire(dir, owner, { ...opts, isAborted: () => isInterrupted() || stopped(), onQueue: (leave) => { offTicket = onInterrupt(leave); } });
    release = won && sharedCleanup(won);
  } finally {
    if (!isInterrupted()) offTicket(); // after an interrupt it stays, as a lock's does: the unwind may still be running it
  }
  if (isInterrupted() || stopped()) {
    if (release) await release();
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

// The named check groups of a config, in the order given, on the tree at `root`. `files` is what the
// pull request changes. This is the one definition of "run the groups", wherever it runs:
// { ok: true }, { ok: false, name, step } for the group and step that failed, or { ok: false, stopped: true }.
export async function runGroups({ config, groups, root, files, logFile, out, isStopped = () => false }) {
  for (const name of groups) {
    const group = config.checks.find((c) => c.name === name);
    const steps = [...(group.install ? [{ run: group.install, env: {} }] : []), ...group.steps];
    const r = await runSteps({
      label: name, steps, cwd: join(root, group.cwd), logFile, timeoutMin: group.timeoutMin, out,
      env: { ...group.env, ...group.stubEnv, SHIP_CHANGED_FILES: files.join('\n') },
      isStopped,
    });
    if (r.stopped) return { ok: false, stopped: true };
    if (!r.ok) return { ok: false, name, step: r.step };
  }
  return { ok: true };
}

// How `ship migrations ack|apply` names a file: the bare file name while it is unambiguous among
// the migrations on main, otherwise the path.
const clearName = (f, migrations) => (migrations.filter((m) => m.split('/').pop() === f.split('/').pop()).length > 1 ? f : f.split('/').pop());

// The command that clears migration files (one command for any number of them).
export const ackCommand = (unacked, migrations) => `ship migrations ack ${unacked.map((f) => clearName(f, migrations)).join(' ')}`;

// The lines that tell the owner how to clear migrations. With `migrations.apply` configured the
// preferred way is `ship migrations apply`, which proves a file from the database and takes one file
// per command; `ack` stays for a file that goes after the deploy. Without it only `ack` exists.
export function clearHint(unacked, migrations, apply) {
  const ack = ackCommand(unacked, migrations);
  if (!apply) return [`  the owner applies them (or decides they go after the deploy) and runs: ${ack}`];
  return [
    `  the owner applies each in their own terminal, one command per file (applies, proves and clears), in number order:`,
    ...[...unacked].sort(byNumber).map((f) => `    ship migrations apply ${clearName(f, migrations)}`),
    `  one that goes after the deploy instead: ${ack}`,
  ];
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

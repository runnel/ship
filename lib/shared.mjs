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

// A lock with a shared release. Not taken once the process is interrupted, and given back if it was
// won at the last moment.
export async function acquireShared(dir, owner, opts) {
  const release = sharedCleanup(await acquire(dir, owner, { ...opts, isAborted: isInterrupted }));
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
// environment; prints one line per step and, on failure, the tail and the log path.
export async function runSteps({ label, steps, cwd, env = {}, logFile, timeoutMin = 30, out }) {
  for (const step of steps) {
    const r = await run(step.run, {
      cwd: step.cwd ? join(cwd, step.cwd) : cwd,
      env: buildEnv({ ...env, ...step.env }),
      logFile,
      timeoutMs: timeoutMin * 60_000,
    });
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

// Who holds a lock, for a waiting message: a check names its PR, a deploy its command.
export const holderText = (h) => `${h?.repo ?? '?'} ${h?.pr ? `PR #${h.pr}` : h?.command ?? '?'} since ${h?.since ? localTime(h.since) : '?'}`;

// One slot of a machine-wide lane for the duration of fn: checks and deploy builds share them, so
// two 6 GB builds never run at once.
export async function withLane({ d, lane, owner, fn }) {
  const release = await acquireShared(join(d.tmpRoot, 'lanes', lane), await ownerInfo(owner), {
    pollMs: d.pollMs,
    onWait: everyMinute((h) => d.out(`… waiting for the ${lane} lane: ${holderText(h)}`)),
  });
  const off = onInterrupt(release);
  try {
    return await fn();
  } finally {
    await release();
    if (!isInterrupted()) off();
  }
}

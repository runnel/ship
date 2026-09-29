import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ENV_KEYS = ['HOME', 'PATH', 'SHELL', 'USER', 'TMPDIR', 'LANG'];
const TERM_GRACE_MS = 2000; // between SIGTERM and SIGKILL of a stopped process tree
const STREAM_GRACE_MS = 2000; // after a command exits: how long a descendant may still hold its output
const active = new Set(); // pids of running `run` commands
const captures = new Set(); // pids of running `capture` children: ship's own helpers, never part of a step
let aborted = false; // set by killActiveChildren: from then on run() starts nothing and reports 130

// Children never inherit the caller's environment: a session's shell can carry secrets and
// build-time variables that would leak into a bundle. TMPDIR is kept (tools write there), and
// LC_ALL must be a real locale or PostgreSQL refuses to start on macOS.
export function buildEnv(extra = {}, base = process.env) {
  const env = {};
  for (const k of ENV_KEYS) if (base[k] !== undefined) env[k] = base[k];
  env.LC_ALL = base.LC_ALL && base.LC_ALL !== 'C' ? base.LC_ALL : 'en_US.UTF-8';
  env.CI = 'true';
  return { ...env, ...extra };
}

export function capture(file, args, opts = {}) {
  const p = execFileP(file, args, { maxBuffer: 256 * 1024 * 1024, ...opts });
  const pid = p.child?.pid;
  if (pid) captures.add(pid);
  return p.then(({ stdout }) => stdout).finally(() => { if (pid) captures.delete(pid); });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function descendants(pid) {
  let out = '';
  try {
    out = await capture('pgrep', ['-P', String(pid)]);
  } catch {
    return []; // pgrep exits 1 when there are none
  }
  const kids = out.split('\n').filter(Boolean).map(Number);
  const all = [...kids];
  for (const k of kids) all.push(...(await descendants(k)));
  return all;
}

// bin/ship.mjs runs ship in a session of its own (detached: setsid), which makes ship the leader of
// its process group and leaves it without a controlling terminal, so every process a step started
// (npm, a build, a daemon) is a member of that group, including orphans re-parented to init that a
// walk down from the step's pid can no longer reach. Anything else shares its group with processes
// that are not ship's and never signals it: a test runner or a ship started by hand (not the
// leader), and a ship that leads a group but owns a terminal (a shell job such as `ship check |
// tee log`, whose `tee` is the user's).
export function ownsItsGroup({ pid, pgid, tty }) {
  return Number(pgid) === pid && /^\?{1,2}$/.test(String(tty ?? '').trim());
}

let leader;
async function ownsGroup() {
  if (leader === undefined) {
    try {
      const [pgid, tty] = (await capture('ps', ['-o', 'pgid=,tty=', '-p', String(process.pid)])).trim().split(/\s+/);
      leader = ownsItsGroup({ pid: process.pid, pgid, tty });
    } catch {
      leader = false;
    }
  }
  return leader;
}

async function groupMembers() {
  try {
    return (await capture('pgrep', ['-g', String(process.pid)])).split('\n').filter(Boolean).map(Number)
      .filter((p) => p !== process.pid && !captures.has(p));
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

// SIGTERM, then SIGKILL for whatever survived the grace period. Awaited, so that ship never exits
// with a pending kill timer and leaves descendants running in a deleted worktree.
async function stop(pids) {
  const hit = (sig) => pids.forEach((p) => { try { process.kill(p, sig); } catch { /* gone */ } });
  hit('SIGTERM');
  const until = Date.now() + TERM_GRACE_MS;
  while (Date.now() < until && pids.some(alive)) await sleep(50);
  hit('SIGKILL');
}

async function killTree(pid, { wholeGroup }) {
  const targets = new Set([pid, ...(await descendants(pid))]);
  if (wholeGroup && (await ownsGroup())) for (const p of await groupMembers()) targets.add(p);
  await stop([...targets]);
}

// Interrupt: stop every running command with its descendants and, as group leader, everything
// else ship started that is still alive.
export async function killActiveChildren() {
  aborted = true;
  const targets = new Set();
  for (const pid of active) {
    targets.add(pid);
    for (const d of await descendants(pid)) targets.add(d);
  }
  if (await ownsGroup()) for (const p of await groupMembers()) targets.add(p);
  await stop([...targets]);
}

// A check is over: whatever its commands left running in ship's process group (a build worker, a
// dev server started without detaching) would outlive ship and stack with the next heavy check,
// which is what lanes exist to prevent. Between commands it is left alone (a later step may use
// it). Only as group leader, and never while a command runs. Returns how many were stopped.
export async function stopStrays() {
  if (active.size > 0 || !(await ownsGroup())) return 0;
  const members = await groupMembers();
  if (members.length > 0) await stop(members);
  return members.length;
}

export function run(command, { cwd, env, logFile, tailLines = 40, timeoutMs = 0 }) {
  if (aborted) return Promise.resolve({ code: 130, signal: null, durationMs: 0, tail: ['✗ not started: ship was interrupted'] });
  return new Promise((resolve) => {
    const started = Date.now();
    const log = createWriteStream(logFile, { flags: 'a' });
    log.write(`\n$ ${command}\n`);
    const child = spawn('/bin/bash', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(child.pid);
    const tail = [];
    const pending = { out: '', err: '' };
    const push = (line) => {
      tail.push(line);
      if (tail.length > tailLines) tail.shift();
    };
    const onData = (key) => (buf) => {
      log.write(buf);
      const lines = (pending[key] + buf.toString('utf8')).split('\n');
      pending[key] = lines.pop();
      lines.forEach(push);
    };
    child.stdout.on('data', onData('out'));
    child.stderr.on('data', onData('err'));

    let timedOut = false;
    let done = false;
    let exit = null;
    let timer = null;
    let streamGrace = null;
    // Resolve once, from whichever comes first: the streams closing, the command having exited for
    // STREAM_GRACE_MS while a descendant still holds them, or the kill after a timeout.
    const settle = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(streamGrace);
      active.delete(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      if (pending.out) push(pending.out);
      if (pending.err) push(pending.err);
      if (timedOut) push(`✗ timed out after ${Math.round(timeoutMs / 1000)}s`);
      log.end();
      // A command that was stopped by an interrupt may exit 0 (a trap, a graceful shutdown): that
      // is not a result to build on.
      resolve({ code: aborted ? 130 : timedOut ? 124 : (code ?? 1), signal, durationMs: Date.now() - started, tail });
    };
    child.on('error', (e) => {
      push(`spawn error: ${e.message}`);
      settle(1, null);
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      if (done) return; // settled by the kill after a timeout; nothing left to wait for
      streamGrace = setTimeout(() => settle(code, signal), STREAM_GRACE_MS);
    });
    child.on('close', (code, signal) => settle(code, signal));
    if (timeoutMs > 0) {
      timer = setTimeout(async () => {
        timedOut = true;
        try {
          await killTree(child.pid, { wholeGroup: active.size === 1 });
        } finally {
          settle(exit?.code ?? null, exit?.signal ?? null);
        }
      }, timeoutMs);
    }
  });
}

import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ENV_KEYS = ['HOME', 'PATH', 'SHELL', 'USER', 'TMPDIR', 'LANG'];
const KILL_GRACE_MS = 5000;
const active = new Set(); // pids of running `run` commands

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

export async function capture(file, args, opts = {}) {
  const { stdout } = await execFileP(file, args, { maxBuffer: 256 * 1024 * 1024, ...opts });
  return stdout;
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

// Children share ship's process group (so an orphaned child keeps a lock alive), which rules out
// a group kill here: walk the tree and signal exactly this command's processes. The pid list is
// taken once, so the SIGKILL still reaches children that were re-parented after SIGTERM.
async function killTree(pid) {
  const pids = [...(await descendants(pid)), pid];
  const hit = (sig) => pids.forEach((p) => { try { process.kill(p, sig); } catch { /* gone */ } });
  hit('SIGTERM');
  setTimeout(() => hit('SIGKILL'), KILL_GRACE_MS).unref();
}

export async function killActiveChildren() {
  await Promise.all([...active].map((pid) => killTree(pid)));
}

export function run(command, { cwd, env, logFile, tailLines = 40, timeoutMs = 0 }) {
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
    child.on('error', (e) => push(`spawn error: ${e.message}`));
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs)
      : null;
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      active.delete(child.pid);
      if (pending.out) push(pending.out);
      if (pending.err) push(pending.err);
      if (timedOut) push(`✗ timed out after ${Math.round(timeoutMs / 1000)}s`);
      log.end();
      resolve({ code: timedOut ? 124 : (code ?? 1), signal, durationMs: Date.now() - started, tail });
    });
  });
}

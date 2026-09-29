import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMirror } from '../lib/git.mjs';
import { capture } from '../lib/proc.mjs';
import { setupCheck, tempDir } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/ship.mjs', import.meta.url));
const deadline = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no result within ${ms} ms`)), ms).unref());
const exists = (p) => access(p).then(() => true, () => false);

async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${what}: not reached within ${ms} ms`);
}

// The real `ship check --pr 7`, through the wrapper, against a fake gh and a local origin: the
// mirror is created beforehand, so the check never needs the network.
async function startWrapper(s) {
  const home = join(s.root, 'home');
  await ensureMirror('t/r', { root: join(home, 'mirrors'), url: s.origin });
  const env = { ...process.env, PATH: `${s.root}:${process.env.PATH}`, SHIP_TMP: s.deps.tmpRoot, SHIP_HOME: home };
  const child = spawn(process.execPath, [BIN, 'check', '--pr', '7'], { cwd: s.work, env, stdio: ['ignore', 'pipe', 'inherit'] });
  const out = { text: '' };
  child.stdout.on('data', (b) => { out.text += b; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return { child, out, exited };
}

// Ship is the wrapper's only child, and the leader of its own group.
async function killShip(child) {
  const kids = (await capture('pgrep', ['-P', String(child.pid)]).catch(() => '')).split('\n').filter(Boolean).map(Number);
  for (const pid of kids) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
}

test('a second Ctrl-C during the unwind does not kill the helper that posts the error status', { timeout: 90_000 }, async () => {
  const dir = await tempDir('wrapper-');
  const started = join(dir, 'started');
  const s = await setupCheck({
    steps: [`trap "exit 0" TERM INT; touch ${started}; sleep 30.3141 & wait`],
    ghOptions: { apiDelay: { ms: 1500, match: 'state=error' } }, // the error POST takes a while
  });
  const w = await startWrapper(s);
  try {
    await waitFor(() => exists(started), 60_000, 'the first step to start');
    w.child.kill('SIGTERM'); // first Ctrl-C
    await waitFor(async () => (await s.calls()).some((c) => c[0] === 'api' && c.includes('state=error')), 20_000, 'the error POST to start');
    w.child.kill('SIGTERM'); // second Ctrl-C, while that POST is in flight
    const code = await Promise.race([w.exited, deadline(30_000, 'wrapper exit')]);
    assert.equal(code, 130, w.out.text);
    const calls = await s.calls();
    assert.ok(calls.some((c) => c[0] === 'done' && c.includes('state=error')), 'the error status POST was cut short');
    assert.equal((await s.statuses()).at(-1).state, 'error');
  } finally {
    await killShip(w.child);
  }
});

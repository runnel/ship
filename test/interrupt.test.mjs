import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capture } from '../lib/proc.mjs';
import { acquire, ownerInfo, readOwner } from '../lib/lock.mjs';
import { setupCheck, spawnCheckLeader, tempDir } from './helpers.mjs';

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

// A child that must print "ready" before the test goes on. If it exits first (a crash on import,
// say) the test fails with that fact instead of waiting forever.
async function ready(child) {
  const outcome = await Promise.race([
    once(child.stdout, 'data').then(() => 'ready'),
    once(child, 'exit').then(([code]) => `child exited (${code}) before it was ready`),
    deadline(10_000, 'child startup'),
  ]);
  if (outcome !== 'ready') throw new Error(outcome);
}

test('interrupt handlers run last-registered first, then the process exits 130', { timeout: 30_000 }, async () => {
  const dir = await tempDir();
  const out = join(dir, 'out');
  const script = join(dir, 's.mjs');
  const mod = new URL('../lib/interrupt.mjs', import.meta.url).href;
  await writeFile(script, `
import { appendFileSync } from 'node:fs';
import { onInterrupt } from ${JSON.stringify(mod)};
onInterrupt(() => appendFileSync(${JSON.stringify(out)}, 'a,'));
onInterrupt(() => appendFileSync(${JSON.stringify(out)}, 'b,'));
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await ready(child);
    child.kill('SIGTERM');
    const [code] = await Promise.race([once(child, 'exit'), deadline(10_000, 'child exit')]);
    assert.equal(code, 130);
    assert.equal(await readFile(out, 'utf8'), 'b,a,');
  } finally {
    child.kill('SIGKILL');
  }
});

test('a repeated signal during the unwind starts no second unwind, and says why nothing happens (once)', { timeout: 30_000 }, async () => {
  const dir = await tempDir();
  const out = join(dir, 'out');
  const script = join(dir, 's.mjs');
  const mod = new URL('../lib/interrupt.mjs', import.meta.url).href;
  await writeFile(script, `
import { appendFileSync } from 'node:fs';
import { onInterrupt } from ${JSON.stringify(mod)};
onInterrupt(async () => { appendFileSync(${JSON.stringify(out)}, 'x,'); await new Promise((r) => setTimeout(r, 600)); });
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  try {
    await ready(child);
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 100));
    child.kill('SIGINT');
    const [code] = await Promise.race([once(child, 'exit'), deadline(10_000, 'child exit')]);
    assert.equal(code, 130);
    assert.equal(await readFile(out, 'utf8'), 'x,');
    assert.equal(stderr.split('\n').filter((l) => /already interrupted/.test(l)).length, 1, stderr);
    assert.match(stderr, /at most 30 s/);
  } finally {
    child.kill('SIGKILL');
  }
});

// The reviewed failure: a step that traps SIGTERM and exits 0 made the interrupted run continue,
// start the next step and post "success" (which could land after the error status).
for (const target of ['process', 'group']) {
  test(`an interrupted check (signal to the ${target}) never posts success; it ends as error and cleans up`, { timeout: 60_000 }, async () => {
    const dir = await tempDir('interrupt-');
    const started = join(dir, 'started');
    const second = join(dir, 'second');
    const s = await setupCheck({
      steps: [`trap "exit 0" TERM INT; touch ${started}; sleep 3.1415 & wait`, `touch ${second}`],
    });
    const run = await spawnCheckLeader(s, dir);
    const { child, out } = run;
    const exited = run.exited;
    try {
      await waitFor(() => exists(started), 30_000, 'the first step to start');
      if (target === 'group') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
      const code = await Promise.race([exited, deadline(20_000, 'ship exit')]);
      assert.equal(code, 130, out.text);

      const states = (await s.statuses()).map((x) => x.state);
      assert.ok(states.length >= 2, states.join(','));
      assert.ok(!states.includes('success'), `posted ${states.join(', ')}`);
      assert.equal(states.at(-1), 'error', states.join(', '));
      assert.ok(!out.text.includes('local-ci success'), out.text);
      assert.equal(await exists(second), false, 'a new step was started after the interrupt');

      // The worktree and both locks are gone; nothing that outlives ship is left running.
      assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'w')), []);
      assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'lanes')), []);
      assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'checks')), []);
      assert.equal((await capture('pgrep', ['-f', 'sleep 3.1415']).catch(() => '')).trim(), '');
    } finally {
      run.kill();
    }
  });
}

// --- cleanup shared between the flow and the unwind ------------------------------------------

// A `git` in front of the real one that takes its time over `worktree remove`, like a worktree the
// size of node_modules does.
async function slowWorktreeRemoval(dir) {
  const real = (await capture('/bin/sh', ['-c', 'command -v git'])).trim();
  const bin = join(dir, 'slowbin');
  await mkdir(bin);
  await writeFile(join(bin, 'git'), `#!/bin/sh\ncase "$*" in *"worktree remove"*) sleep 1.5;; esac\nexec ${real} "$@"\n`);
  await chmod(join(bin, 'git'), 0o755);
  return bin;
}

test('after an interrupt ship does not exit before the worktree removal has finished', { timeout: 60_000 }, async () => {
  const dir = await tempDir('unwind-');
  const started = join(dir, 'started');
  const s = await setupCheck({ steps: [`trap "exit 0" TERM INT; touch ${started}; sleep 3.1415 & wait`] });
  const bin = await slowWorktreeRemoval(dir);
  const run = await spawnCheckLeader(s, dir, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  try {
    await waitFor(() => exists(started), 30_000, 'the first step to start');
    run.child.kill('SIGTERM');
    assert.equal(await Promise.race([run.exited, deadline(30_000, 'ship exit')]), 130, run.out.text);
    // The removal is still running in the background if ship left early.
    assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'w')), []);
    assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'lanes')), []);
    assert.equal((await s.statuses()).at(-1).state, 'error');
  } finally {
    run.kill();
  }
});

test('a signal while the first status is being posted still ends in error, posted after it', { timeout: 60_000 }, async () => {
  const dir = await tempDir('unwind-');
  const s = await setupCheck({ steps: ['true'], ghOptions: { apiDelay: { ms: 1200, match: 'state=pending' } } });
  const run = await spawnCheckLeader(s, dir);
  try {
    await waitFor(async () => (await s.calls()).some((c) => c[0] === 'api' && c.includes('state=pending')), 30_000, 'the first status POST to start');
    run.child.kill('SIGTERM'); // ship only: the POST in flight is not signalled
    assert.equal(await Promise.race([run.exited, deadline(30_000, 'ship exit')]), 130, run.out.text);
    const states = (await s.statuses()).map((x) => x.state);
    assert.equal(states.at(-1), 'error', states.join(', '));
    assert.ok(!states.includes('success'), states.join(', '));
    const calls = (await s.calls()).map((c) => `${c[0]}:${c.find((a) => String(a).startsWith('state=')) ?? ''}`);
    assert.ok(calls.indexOf('done:state=pending') >= 0 && calls.indexOf('done:state=pending') < calls.indexOf('api:state=error'), calls.join(' '));
  } finally {
    run.kill();
  }
});

test('an interrupt while waiting for the lane ends in error and leaves the holder alone', { timeout: 60_000 }, async () => {
  const dir = await tempDir('unwind-');
  const s = await setupCheck({ steps: ['true'] });
  const laneDir = join(s.deps.tmpRoot, 'lanes', 'light');
  const holder = await acquire(laneDir, await ownerInfo({ label: 'holder' }), { pollMs: 10 });
  const run = await spawnCheckLeader(s, dir);
  try {
    await waitFor(() => run.out.text.includes('waiting for the light lane'), 30_000, 'the lane wait');
    run.child.kill('SIGTERM');
    assert.equal(await Promise.race([run.exited, deadline(30_000, 'ship exit')]), 130, run.out.text);
    assert.deepEqual((await s.statuses()).map((x) => x.state), ['pending', 'error']); // never "running"
    assert.equal((await readOwner(laneDir)).label, 'holder');
    assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'w')), []);
    assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'checks')), []);
  } finally {
    run.kill();
    await holder();
  }
});

// --- the error POST fails (offline, GitHub 5xx, expired gh auth) ------------------------------
// Exactly when Ctrl-C is likely to be pressed. The unwind must still remove the worktree and free
// the lane: each of its steps stands on its own.

test('an interrupt during a step still removes the worktree when the error POST fails', { timeout: 60_000 }, async () => {
  const dir = await tempDir('unwind-');
  const started = join(dir, 'started');
  const s = await setupCheck({
    steps: [`trap "exit 0" TERM INT; touch ${started}; sleep 3.1415 & wait`],
    ghOptions: { apiFail: { match: 'state=error' } },
  });
  const bin = await slowWorktreeRemoval(dir);
  const run = await spawnCheckLeader(s, dir, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  try {
    await waitFor(() => exists(started), 30_000, 'the first step to start');
    run.child.kill('SIGTERM');
    assert.equal(await Promise.race([run.exited, deadline(30_000, 'ship exit')]), 130, run.out.text);
    assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'w')), []);
    assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'lanes')), []);
    assert.ok(!(await s.statuses()).some((x) => x.state === 'success'));
  } finally {
    run.kill();
  }
});

test('an interrupt while waiting for the lane still removes the worktree when the error POST fails', { timeout: 60_000 }, async () => {
  const dir = await tempDir('unwind-');
  const s = await setupCheck({ steps: ['true'], ghOptions: { apiFail: { match: 'state=error' } } });
  const laneDir = join(s.deps.tmpRoot, 'lanes', 'light');
  const holder = await acquire(laneDir, await ownerInfo({ label: 'holder' }), { pollMs: 10 });
  // The production poll interval: the flow sleeps in acquire, and only the unwind can remove the tree.
  const run = await spawnCheckLeader(s, dir, { pollMs: 5000 });
  try {
    await waitFor(() => run.out.text.includes('waiting for the light lane'), 30_000, 'the lane wait');
    run.child.kill('SIGTERM');
    assert.equal(await Promise.race([run.exited, deadline(30_000, 'ship exit')]), 130, run.out.text);
    assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'w')), []);
    assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'checks')), []);
    assert.equal((await readOwner(laneDir)).label, 'holder');
  } finally {
    run.kill();
    await holder();
  }
});

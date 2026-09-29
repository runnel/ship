import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capture } from '../lib/proc.mjs';
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

test('a second signal during the unwind does not start a second unwind', { timeout: 30_000 }, async () => {
  const dir = await tempDir();
  const out = join(dir, 'out');
  const script = join(dir, 's.mjs');
  const mod = new URL('../lib/interrupt.mjs', import.meta.url).href;
  await writeFile(script, `
import { appendFileSync } from 'node:fs';
import { onInterrupt } from ${JSON.stringify(mod)};
onInterrupt(async () => { appendFileSync(${JSON.stringify(out)}, 'x,'); await new Promise((r) => setTimeout(r, 400)); });
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await ready(child);
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    child.kill('SIGINT');
    const [code] = await Promise.race([once(child, 'exit'), deadline(10_000, 'child exit')]);
    assert.equal(code, 130);
    assert.equal(await readFile(out, 'utf8'), 'x,');
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isPid } from '../lib/proc.mjs';
import { isAlive, isGone, killQuietly, readPid, tempDir } from './helpers.mjs';

const deadline = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no result within ${ms} ms`)), ms).unref());

// process.kill(0, ...) signals the caller's whole process group, process.kill(-1, ...) every process
// the user may signal, and a numeric string is accepted like a number. A cleanup "by pid" after a
// failing test must never do any of that, or it takes down its own runner (and ship, when ship
// checks itself) and hides the failure. So the guard is tested WITHOUT real signals: as a pure
// function, and against a stub that records the signals it would have sent. A real signal goes
// only to a process this test started itself.
const INVALID = [0, -1, -12, NaN, Infinity, null, undefined, '12', '', 1.5, {}, [], true];

test('isPid accepts only positive integers', () => {
  for (const bad of INVALID) assert.equal(isPid(bad), false, String(bad));
  for (const good of [1, 12, 99999]) assert.equal(isPid(good), true, String(good));
});

test('killQuietly sends nothing for an invalid pid or the caller\'s own, and SIGKILL for a real one', () => {
  const sent = [];
  const kill = (pid, signal) => sent.push([pid, signal]);
  for (const bad of [...INVALID, process.pid]) killQuietly(bad, { kill });
  assert.deepEqual(sent, []);
  killQuietly(4242, { kill });
  assert.deepEqual(sent, [[4242, 'SIGKILL']]);
});

test('killQuietly does not signal a pid that was already proven gone (it may have been reused since)', async () => {
  const child = spawn('sleep', ['41.5926'], { stdio: 'ignore' });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('close', resolve));
  assert.equal(await isGone(child.pid), true);
  const sent = [];
  killQuietly(child.pid, { kill: (pid, signal) => sent.push([pid, signal]) });
  assert.deepEqual(sent, []);
});

test('the helpers signal a real process, but only one this test started', async () => {
  const child = spawn('sleep', ['41.5926'], { stdio: 'ignore' });
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve(signal)));
  try {
    assert.equal(isAlive(child.pid), true);
    killQuietly(child.pid);
    assert.equal(await Promise.race([closed, deadline(30_000, 'the child')]), 'SIGKILL');
  } finally {
    child.kill('SIGKILL');
  }
});

// The one real-signal test for the invalid cases: 0 and a missing pid file (the case that once
// killed a whole group). Its worst case, were the guard to fail, is the detached group of the
// script below (the script and a sibling) and never the runner or the user's other processes.
test('a pid of 0 and a missing pid file are no-ops, even with real signals', { timeout: 60_000 }, async () => {
  const dir = await tempDir('pidhelpers-');
  const script = join(dir, 'check.mjs');
  const helpers = new URL('./helpers.mjs', import.meta.url).href;
  await writeFile(script, `
import { spawn } from 'node:child_process';
import { isAlive, killQuietly, readPid } from ${JSON.stringify(helpers)};
const sibling = spawn('sleep', ['41.5926'], { stdio: 'ignore' }); // same process group as this script
await new Promise((r) => setTimeout(r, 100));
killQuietly(0);
killQuietly(await readPid(${JSON.stringify(join(dir, 'missing'))}));
process.stdout.write('missing pid file -> ' + (await readPid(${JSON.stringify(join(dir, 'missing'))})) + '\\n');
process.stdout.write('sibling alive -> ' + isAlive(sibling.pid) + '\\n');
sibling.kill('SIGKILL');
`);
  // A group of its own, like ship's: the script has a sibling in it, and no way to tell from the outside.
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  try {
    const { code, signal } = await Promise.race([exited, deadline(40_000, 'the helper script')]);
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, out);
    assert.match(out, /missing pid file -> null/);
    assert.match(out, /sibling alive -> true/);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
});

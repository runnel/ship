import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, chmod, utimes } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { acquire, ownerInfo, isStale, readOwner, processStartTime } from '../lib/lock.mjs';
import { tempDir } from './helpers.mjs';

const lockDir = async () => join(await tempDir('lock-'), 'l');
const DEAD = { pid: 999999, pgid: 999999, startTime: 'x', nonce: 'dead' };

test('acquire, read, release', async () => {
  const dir = await lockDir();
  const release = await acquire(dir, await ownerInfo({ label: 'a' }));
  assert.equal((await readOwner(dir)).label, 'a');
  await release();
  assert.equal(await readOwner(dir), null);
});

test('a live holder is waited for', async () => {
  const dir = await lockDir();
  const release = await acquire(dir, await ownerInfo({ label: 'first' }));
  let waits = 0;
  const second = acquire(dir, await ownerInfo({ label: 'second' }), { pollMs: 20, onWait: () => { waits++; } });
  setTimeout(() => release(), 120);
  const release2 = await second;
  assert.ok(waits > 0);
  assert.equal((await readOwner(dir)).label, 'second');
  await release2();
});

test('a dead holder is taken over', async () => {
  const dir = await lockDir();
  await mkdir(dir);
  await writeFile(join(dir, 'owner.json'), JSON.stringify(DEAD));
  const release = await acquire(dir, await ownerInfo({ label: 'new' }), { pollMs: 20 });
  assert.equal((await readOwner(dir)).label, 'new');
  await release();
});

test('isStale: this process is alive; a reused pid is stale; a dead group is stale', async () => {
  const me = await ownerInfo();
  assert.equal(await isStale(me), false);
  assert.equal(await isStale({ ...me, startTime: 'Thu Jan  1 00:00:00 1970' }), true);
  assert.equal(await isStale(DEAD), true);
});

test('processStartTime does not depend on the caller time zone or locale', { timeout: 30_000 }, async () => {
  const before = await processStartTime(process.pid);
  assert.ok(before);
  const mod = new URL('../lib/lock.mjs', import.meta.url).href;
  const code = `import { processStartTime } from ${JSON.stringify(mod)}; process.stdout.write(String(await processStartTime(${process.pid})));`;
  for (const env of [{ TZ: 'Asia/Tokyo' }, { TZ: 'America/New_York', LC_ALL: 'de_DE.UTF-8' }]) {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, timeout: 20_000 });
    assert.equal(stdout, before, JSON.stringify(env));
  }
});

test('two waiters on a stale lock never hold it at the same time', async () => {
  const dir = await lockDir();
  await mkdir(dir);
  await writeFile(join(dir, 'owner.json'), JSON.stringify(DEAD));
  const events = [];
  const take = async (label) => {
    const release = await acquire(dir, await ownerInfo({ label }), { pollMs: 10 });
    events.push(`in:${label}`);
    await new Promise((r) => setTimeout(r, 40));
    events.push(`out:${label}`);
    await release();
  };
  await Promise.all([take('a'), take('b')]);
  assert.match(events.join(','), /^in:(a|b),out:\1,in:(a|b),out:\2$/);
});

// --- liveness errors and takeover races (spec 6.7) -------------------------------------------

test('a failing ps or pgrep never makes a holder look dead', { timeout: 30_000 }, async () => {
  const me = await ownerInfo();
  const bin = await tempDir('fakebin-');
  for (const cmd of ['ps', 'pgrep']) {
    await writeFile(join(bin, cmd), '#!/bin/sh\nexit 2\n'); // e.g. EAGAIN under fork pressure
    await chmod(join(bin, cmd), 0o755);
  }
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    assert.equal(await isStale(me), false);
    assert.equal(await isStale(DEAD), false); // unknown is not dead
  } finally {
    process.env.PATH = saved;
  }
});

test('the lock directory never exists without its owner.json, while acquiring or releasing', { timeout: 60_000 }, async () => {
  const dir = await lockDir();
  let ownerless = 0;
  let stop = false;
  const watcher = (async () => {
    while (!stop) {
      try {
        // one syscall = one consistent snapshot of the directory
        if (!readdirSync(dir).includes('owner.json')) ownerless++;
      } catch { /* no lock right now */ }
      await new Promise((r) => setImmediate(r));
    }
  })();
  for (let i = 0; i < 150; i++) {
    const release = await acquire(dir, await ownerInfo({ label: `w${i}` }), { pollMs: 1 });
    await release();
  }
  stop = true;
  await watcher;
  assert.equal(ownerless, 0);
});

test('many waiters never hold the lock together and never fail', { timeout: 60_000 }, async () => {
  const dir = await lockDir();
  let inside = 0;
  let maxInside = 0;
  const worker = async (label) => {
    for (let i = 0; i < 12; i++) {
      const release = await acquire(dir, await ownerInfo({ label }), { pollMs: 1 });
      maxInside = Math.max(maxInside, ++inside);
      await new Promise((r) => setImmediate(r));
      inside--;
      await release();
    }
  };
  await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(worker));
  assert.equal(maxInside, 1);
  assert.equal(await readOwner(dir), null);
});

test('a directory without an owner is waited for until it is older than the grace period', { timeout: 30_000 }, async () => {
  const dir = await lockDir();
  await mkdir(dir);
  await writeFile(join(dir, 'junk'), 'x');
  let acquired = false;
  const attempt = acquire(dir, await ownerInfo({ label: 'late' }), { pollMs: 10 }).then((release) => { acquired = true; return release; });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(acquired, false);
  const old = new Date(Date.now() - 120_000);
  await utimes(dir, old, old);
  const release = await attempt;
  assert.equal((await readOwner(dir)).label, 'late');
  await release();
});

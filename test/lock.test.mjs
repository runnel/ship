import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, chmod, utimes, rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { acquire, ownerInfo, isStale, readOwner, processStartTime } from '../lib/lock.mjs';
import { tempDir, waitUntil } from './helpers.mjs';

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

test('acquire stops waiting when told to abort, instead of waiting for a live holder forever', { timeout: 30_000 }, async () => {
  const dir = await lockDir();
  const release = await acquire(dir, await ownerInfo({ label: 'holder' }));
  let abort = false;
  setTimeout(() => { abort = true; }, 100);
  const waiter = acquire(dir, await ownerInfo({ label: 'waiter' }), { pollMs: 10, isAborted: () => abort });
  try {
    const outcome = await Promise.race([
      waiter.then(() => 'acquired', (e) => (e.aborted ? 'aborted' : `failed: ${e.message}`)),
      new Promise((r) => setTimeout(() => r('still waiting'), 3_000).unref()),
    ]);
    assert.equal(outcome, 'aborted');
    assert.equal((await readOwner(dir)).label, 'holder'); // the holder's lock is untouched
  } finally {
    await release(); // a waiter that ignored the abort gets the lock now ...
    await waiter.then((r) => r(), () => {}); // ... and hands it back, so nothing keeps polling
  }
});

// --- the line: first come, first served, with priorities ---------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ticketsOf = (dir) => readdirSync(dirname(dir)).filter((n) => n.includes('.q-') && n.endsWith('.json'));

// Starts `run` and returns, as soon as its ticket is filed, a function that waits for its end: the
// next waiter can then be told to arrive after it.
async function lineUp(dir, run) {
  const before = ticketsOf(dir).length;
  const done = run();
  done.catch(() => {}); // reported where it is awaited
  await waitUntil(() => ticketsOf(dir).length > before, 'a ticket to be filed');
  return () => done;
}

// A waiter that takes the lock, holds it briefly and gives it back; `order` records who got it when.
const waiterIn = (dir, order) => async (label, { priority, pollMs }) => {
  const release = await acquire(dir, await ownerInfo({ label }), { pollMs, priority });
  order.push(label);
  await sleep(10);
  await release();
};

test('waiters get the lock in the order they arrived, however often each of them polls', { timeout: 30_000 }, async () => {
  const dir = await lockDir();
  const holder = await acquire(dir, await ownerInfo({ label: 'holder' }));
  const order = [];
  const waiter = waiterIn(dir, order);
  const finishes = [];
  // The later the arrival, the faster it polls: with plain polling the last one would win.
  for (const [i, label] of ['w1', 'w2', 'w3', 'w4', 'w5'].entries()) {
    finishes.push(await lineUp(dir, () => waiter(label, { priority: 1, pollMs: 100 - i * 20 })));
  }
  await holder();
  await Promise.all(finishes.map((f) => f()));
  assert.deepEqual(order, ['w1', 'w2', 'w3', 'w4', 'w5']);
  assert.deepEqual(ticketsOf(dir), []);
  assert.equal(await readOwner(dir), null);
});

test('a lower priority number goes ahead of earlier arrivals, and arrival order holds within a priority', { timeout: 30_000 }, async () => {
  const dir = await lockDir();
  const holder = await acquire(dir, await ownerInfo({ label: 'holder' }), { priority: 1 });
  const order = [];
  const waiter = waiterIn(dir, order);
  const finishes = [];
  for (const [i, [label, priority]] of [['check1', 1], ['check2', 1], ['deploy1', 0], ['check3', 1], ['deploy2', 0]].entries()) {
    finishes.push(await lineUp(dir, () => waiter(label, { priority, pollMs: 100 - i * 15 })));
  }
  await holder();
  await Promise.all(finishes.map((f) => f()));
  assert.deepEqual(order, ['deploy1', 'deploy2', 'check1', 'check2', 'check3']);
});

test('a holder is never pre-empted by a higher priority', { timeout: 30_000 }, async () => {
  const dir = await lockDir();
  const holder = await acquire(dir, await ownerInfo({ label: 'check holder' }), { priority: 1 });
  let got = false;
  const urgent = acquire(dir, await ownerInfo({ label: 'deploy' }), { pollMs: 10, priority: 0 }).then((r) => { got = true; return r; });
  await sleep(150);
  assert.equal(got, false);
  assert.equal((await readOwner(dir)).label, 'check holder');
  await holder();
  await (await urgent)();
});

test('a waiter that is killed does not block the line', { timeout: 30_000 }, async () => {
  const dir = await lockDir();
  const holder = await acquire(dir, await ownerInfo({ label: 'holder' }));
  const mod = new URL('../lib/lock.mjs', import.meta.url).href;
  const code = `import { acquire, ownerInfo } from ${JSON.stringify(mod)};
    await acquire(process.argv[1], await ownerInfo({ label: 'doomed' }), { pollMs: 50, priority: 0 });`;
  // A group of its own, as a ship process has: a lock or ticket is only stale once its whole group is gone.
  const doomed = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { stdio: 'ignore', detached: true });
  const exited = new Promise((r) => doomed.on('exit', r));
  let abort = false;
  let behind;
  try {
    await waitUntil(() => ticketsOf(dir).length === 1, 'the doomed waiter to be in line');
    behind = acquire(dir, await ownerInfo({ label: 'behind' }), { pollMs: 20, priority: 1, isAborted: () => abort });
    behind.catch(() => {});
    await waitUntil(() => ticketsOf(dir).length === 2, 'the next waiter to be in line');
    doomed.kill('SIGKILL'); // no chance to withdraw its ticket
    await exited;
    assert.equal(ticketsOf(dir).length, 2); // its ticket is still there ...
    await holder();
    const outcome = await Promise.race([behind.then(() => 'acquired'), sleep(5_000).then(() => 'still waiting')]);
    assert.equal(outcome, 'acquired'); // ... and does not hold anyone up
    assert.equal((await readOwner(dir)).label, 'behind');
    assert.equal(ticketsOf(dir).length, 0); // swept on the way
    await (await behind)();
  } finally {
    abort = true;
    doomed.kill('SIGKILL');
    await holder();
    await behind?.then((r) => r(), () => {});
  }
});

test('a holder that dies is replaced by the first in line, not by the waiter that happens to poll first', { timeout: 30_000 }, async () => {
  const dir = await lockDir();
  const mod = new URL('../lib/lock.mjs', import.meta.url).href;
  const code = `import { acquire, ownerInfo } from ${JSON.stringify(mod)};
    await acquire(process.argv[1], await ownerInfo({ label: 'doomed holder' }));
    setInterval(() => {}, 1000);`;
  const doomed = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { stdio: 'ignore', detached: true });
  const exited = new Promise((r) => doomed.on('exit', r));
  try {
    await waitUntil(async () => (await readOwner(dir))?.label === 'doomed holder', 'the holder to take the lock');
    const order = [];
    const waiter = waiterIn(dir, order);
    // The later arrival polls much faster, and would take over the dead holder's lock first without a line.
    const first = await lineUp(dir, () => waiter('first', { priority: 1, pollMs: 150 }));
    const second = await lineUp(dir, () => waiter('second', { priority: 1, pollMs: 5 }));
    doomed.kill('SIGKILL');
    await exited;
    await Promise.all([first(), second()]);
    assert.deepEqual(order, ['first', 'second']);
  } finally {
    doomed.kill('SIGKILL');
  }
});

test('a waiter that gives up withdraws its place, and the next one goes ahead', { timeout: 30_000 }, async () => {
  const dir = await lockDir();
  const holder = await acquire(dir, await ownerInfo({ label: 'holder' }));
  let abort = false;
  const quitter = await lineUp(dir, async () => acquire(dir, await ownerInfo({ label: 'quitter' }), { pollMs: 10, priority: 1, isAborted: () => abort })
    .then(() => 'acquired', (e) => (e.aborted ? 'aborted' : `failed: ${e.message}`)));
  const next = await lineUp(dir, async () => acquire(dir, await ownerInfo({ label: 'next' }), { pollMs: 10, priority: 1 }));
  abort = true;
  assert.equal(await quitter(), 'aborted');
  assert.equal(ticketsOf(dir).length, 1);
  await holder();
  const release = await next();
  assert.equal((await readOwner(dir)).label, 'next');
  await release();
  assert.deepEqual(ticketsOf(dir), []);
});

test('onQueue hands over the way to withdraw the place, and a withdrawn place stays withdrawn', { timeout: 30_000 }, async () => {
  const dir = await lockDir();
  const holder = await acquire(dir, await ownerInfo({ label: 'holder' }));
  let leave;
  let abort = false;
  const waiter = await lineUp(dir, async () => acquire(dir, await ownerInfo({ label: 'w' }), { pollMs: 10, priority: 1, onQueue: (l) => { leave = l; }, isAborted: () => abort })
    .catch((e) => e));
  await leave();
  await sleep(100); // several polls: a waiter that re-filed its ticket would show up here
  assert.deepEqual(ticketsOf(dir), []);
  abort = true;
  assert.equal((await waiter()).aborted, true);
  await holder();
});

test('a ticket removed in error is filed again, keeping the place', { timeout: 30_000 }, async () => {
  const dir = await lockDir();
  const holder = await acquire(dir, await ownerInfo({ label: 'holder' }));
  const order = [];
  const waiter = waiterIn(dir, order);
  const a = await lineUp(dir, () => waiter('a', { priority: 1, pollMs: 10 }));
  const [first] = ticketsOf(dir);
  const b = await lineUp(dir, () => waiter('b', { priority: 1, pollMs: 10 }));
  await rm(join(dirname(dir), first)); // a's ticket
  await waitUntil(() => ticketsOf(dir).includes(first), 'the ticket to be filed again');
  await holder();
  await Promise.all([a(), b()]);
  assert.deepEqual(order, ['a', 'b']);
});

test('waiters in a line never hold the lock together, whatever their priorities', { timeout: 60_000 }, async () => {
  const dir = await lockDir();
  let inside = 0;
  let maxInside = 0;
  const worker = async (label, priority) => {
    for (let i = 0; i < 8; i++) {
      const release = await acquire(dir, await ownerInfo({ label }), { pollMs: 1, priority });
      maxInside = Math.max(maxInside, ++inside);
      await new Promise((r) => setImmediate(r));
      inside--;
      await release();
    }
  };
  await Promise.all([['a', 0], ['b', 1], ['c', 1], ['d', 0], ['e', 1], ['f', 1]].map(([l, p]) => worker(l, p)));
  assert.equal(maxInside, 1);
  assert.equal(await readOwner(dir), null);
  assert.deepEqual(ticketsOf(dir), []);
});

test('onWait is told the place in line: next to take the lock is 1, with who is ahead', { timeout: 30_000 }, async () => {
  const dir = await lockDir();
  const holder = await acquire(dir, await ownerInfo({ label: 'holder' }));
  const seen = { a: [], b: [] };
  const wait = async (label) => (await acquire(dir, await ownerInfo({ label }), {
    pollMs: 10, priority: 1,
    onWait: (h, line) => seen[label].push({ holder: h?.label, position: line.position, ahead: line.ahead.map((o) => o.label) }),
  }))();
  const a = await lineUp(dir, () => wait('a'));
  const b = await lineUp(dir, () => wait('b'));
  await waitUntil(() => seen.a.length > 0 && seen.b.length > 0, 'both to report');
  await holder();
  await Promise.all([a(), b()]);
  assert.deepEqual(seen.a[0], { holder: 'holder', position: 1, ahead: [] });
  assert.deepEqual(seen.b[0], { holder: 'holder', position: 2, ahead: ['a'] });
});

test('a ticket needs a priority from 0 to 99', async () => {
  const dir = await lockDir();
  for (const priority of [-1, 100, 1.5, '1']) {
    await assert.rejects(acquire(dir, await ownerInfo(), { priority }), RangeError);
  }
  assert.deepEqual(ticketsOf(dir), []);
});

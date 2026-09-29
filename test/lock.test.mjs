import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
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

test('processStartTime does not depend on the caller time zone', async () => {
  const before = await processStartTime(process.pid);
  const saved = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    assert.equal(await processStartTime(process.pid), before);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
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

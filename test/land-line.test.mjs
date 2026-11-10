import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquire, ownerInfo } from '../lib/lock.mjs';
import { LANE_PRIORITY } from '../lib/shared.mjs';
import { alreadyLanding, headLockDir, landDir, lineEmpty, lineState, slotDir } from '../lib/land-line.mjs';
import { atTestEnd, stopBackground, tempDir } from './helpers.mjs';

afterEach(stopBackground, { timeout: 30_000 });

const HEAD = 'a'.repeat(40);
const deps = async () => ({ tmpRoot: await tempDir('land-') });
const deadPid = async () => {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await once(child, 'close');
  return child.pid;
};
// A ticket as acquire files it, at a chosen arrival time.
async function ticket(d, { arrivedAt, owner }) {
  const name = `slot.q-${String(LANE_PRIORITY.land).padStart(2, '0')}-${String(arrivedAt).padStart(15, '0')}-000000-${owner.nonce}.json`;
  await mkdir(landDir(d, 't/r'), { recursive: true });
  await writeFile(join(landDir(d, 't/r'), name), JSON.stringify({ ...owner, priority: LANE_PRIORITY.land }));
  return name;
}
const lander = (pr, headSha) => ownerInfo({ repo: 't/r', pr, headSha, land: true });

test('the line: the live holder, the live waiters in arrival order, the dead removed; empty means neither', async () => {
  const d = await deps();
  assert.equal(lineEmpty(await lineState(d, 't/r')), true);
  const holder = atTestEnd(await acquire(slotDir(d, 't/r'), await lander(5, HEAD)));
  const dead = await ticket(d, { arrivedAt: 1, owner: { pid: await deadPid(), startTime: null, nonce: 'dead', pr: 9 } });
  await ticket(d, { arrivedAt: 3, owner: await lander(8, 'c'.repeat(40)) });
  await ticket(d, { arrivedAt: 2, owner: await lander(7, 'b'.repeat(40)) });
  const line = await lineState(d, 't/r');
  assert.equal(line.holder.pr, 5);
  assert.deepEqual(line.waiters.map((w) => w.pr), [7, 8]);
  assert.ok(!(await readdir(landDir(d, 't/r'))).includes(dead), 'the dead waiter\'s ticket is removed');
  assert.equal(lineEmpty(line), false);
  await holder();
  assert.equal(lineEmpty(await lineState(d, 't/r')), false, 'waiters alone keep the line busy');
});

test('alreadyLanding: the same PR and head in the slot, in line, or holding the head lock as a land', async () => {
  const d = await deps();
  assert.equal(await alreadyLanding(d, 't/r', { pr: 7, headSha: HEAD }), null);
  const slot = atTestEnd(await acquire(slotDir(d, 't/r'), await lander(7, HEAD)));
  assert.match(await alreadyLanding(d, 't/r', { pr: 7, headSha: HEAD }), /^PR #7 @ aaaaaaa is already landing \(pid \d+\)$/);
  assert.equal(await alreadyLanding(d, 't/r', { pr: 7, headSha: 'b'.repeat(40) }), null, 'a new head is not a duplicate');
  await slot();
  await ticket(d, { arrivedAt: 5, owner: await lander(7, HEAD) });
  assert.match(await alreadyLanding(d, 't/r', { pr: 7, headSha: HEAD }), /already landing/);
  const e = await deps();
  const check = atTestEnd(await acquire(headLockDir(e, 't/r', HEAD), await ownerInfo({ repo: 't/r', pr: 7 })));
  assert.equal(await alreadyLanding(e, 't/r', { pr: 7, headSha: HEAD }), null, 'an optional ship check of the head is waited for, not refused');
  await check();
  atTestEnd(await acquire(headLockDir(e, 't/r', HEAD), await lander(7, HEAD)));
  assert.match(await alreadyLanding(e, 't/r', { pr: 7, headSha: HEAD }), /already landing/);
});

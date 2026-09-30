import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addAcks, clearHold, listHolds, readAcks, readHold, writeHold } from '../lib/state.mjs';
import { tempDir } from './helpers.mjs';

test('holds: write, read, list, clear', async () => {
  const root = await tempDir('state-');
  assert.equal(await readHold(root, 'acme/app', 'app'), null);
  const h = await writeHold(root, 'acme/app', 'app', { reason: 'live probes failed', versionId: 'v1', sha: 'a'.repeat(40) });
  assert.equal((await readHold(root, 'acme/app', 'app')).reason, 'live probes failed');
  assert.ok(h.at);
  assert.deepEqual(Object.keys(await listHolds(root, 'acme/app')), ['app']);
  assert.equal(await clearHold(root, 'acme/app', 'app'), true);
  assert.equal(await clearHold(root, 'acme/app', 'app'), false);
  assert.deepEqual(await listHolds(root, 'acme/app'), {});
  const at = '2026-01-01T00:00:00.000Z';
  assert.equal((await writeHold(root, 'acme/app', 'app', { reason: 'restored', at })).at, at);
  assert.equal((await readHold(root, 'acme/app', 'app')).at, at);
});

test('an unreadable hold file still holds', async () => {
  const root = await tempDir('state-');
  await mkdir(join(root, 'holds', 'acme__app'), { recursive: true });
  await writeFile(join(root, 'holds', 'acme__app', 'app.json'), '{ not json');
  assert.match((await readHold(root, 'acme/app', 'app')).reason, /unreadable hold file/);
});

test('a hold file that is not a hold object still holds, and clearing it says it existed', async () => {
  const root = await tempDir('state-');
  const dir = join(root, 'holds', 'acme__app');
  await mkdir(dir, { recursive: true });
  for (const body of ['null', '{}', '[]', '{"reason":7}']) {
    await writeFile(join(dir, 'app.json'), body);
    assert.match((await readHold(root, 'acme/app', 'app')).reason, /unreadable hold file/, body);
    assert.match((await listHolds(root, 'acme/app')).app.reason, /unreadable hold file/, body);
  }
  assert.equal(await clearHold(root, 'acme/app', 'app'), true);
  assert.equal(await readHold(root, 'acme/app', 'app'), null);
});

test('a directory in place of a hold file still holds; nothing unreadable maps to no hold', async () => {
  const root = await tempDir('state-');
  await mkdir(join(root, 'holds', 'acme__app', 'app.json'), { recursive: true });
  assert.match((await readHold(root, 'acme/app', 'app')).reason, /unreadable hold file/);
  const holds = await listHolds(root, 'acme/app');
  assert.deepEqual(Object.keys(holds), ['app']);
  assert.match(holds.app.reason, /unreadable hold file/);
  await assert.rejects(clearHold(root, 'acme/app', 'app'));
});

test('an unreadable holds directory or ack ledger is an error, not an empty state', async () => {
  const root = await tempDir('state-');
  await mkdir(join(root, 'holds'), { recursive: true });
  await writeFile(join(root, 'holds', 'acme__app'), 'not a directory');
  await assert.rejects(listHolds(root, 'acme/app'), { code: 'ENOTDIR' });
  assert.match((await readHold(root, 'acme/app', 'app')).reason, /unreadable hold file/);
  await mkdir(join(root, 'acks', 'acme__app'), { recursive: true });
  await assert.rejects(readAcks(root, 'acme/app'), { code: 'EISDIR' });
  await assert.rejects(addAcks(root, 'acme/app', ['db/001.sql']), { code: 'EISDIR' });
});

test('acks: added once, per repo', async () => {
  const root = await tempDir('state-');
  assert.deepEqual(await addAcks(root, 'acme/app', ['db/001.sql', 'db/002.sql']), ['db/001.sql', 'db/002.sql']);
  assert.deepEqual(await addAcks(root, 'acme/app', ['db/002.sql', 'db/003.sql']), ['db/003.sql']);
  assert.deepEqual([...(await readAcks(root, 'acme/app'))].sort(), ['db/001.sql', 'db/002.sql', 'db/003.sql']);
  assert.equal((await readAcks(root, 'acme/other')).size, 0);
});

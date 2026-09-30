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

test('acks: added once, per repo', async () => {
  const root = await tempDir('state-');
  assert.deepEqual(await addAcks(root, 'acme/app', ['db/001.sql', 'db/002.sql']), ['db/001.sql', 'db/002.sql']);
  assert.deepEqual(await addAcks(root, 'acme/app', ['db/002.sql', 'db/003.sql']), ['db/003.sql']);
  assert.deepEqual([...(await readAcks(root, 'acme/app'))].sort(), ['db/001.sql', 'db/002.sql', 'db/003.sql']);
  assert.equal((await readAcks(root, 'acme/other')).size, 0);
});

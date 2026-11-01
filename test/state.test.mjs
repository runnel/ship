import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addAcks, addProof, clearHold, listHolds, readAcks, readClearances, readHold, recordAttempt, settleAttempt, unsettledAttempt, writeHold } from '../lib/state.mjs';
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

test('clearances: a bare ack and a proven apply share one ledger; proof outranks an ack in either order', async () => {
  const root = await tempDir('state-');
  assert.equal((await readClearances(root, 'acme/app')).size, 0);
  await addAcks(root, 'acme/app', ['db/001.sql', 'db/002.sql']);
  assert.equal(await addProof(root, 'acme/app', { kind: 'applied', file: 'db/002.sql', at: '2026-01-02T03:04:05.000Z', by: 'owner@laptop', sha256: 'a'.repeat(64), mainSha: 'b'.repeat(40), checks: 3 }), true);
  assert.equal(await addProof(root, 'acme/app', { kind: 'applied', file: 'db/003.sql', by: 'owner\t@lap\ntop', sha256: 'c'.repeat(64), mainSha: 'd'.repeat(40), checks: 1 }), true);
  await addAcks(root, 'acme/app', ['db/003.sql', 'db/004.sql']);
  const all = await readClearances(root, 'acme/app');
  assert.deepEqual([...all.keys()].sort(), ['db/001.sql', 'db/002.sql', 'db/003.sql', 'db/004.sql']);
  assert.equal(all.get('db/001.sql').kind, 'ack');
  assert.deepEqual(all.get('db/002.sql'), { kind: 'applied', at: '2026-01-02T03:04:05.000Z', by: 'owner@laptop', sha256: 'a'.repeat(64), mainSha: 'b'.repeat(40), checks: 3 });
  assert.equal(all.get('db/003.sql').kind, 'applied');
  assert.equal(all.get('db/003.sql').by, 'owner @lap top', 'a tab or newline in a field cannot break the ledger');
  assert.equal(await addProof(root, 'acme/app', { kind: 'verified', file: 'db/002.sql', by: 'someone else', sha256: 'e'.repeat(64), mainSha: 'f'.repeat(40), checks: 9 }), false, 'a proven file keeps its first proof');
  assert.equal((await readClearances(root, 'acme/app')).get('db/002.sql').by, 'owner@laptop');
  assert.deepEqual([...(await readAcks(root, 'acme/app'))].sort(), ['db/001.sql', 'db/002.sql', 'db/003.sql', 'db/004.sql'], 'ship deploy reads every kind as cleared');
});

test('a verified file is a proof too, and an attempt is not a clearance', async () => {
  const root = await tempDir('state-');
  await addProof(root, 'acme/app', { kind: 'verified', file: 'db/005.sql', by: 'o@l', sha256: 'a'.repeat(64), mainSha: 'b'.repeat(40), checks: 2 });
  assert.equal((await readClearances(root, 'acme/app')).get('db/005.sql').kind, 'verified');
  await assert.rejects(addProof(root, 'acme/app', { kind: 'ack', file: 'db/006.sql' }), /unknown proof kind/);
  await recordAttempt(root, 'acme/app', { file: 'db/007.sql', sha256: 'c'.repeat(64), by: 'o@l' });
  assert.deepEqual([...(await readAcks(root, 'acme/app'))], ['db/005.sql'], 'an attempt does not clear a file for deploy');
});

test('attempts: open until settled, per file and per content', async () => {
  const root = await tempDir('state-');
  const one = 'a'.repeat(64);
  const two = 'b'.repeat(64);
  assert.equal(await unsettledAttempt(root, 'acme/app', 'db/001.sql', one), null);
  await recordAttempt(root, 'acme/app', { file: 'db/001.sql', sha256: one, by: 'o@l', at: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(await unsettledAttempt(root, 'acme/app', 'db/001.sql', one), { at: '2026-01-01T00:00:00.000Z', by: 'o@l' });
  assert.equal(await unsettledAttempt(root, 'acme/app', 'db/001.sql', two), null, 'another content is another file');
  assert.equal(await unsettledAttempt(root, 'acme/app', 'db/002.sql', one), null);
  assert.equal(await unsettledAttempt(root, 'acme/other', 'db/001.sql', one), null);
  await settleAttempt(root, 'acme/app', { file: 'db/001.sql', sha256: one, by: 'o@l', outcome: 'refused' });
  assert.equal(await unsettledAttempt(root, 'acme/app', 'db/001.sql', one), null);
  await recordAttempt(root, 'acme/app', { file: 'db/001.sql', sha256: one, by: 'o@l', at: '2026-01-02T00:00:00.000Z' });
  assert.equal((await unsettledAttempt(root, 'acme/app', 'db/001.sql', one)).at, '2026-01-02T00:00:00.000Z', 'a later attempt opens it again');
});

test('an old two-field ledger line is a bare ack', async () => {
  const root = await tempDir('state-');
  await mkdir(join(root, 'acks'), { recursive: true });
  await writeFile(join(root, 'acks', 'acme__app'), 'db/001.sql\t2026-01-01T00:00:00.000Z\n');
  assert.deepEqual([...(await readClearances(root, 'acme/app'))], [['db/001.sql', { kind: 'ack', at: '2026-01-01T00:00:00.000Z' }]]);
});

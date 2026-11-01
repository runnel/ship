import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byNumber, clearanceLines, migrationPrefix, prefixClashes } from '../lib/migrations.mjs';

test('the prefix is the leading digits of the file name', () => {
  assert.equal(migrationPrefix('db/507_add_x.sql'), '507');
  assert.equal(migrationPrefix('db/20261017120000_add_x.sql'), '20261017120000');
  assert.equal(migrationPrefix('db/old/007_y.sql'), '007');
  assert.equal(migrationPrefix('db/seed.sql'), null);
  assert.equal(migrationPrefix('db/507.sql'), null);
});

test('clashes are the other PRs adding a file with one of our prefixes', () => {
  const ours = ['db/507_a.sql', 'db/508_b.sql'];
  const others = [{ number: 12, files: ['db/507_other.sql', 'src/x.ts'] }, { number: 9, files: ['db/508_c.sql'] }, { number: 3, files: ['db/600_d.sql'] }];
  assert.deepEqual(prefixClashes({ ours, others }), [
    { prefix: '508', number: 9, file: 'db/508_c.sql' },
    { prefix: '507', number: 12, file: 'db/507_other.sql' },
  ]);
  assert.deepEqual(prefixClashes({ ours: ['db/seed.sql'], others }), []);
});

test('mixed zero padding sorts by value', () => {
  assert.deepEqual(['db/11_b.sql', 'db/010_a.sql', 'db/0009_c.sql'].sort(byNumber), ['db/0009_c.sql', 'db/010_a.sql', 'db/11_b.sql']);
});

test('migrations sort by number, not by text', () => {
  assert.deepEqual(['db/1000_x.sql', 'db/999_y.sql', 'db/seed.sql', 'db/012_a.sql', 'db/20261017120000_z.sql'].sort(byNumber), ['db/012_a.sql', 'db/999_y.sql', 'db/1000_x.sql', 'db/20261017120000_z.sql', 'db/seed.sql']);
});

test('the ledger summary counts applied, found-in-place and acked files apart and names the newest of each', () => {
  const files = ['db/001_a.sql', 'db/002_b.sql', 'db/003_c.sql', 'db/004_d.sql', 'db/005_e.sql', 'db/006_f.sql', 'db/1000_g.sql'];
  const clearances = new Map([
    ['db/001_a.sql', { kind: 'ack', at: 't1' }], ['db/002_b.sql', { kind: 'ack', at: 't2' }],
    ['db/003_c.sql', { kind: 'applied', at: 't3', by: 'o@l', checks: 2 }], ['db/004_d.sql', { kind: 'ack', at: 't4' }],
    ['db/005_e.sql', { kind: 'applied', at: 't5', by: 'o@l', checks: 4 }], ['db/006_f.sql', { kind: 'verified', at: 't6', by: 'o@l', checks: 1 }],
    ['db/1000_g.sql', { kind: 'ack', at: 't7' }], ['gone/000_x.sql', { kind: 'ack', at: 't0' }],
  ]);
  assert.deepEqual(clearanceLines(files, clearances, { show: 2 }), [
    '  proof: 2 applied and proven by ship, 1 found in place and recorded, 4 acked only (never checked against the database)',
    '  newest applied: 005_e.sql (4 post-conditions, o@l, t5), 003_c.sql (2 post-conditions, o@l, t3)',
    '  newest found in place: 006_f.sql (1 post-conditions, o@l, t6)',
    '  newest acked only: 1000_g.sql (acked t7), 004_d.sql (acked t4)',
  ]);
  assert.deepEqual(clearanceLines(files, new Map()), ['  proof: 0 applied and proven by ship, 0 found in place and recorded, 0 acked only (never checked against the database)']);
});

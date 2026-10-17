import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrationPrefix, prefixClashes } from '../lib/migrations.mjs';

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

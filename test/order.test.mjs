import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployOrder, dependentsOf } from '../lib/order.mjs';

const d = (name, after = []) => ({ name, after });

test('dependencies first, otherwise config order', () => {
  const order = deployOrder([d('tick', ['app']), d('api', ['app']), d('app'), d('solo')]);
  assert.deepEqual(order.map((x) => x.name), ['app', 'tick', 'api', 'solo']);
});

test('unknown names and cycles fail', () => {
  assert.throws(() => deployOrder([d('a', ['nope'])]), /after: unknown deployable nope/);
  assert.throws(() => deployOrder([d('a', ['b']), d('b', ['a'])]), /after cycle: a → b → a/);
});

test('dependentsOf is transitive', () => {
  const all = [d('app'), d('mid', ['app']), d('leaf', ['mid']), d('other')];
  assert.deepEqual([...dependentsOf(all, 'app')].sort(), ['leaf', 'mid']);
  assert.deepEqual([...dependentsOf(all, 'other')], []);
});

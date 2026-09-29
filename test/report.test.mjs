import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallinn, duration } from '../lib/report.mjs';

test('tallinn converts UTC to Estonian time (summer and winter)', () => {
  assert.match(tallinn('2026-09-29T11:32:00Z'), /14:32/);
  assert.match(tallinn('2026-11-02T11:32:00Z'), /13:32/);
});

test('duration formats seconds and minutes', () => {
  assert.equal(duration(4_400), '4s');
  assert.equal(duration(432_000), '7m12s');
});

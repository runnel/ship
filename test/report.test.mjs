import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallinn, duration, scrubPaths } from '../lib/report.mjs';

test('tallinn converts UTC to Estonian time (summer and winter)', () => {
  assert.match(tallinn('2026-09-29T11:32:00Z'), /14:32/);
  assert.match(tallinn('2026-11-02T11:32:00Z'), /13:32/);
});

test('duration formats seconds and minutes', () => {
  assert.equal(duration(4_400), '4s');
  assert.equal(duration(432_000), '7m12s');
});

test('scrubPaths replaces local roots, longest first, and the home directory', () => {
  const HOME = '/ho' + 'me/u';
  const roots = { tmp: '/var/t/ship-1', mirrors: `${HOME}/.ship/mirrors`, home: HOME };
  assert.equal(scrubPaths(`Command failed: git --git-dir ${HOME}/.ship/mirrors/a__b.git fetch`, roots), 'Command failed: git --git-dir $SHIP_MIRRORS/a__b.git fetch');
  assert.equal(scrubPaths(`open /var/t/ship-1/w/c-1 and ${HOME}/x`, roots), 'open $SHIP_TMP/w/c-1 and ~/x');
  assert.equal(scrubPaths('nothing local here', roots), 'nothing local here');
});

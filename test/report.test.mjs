import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localTime, duration, scrubPaths } from '../lib/report.mjs';

test('localTime formats an instant in the given zone, across daylight saving', () => {
  assert.match(localTime('2026-09-29T11:32:00Z', { timeZone: 'Asia/Tokyo' }), /20:32/);
  assert.match(localTime('2026-09-29T11:32:00Z', { timeZone: 'America/New_York' }), /07:32/); // summer time
  assert.match(localTime('2026-11-02T11:32:00Z', { timeZone: 'America/New_York' }), /06:32/); // winter time
  assert.match(localTime('2026-09-29T23:32:00Z', { timeZone: 'Asia/Tokyo' }), /30\/09/); // the date moves with the zone
});

test('localTime defaults to SHIP_TZ, then to the system zone', () => {
  const saved = process.env.SHIP_TZ;
  process.env.SHIP_TZ = 'Asia/Tokyo';
  try {
    assert.match(localTime('2026-09-29T11:32:00Z'), /20:32/);
  } finally {
    if (saved === undefined) delete process.env.SHIP_TZ;
    else process.env.SHIP_TZ = saved;
  }
  assert.match(localTime('2026-09-29T11:32:00Z'), /^\d\d\/\d\d, \d\d:\d\d$/);
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

test('scrubPaths also replaces the system temp directory (where configs are evaluated)', () => {
  const roots = { tmp: '/var/t/T/ship-1', sysTmp: '/var/t/T', home: '/ho' + 'me/u' };
  assert.equal(scrubPaths("Cannot find module '/var/t/T/ship-config-ab12/x.mjs'", roots), "Cannot find module '$TMPDIR/ship-config-ab12/x.mjs'");
  assert.equal(scrubPaths('/var/t/T/ship-1/w/c-1', roots), '$SHIP_TMP/w/c-1'); // the longer root wins
});

test('an invalid SHIP_TZ (or zone) falls back to the system zone instead of throwing', () => {
  const saved = process.env.SHIP_TZ;
  process.env.SHIP_TZ = 'Not/AZone';
  try {
    assert.match(localTime('2026-09-29T11:32:00Z'), /^\d\d\/\d\d, \d\d:\d\d$/);
    assert.match(localTime('2026-09-29T11:32:00Z', { timeZone: 'Also/Wrong' }), /^\d\d\/\d\d, \d\d:\d\d$/);
  } finally {
    if (saved === undefined) delete process.env.SHIP_TZ;
    else process.env.SHIP_TZ = saved;
  }
});

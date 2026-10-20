import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawsFromBattery, onBatteryPower } from '../lib/power.mjs';

test('pmset says which power source the machine draws from', () => {
  const ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true\n";
  const battery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t87%; discharging; 3:20 remaining present: true\n";
  assert.equal(drawsFromBattery(battery), true);
  assert.equal(drawsFromBattery(ac), false);
  assert.equal(drawsFromBattery("Now drawing from 'UPS Power'\n"), false);
  assert.equal(drawsFromBattery(''), false);
  assert.equal(drawsFromBattery(undefined), false);
});

test('only macOS is asked, and a failing pmset means no warning', async () => {
  const asked = [];
  const run = async (...args) => { asked.push(args); return "Now drawing from 'Battery Power'\n"; };
  assert.equal(await onBatteryPower({ platform: 'linux', run }), false);
  assert.equal(asked.length, 0);
  assert.equal(await onBatteryPower({ platform: 'darwin', run }), true);
  assert.deepEqual(asked[0].slice(0, 2), ['pmset', ['-g', 'batt']]);
  assert.equal(await onBatteryPower({ platform: 'darwin', run: async () => { throw new Error('spawn pmset ENOENT'); } }), false);
});

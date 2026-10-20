import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawsFromBattery } from '../lib/power.mjs';

test('pmset says which power source the machine draws from', () => {
  const ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true\n";
  const battery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t87%; discharging; 3:20 remaining present: true\n";
  assert.equal(drawsFromBattery(battery), true);
  assert.equal(drawsFromBattery(ac), false);
  assert.equal(drawsFromBattery("Now drawing from 'UPS Power'\n"), false);
  assert.equal(drawsFromBattery(''), false);
  assert.equal(drawsFromBattery(undefined), false);
});

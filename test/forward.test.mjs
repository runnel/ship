import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { signalForwarder } from '../lib/forward.mjs';

test('the first signal goes to ship\'s whole process group, later ones to ship alone', () => {
  const sent = [];
  const forward = signalForwarder(4242, (target, sig) => sent.push([target, sig]));
  forward('SIGINT');
  forward('SIGINT');
  forward('SIGTERM');
  assert.deepEqual(sent, [[-4242, 'SIGINT'], [4242, 'SIGINT'], [4242, 'SIGTERM']]);
});

test('a target that is already gone is not an error', () => {
  const forward = signalForwarder(4242, () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); });
  assert.doesNotThrow(() => forward('SIGTERM'));
  assert.doesNotThrow(() => forward('SIGTERM'));
});

test('the wrapper still starts ship and passes its exit code on', { timeout: 150_000 }, async () => {
  const bin = fileURLToPath(new URL('../bin/ship.mjs', import.meta.url));
  const ok = await promisify(execFile)(process.execPath, [bin], { timeout: 60_000 });
  assert.match(ok.stdout, /^usage:/);
  await assert.rejects(() => promisify(execFile)(process.execPath, [bin, 'nope'], { timeout: 60_000 }), (e) => e.code === 2);
});

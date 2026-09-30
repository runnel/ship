import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoKeyOf, runSteps, newLogFile, withLane } from '../lib/shared.mjs';
import { tempDir } from './helpers.mjs';

test('repoKeyOf', () => {
  assert.equal(repoKeyOf('acme/app'), 'acme__app');
});

test('runSteps runs steps in order, honours step cwd and env, stops at the first failure', async () => {
  const dir = await tempDir('steps-');
  const logFile = join(dir, 'log');
  const lines = [];
  const r = await runSteps({
    label: 'setup', cwd: dir, env: { A: 'a' }, logFile, timeoutMin: 1, out: (l) => lines.push(l),
    steps: [
      { run: 'mkdir sub && echo "$A$B" > sub/x', env: { B: 'b' }, cwd: null },
      { run: 'test "$(cat x)" = ab', env: {}, cwd: 'sub' },
      { run: 'echo boom; exit 3', env: {}, cwd: null },
      { run: 'touch never', env: {}, cwd: null },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.step.run, 'echo boom; exit 3');
  assert.match(lines.join('\n'), /✓ setup: mkdir/);
  assert.match(lines.join('\n'), /✗ setup: echo boom; exit 3/);
  assert.match(lines.join('\n'), /  boom/);
  assert.match(await readFile(logFile, 'utf8'), /boom/);
});

test('newLogFile names the file after repo and label', async () => {
  const dir = await tempDir('logs-');
  const f = await newLogFile(dir, 'acme/app', 'deploy-abc1234');
  assert.match(f, /acme__app-deploy-abc1234-\d{8}T\d{6}Z\.log$/);
});

test('withLane holds the lane only while fn runs', async () => {
  const dir = await tempDir('lane-');
  const d = { tmpRoot: dir, pollMs: 10, out: () => {} };
  const seen = await withLane({ d, lane: 'heavy', owner: { repo: 'acme/app' }, fn: async () => (await readFile(join(dir, 'lanes', 'heavy', 'owner.json'), 'utf8')) });
  assert.match(seen, /acme\/app/);
  await assert.rejects(readFile(join(dir, 'lanes', 'heavy', 'owner.json')));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { repoKeyOf, runSteps, newLogFile, withLane, acquireShared, laneWaitReporter, ordinal, LANE_PRIORITY } from '../lib/shared.mjs';
import { ownerInfo } from '../lib/lock.mjs';
import { tempDir, waitUntil } from './helpers.mjs';

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

test('ordinal', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th']);
});

test('the lane wait line says the place in line, when it starts, when it changes, and once a minute', () => {
  const lines = [];
  const report = laneWaitReporter({ out: (l) => lines.push(l) }, 'heavy');
  const holder = { repo: 'acme/app', pr: 2116, since: '2026-11-01T15:21:00.000Z' };
  report(holder, { position: 3, ahead: [{}, {}] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^… waiting for the heavy lane \(3rd in line\): acme\/app PR #2116 since /);
  report(holder, { position: 3, ahead: [{}, {}] }); // same place, under a minute: nothing new
  assert.equal(lines.length, 1);
  report(holder, { position: 2, ahead: [{}] });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /\(2nd in line\)/);
  const t = Date.now();
  const realNow = Date.now;
  Date.now = () => t + 61_000;
  try { report(holder, { position: 2, ahead: [{}] }); } finally { Date.now = realNow; }
  assert.equal(lines.length, 3);
});

test('the lane wait line names who is next when the lane is free for a moment, and works without a line', () => {
  const lines = [];
  const report = laneWaitReporter({ out: (l) => lines.push(l) }, 'light');
  report(null, { position: 2, ahead: [{ repo: 'acme/app', command: 'deploy app', since: '2026-11-01T15:21:00.000Z' }] });
  assert.match(lines[0], /^… waiting for the light lane \(2nd in line\): free, next in line: acme\/app deploy app since /);
  const idle = [];
  laneWaitReporter({ out: (l) => idle.push(l) }, 'light')(null, { position: 1, ahead: [] });
  assert.match(idle[0], /^… waiting for the light lane \(1st in line\): changing hands$/);
  const plain = [];
  laneWaitReporter({ out: (l) => plain.push(l) }, 'light')({ repo: 'acme/app', pr: 7, since: '2026-11-01T15:21:00.000Z' });
  assert.match(plain[0], /^… waiting for the light lane: acme\/app PR #7 since /);
});

// A lane held by one check, with checks and deploys arriving behind it: deploys go first, the rest in
// arrival order, and never two inside at once.
test('a lane serves deploy work before checks and each in arrival order, one at a time', { timeout: 30_000 }, async () => {
  const dir = await tempDir('lane-');
  const lines = [];
  const d = { tmpRoot: dir, pollMs: 10, out: (l) => lines.push(l) };
  const laneDir = join(dir, 'lanes', 'heavy');
  const tickets = () => readdirSync(join(dir, 'lanes')).filter((n) => n.endsWith('.json')).length;
  const order = [];
  let inside = 0;
  let maxInside = 0;
  const work = async (label) => {
    order.push(label);
    maxInside = Math.max(maxInside, ++inside);
    await new Promise((r) => setTimeout(r, 10));
    inside--;
  };
  const holder = await acquireShared(laneDir, await ownerInfo({ repo: 'acme/app', pr: 1 }), { pollMs: 10, priority: LANE_PRIORITY.check });
  const runs = [];
  const arrive = async (label, start) => {
    const before = tickets();
    runs.push(start(label));
    await waitUntil(() => tickets() > before, `${label} to be in line`);
  };
  const check = (label) => async () => { // as check.mjs takes its place
    const release = await acquireShared(laneDir, await ownerInfo({ repo: 'acme/app', pr: Number(label.slice(2)) }), { pollMs: 10, priority: LANE_PRIORITY.check, onWait: laneWaitReporter(d, 'heavy') });
    try { await work(label); } finally { await release(); }
  };
  const deploy = (label) => () => withLane({ d, lane: 'heavy', owner: { repo: 'acme/app', command: label }, fn: () => work(label) });
  await arrive('PR2', (l) => check(l)());
  await arrive('PR3', (l) => check(l)());
  await arrive('deploy-a', (l) => deploy(l)());
  await arrive('PR4', (l) => check(l)());
  await arrive('deploy-b', (l) => deploy(l)());
  await holder();
  await Promise.all(runs);
  assert.deepEqual(order, ['deploy-a', 'deploy-b', 'PR2', 'PR3', 'PR4']);
  assert.equal(maxInside, 1);
  assert.equal(tickets(), 0);
  assert.equal(readdirSync(join(dir, 'lanes')).length, 0);
  // The waiters were told their place: the first deploy that it was next, the last check that it was behind the rest.
  assert.ok(lines.some((l) => /heavy lane \(1st in line\): acme\/app PR #1/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /heavy lane \(5th in line\)/.test(l) || /heavy lane \(4th in line\)/.test(l)), lines.join('\n'));
});

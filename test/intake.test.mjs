import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './helpers.mjs';
import { enterDeploy, followDeploy } from '../lib/intake.mjs';

const REPO = 't/r';

async function setup() {
  const lines = [];
  const d = { tmpRoot: await tempDir('intake-'), pollMs: 10, out: (l) => lines.push(l) };
  return { d, lines, enter: (names = [], redeploy = false) => enterDeploy({ d, repo: REPO, names, redeploy }) };
}

test('the first caller leads; a later one with the same request follows it', async () => {
  const s = await setup();
  const first = await s.enter();
  assert.ok(first.lead);
  const second = await s.enter();
  assert.equal(second.follow.id, (await s.enter()).follow.id);
  assert.equal(second.lead, undefined);
});

test('a request for other deployables, or a redeploy, is not joined', async () => {
  const s = await setup();
  assert.ok((await s.enter(['app'])).lead);
  assert.ok((await s.enter(['tick'])).lead);
  assert.ok((await s.enter(['app'], true)).lead);
  assert.ok((await s.enter()).lead);
  assert.ok((await s.enter(['tick', 'app'])).lead);
  assert.ok((await s.enter(['app', 'tick'])).follow, 'the order of the names does not matter');
});

test('a leader that has frozen its target, or has ended, is not joined', async () => {
  const s = await setup();
  const a = (await s.enter()).lead;
  await a.freeze();
  const b = (await s.enter()).lead;
  assert.ok(b, 'a frozen leader is not joined');
  assert.ok((await s.enter()).follow, 'the leader that came after it is');
  await a.end({ code: 0 });
  await b.end({ code: 0 });
  assert.ok((await s.enter()).lead, 'nothing is left to join');
});

test('a leader whose process is gone is not joined', async () => {
  const s = await setup();
  const dir = join(s.d.tmpRoot, 'deploys', 't__r');
  await mkdir(dir, { recursive: true });
  const feed = join(dir, '000000000000001-dead.out');
  await writeFile(feed, '');
  await writeFile(join(dir, '000000000000001-dead.json'), JSON.stringify({ id: 'dead', key: JSON.stringify({ names: [], redeploy: false }), phase: 'open', pid: 2 ** 22 + 12345, pgid: null, startTime: null, since: new Date().toISOString(), feed }));
  assert.ok((await s.enter()).lead);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.json') && f.includes('dead')), [], 'its entry is removed');
});

test('a follower prints what the leader prints and returns its status', async () => {
  const s = await setup();
  const { lead } = await s.enter();
  lead.out('before');
  const { follow } = await s.enter();
  const following = followDeploy({ d: s.d, repo: REPO, leader: follow });
  lead.out('while following');
  await lead.freeze();
  await lead.end({ code: 3 });
  assert.deepEqual(await following, { code: 3 });
  assert.match(s.lines[0], /^↪ t\/r: a deploy started at .* has not begun building; this one joins it, with the same result$/);
  assert.deepEqual(s.lines.slice(1), ['before', 'while following']);
});

test('a leader that failed after freezing is reported as failed', async () => {
  const s = await setup();
  const { lead } = await s.enter();
  const { follow } = await s.enter();
  const following = followDeploy({ d: s.d, repo: REPO, leader: follow });
  await lead.freeze();
  await lead.end({ code: 1, error: 'socket hang up' });
  assert.deepEqual(await following, { code: 1 });
  assert.ok(s.lines.includes('✗ the deploy this one joined failed: socket hang up'), s.lines.join('\n'));
});

test('a leader that ended before freezing leaves its followers to deploy for themselves', async () => {
  const s = await setup();
  const { lead } = await s.enter();
  const { follow } = await s.enter();
  const following = followDeploy({ d: s.d, repo: REPO, leader: follow });
  lead.out('✗ migrations not cleared for deploy: db/002.sql');
  await lead.end({ code: 1 });
  assert.deepEqual(await following, { code: null });
});

test('a leader that vanished leaves its followers to deploy for themselves', async () => {
  const s = await setup();
  const dir = join(s.d.tmpRoot, 'deploys', 't__r');
  await mkdir(dir, { recursive: true });
  const feed = join(dir, '000000000000001-gone.out');
  await writeFile(feed, `${JSON.stringify({ line: 'half a deploy' })}\n`);
  const leader = { id: 'gone', key: '{}', phase: 'open', pid: 2 ** 22 + 54321, pgid: null, startTime: null, since: new Date().toISOString(), feed };
  assert.deepEqual(await followDeploy({ d: s.d, repo: REPO, leader }), { code: null });
  assert.ok(s.lines.includes('half a deploy'));
});

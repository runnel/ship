import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ownerInfo, processStartTime } from '../lib/lock.mjs';
import { parseLogName, runtimeOf, readHistory, usualFor, readLanes, snapshot, render, runQueue } from '../lib/queue.mjs';
import { tempDir } from './helpers.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-11-01T16:30:00Z');

// A lane directory as the lock leaves it, and tickets as the line files them.
async function laneDir(tmpRoot, lane, owner) {
  const dir = join(tmpRoot, 'lanes', lane);
  await mkdir(dir, { recursive: true });
  if (owner) await writeFile(join(dir, 'owner.json'), JSON.stringify(owner));
  return dir;
}

async function ticket(tmpRoot, lane, { priority = 1, arrivedAt, seq = 0, owner }) {
  const num = (n, w) => String(n).padStart(w, '0');
  const name = `${lane}.q-${num(priority, 2)}-${num(arrivedAt, 15)}-${num(seq, 6)}-${owner.nonce}.json`;
  await mkdir(join(tmpRoot, 'lanes'), { recursive: true });
  await writeFile(join(tmpRoot, 'lanes', name), JSON.stringify({ ...owner, priority }));
  return name;
}

// A live owner (this process) for work done by `who`.
const live = async (who, extra = {}) => ({ ...(await ownerInfo(who)), ...extra });

// A process that has already exited: its pid is gone.
async function deadOwner(who) {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('close', resolve));
  return { pid: child.pid, pgid: child.pid, startTime: null, nonce: `dead-${child.pid}`, since: new Date(NOW).toISOString(), ...who };
}

const run = (stampMs, ms, repo = 'acme/app', kind = 'check') => ({ repo, kind, file: '/x', startMs: stampMs, endMs: stampMs + ms, ms });
const runs = (repo, kind, minutes) => minutes.map((m, i) => run(NOW - (i + 1) * 60 * MIN, m * MIN, repo, kind));

test('a log name says the repository, whether it was a check or a deploy, and when it began', () => {
  assert.deepEqual(parseLogName('acme__app-1a2b3c4-20261101T160014Z.log'), { repo: 'acme/app', kind: 'check', stampMs: Date.parse('2026-11-01T16:00:14Z') });
  // a name ending in -deploy is also a check of a repository whose name ends in -deploy
  assert.deepEqual(parseLogName('acme__app-deploy-1a2b3c4-20261101T155515Z.log'), { repo: 'acme/app', kind: 'deploy', stampMs: Date.parse('2026-11-01T15:55:15Z'), alt: { repo: 'acme/app-deploy', kind: 'check' } });
  assert.equal(parseLogName('acme__my-app-mcp-deploy-1a2b3c4-20261101T155515Z.log').repo, 'acme/my-app-mcp');
  for (const junk of ['notes.txt', 'acme__app-1a2b3c-20261101T160014Z.log', 'acme-app-1a2b3c4-20261101T160014Z.log']) assert.equal(parseLogName(junk), null, junk);
});

test('a run began when its log was created, or at its name\'s stamp when that cannot be told', () => {
  const stampMs = NOW - 20 * MIN;
  assert.deepEqual(runtimeOf({ stampMs, birthMs: NOW - 12 * MIN, mtimeMs: NOW - 3 * MIN }), { startMs: NOW - 12 * MIN, endMs: NOW - 3 * MIN, ms: 9 * MIN });
  for (const birthMs of [0, NOW]) assert.equal(runtimeOf({ stampMs, birthMs, mtimeMs: NOW - 3 * MIN }).ms, 17 * MIN, `birth ${birthMs}`);
});

test('the usual time is the median of the latest runs of one kind in one repository, and needs a few runs', () => {
  const history = [...runs('acme/app', 'check', [4, 3, 5, 40]), ...runs('acme/app', 'deploy', [9, 9, 9]), ...runs('acme/other', 'check', [1, 1, 1])];
  const usual = usualFor(history, 'acme/app', 'check');
  assert.deepEqual(usual, { n: 4, median: 5 * MIN, high: 40 * MIN });
  assert.equal(usualFor(history, 'acme/app', 'deploy').median, 9 * MIN);
  assert.equal(usualFor(history, 'acme/app', 'other'), null);
  assert.equal(usualFor(runs('acme/app', 'check', [4, 3]), 'acme/app', 'check'), null, 'two runs say nothing');
  // only the latest 20 count: an old slow run does not stay in the picture forever
  const many = [...runs('acme/app', 'check', Array(20).fill(4)), run(NOW - 1000 * 60 * MIN, 90 * MIN)];
  assert.equal(usualFor(many, 'acme/app', 'check').high, 4 * MIN);
});

test('a log that could be a deploy of one repository or a check of another counts for the one that is asked about', () => {
  const ambiguous = (ms) => ({ ...run(NOW, ms, 'acme/infra', 'deploy'), alt: { repo: 'acme/infra-deploy', kind: 'check' } });
  const history = [ambiguous(9 * MIN), ambiguous(9 * MIN), ambiguous(9 * MIN)];
  assert.equal(usualFor(history, 'acme/infra', 'deploy').median, 9 * MIN);
  assert.equal(usualFor(history, 'acme/infra-deploy', 'check').median, 9 * MIN);
  assert.equal(usualFor(history, 'acme/infra', 'check'), null);
});

test('the history is read from the log directory, newest first, and other files are ignored', async () => {
  const logRoot = await tempDir();
  const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  // Each log is begun now and last written 4 / 9 minutes from now. (A file's birth time cannot be
  // set, and the system moves it back when a modification time is set earlier than it; so these
  // are runs that end in the future, whose duration is the same whichever start is used.)
  const t = Date.now();
  for (const [prefix, mins] of [['acme__app-aaaaaaa-', 4], ['acme__app-deploy-bbbbbbb-', 9]]) {
    const f = join(logRoot, `${prefix}${stamp(t)}.log`);
    await writeFile(f, 'x');
    await utimes(f, new Date(t + mins * MIN), new Date(t + mins * MIN));
  }
  await writeFile(join(logRoot, 'README'), 'not a log');
  const history = await readHistory(logRoot);
  assert.deepEqual(history.map((r) => [r.repo, r.kind]), [['acme/app', 'deploy'], ['acme/app', 'check']]);
  assert.ok(Math.abs(history[0].ms - 9 * MIN) < 5000 && Math.abs(history[1].ms - 4 * MIN) < 5000, history.map((r) => r.ms).join(', '));
  assert.deepEqual(await readHistory(join(logRoot, 'missing')), []);
});

test('a lane shows its holder and its waiters in line order, deploy work ahead of an earlier check', async () => {
  const tmpRoot = await tempDir();
  await laneDir(tmpRoot, 'heavy', await live({ repo: 'acme/app', pr: 12 }));
  const check = await live({ repo: 'acme/app', pr: 14 });
  const early = await live({ repo: 'acme/app', pr: 13 });
  const deploy = await live({ repo: 'acme/app', command: 'deploy app' });
  await ticket(tmpRoot, 'heavy', { priority: 1, arrivedAt: NOW - 9 * MIN, owner: early });
  await ticket(tmpRoot, 'heavy', { priority: 1, arrivedAt: NOW - 5 * MIN, owner: check });
  await ticket(tmpRoot, 'heavy', { priority: 0, arrivedAt: NOW - 2 * MIN, owner: deploy });
  const lanes = await readLanes(tmpRoot);
  assert.deepEqual(lanes.map((l) => l.name), ['heavy', 'light']);
  const heavy = lanes[0];
  assert.equal(heavy.holder.pr, 12);
  assert.deepEqual(heavy.waiters.map((w) => w.owner.command ?? `PR #${w.owner.pr}`), ['deploy app', 'PR #13', 'PR #14']);
  assert.deepEqual(heavy.waiters.map((w) => w.arrivedAt), [NOW - 2 * MIN, NOW - 9 * MIN, NOW - 5 * MIN]);
  assert.deepEqual(lanes[1], { name: 'light', holder: null, stale: false, waiters: [] });
});

test('the leftovers of the lock protocol are not holders or waiters, and a waiter whose process is gone is not counted', async () => {
  const tmpRoot = await tempDir();
  const dir = await laneDir(tmpRoot, 'heavy', await live({ repo: 'acme/app', pr: 12 }));
  await mkdir(`${dir}.new-abc123`);
  await mkdir(`${dir}.takeover`);
  await mkdir(`${dir}.gone-0000`);
  await writeFile(join(tmpRoot, 'lanes', 'heavy.q-01-000000000000001-000000-x.json.tmp'), '{}');
  await writeFile(join(tmpRoot, 'lanes', 'heavy.q-01-000000000000002-000000-torn.json'), '{ not json');
  const gone = await ticket(tmpRoot, 'heavy', { arrivedAt: NOW - MIN, owner: await deadOwner({ repo: 'acme/app', pr: 99 }) });
  const waiting = await ticket(tmpRoot, 'heavy', { arrivedAt: NOW - 2 * MIN, owner: await live({ repo: 'acme/app', pr: 13 }) });
  const before = (await readdir(join(tmpRoot, 'lanes'))).sort();
  const lanes = await readLanes(tmpRoot);
  assert.deepEqual(lanes.map((l) => l.name), ['heavy', 'light']);
  assert.deepEqual(lanes[0].waiters.map((w) => w.owner.pr), [13]);
  // read only: the ticket of the gone waiter is the next in line's to remove
  assert.deepEqual((await readdir(join(tmpRoot, 'lanes'))).sort(), before);
  assert.ok(before.includes(gone) && before.includes(waiting));
});

test('a lane that only has waiters is listed, and so is a lane nobody uses', async () => {
  const tmpRoot = await tempDir();
  await ticket(tmpRoot, 'heavy', { arrivedAt: NOW - MIN, owner: await live({ repo: 'acme/app', pr: 13 }) });
  const lanes = await readLanes(tmpRoot);
  assert.equal(lanes[0].holder, null);
  assert.equal(lanes[0].waiters.length, 1);
  assert.deepEqual(await readLanes(await tempDir()), [
    { name: 'heavy', holder: null, stale: false, waiters: [] },
    { name: 'light', holder: null, stale: false, waiters: [] },
  ]);
});

test('a holder: how long, what is usual, when its log was last written', async () => {
  const logRoot = await tempDir();
  const log = join(logRoot, 'holder.log');
  await writeFile(log, 'x');
  await utimes(log, new Date(NOW - 90_000), new Date(NOW - 90_000));
  const holder = await live({ repo: 'acme/app', pr: 12, log }, { since: new Date(NOW - 7 * MIN).toISOString() });
  const history = runs('acme/app', 'check', [4, 5, 6, 4, 5]);
  const [heavy] = await snapshot({ nowMs: NOW, history, lanes: [{ name: 'heavy', holder, stale: false, waiters: [] }] });
  assert.equal(heavy.holder.text, 'acme/app PR #12');
  assert.equal(heavy.holder.heldMs, 7 * MIN);
  assert.equal(heavy.holder.usual.median, 5 * MIN);
  assert.equal(heavy.holder.stuck, false);
  assert.equal(heavy.holder.log.quietMs, 90_000);
  assert.equal(heavy.holder.log.guessed, false);
  const text = render([heavy]).join('\n');
  assert.match(text, /^heavy lane: in use\n {2}holds {5}acme\/app PR #12 {2}for 7m00s \(since [^)]+\) {2}· {2}usual 5m, 9 in 10 of the last 5 within 6m\n {12}output 1m30s ago {2}· {2}.*holder\.log$/);
});

test('a holder is possibly stuck past three times the usual run, 1.5 times the 90th percentile and five minutes, not before', async () => {
  const stuckAfter = async (history, heldMin) => {
    const holder = await live({ repo: 'acme/app', pr: 12 }, { since: new Date(NOW - heldMin * MIN).toISOString() });
    return (await snapshot({ nowMs: NOW, history, lanes: [{ name: 'heavy', holder, stale: false, waiters: [] }] }))[0].holder.stuck;
  };
  const usual = runs('acme/app', 'check', [4, 5, 6, 4, 5]); // median 5m, 90th percentile 6m: stuck past 15m
  assert.equal(await stuckAfter(usual, 14), false);
  assert.equal(await stuckAfter(usual, 16), true);
  // one freak run in the history raises the 90th percentile, not the median: the bar follows the larger
  const freak = runs('acme/app', 'check', [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 37, 37]); // median 3m, 90th percentile 37m: stuck past 55.5m
  assert.equal(await stuckAfter(freak, 50), false);
  assert.equal(await stuckAfter(freak, 56), true);
  const quick = runs('acme/app', 'check', [0.1, 0.2, 0.1]); // three times the usual is 18 s, but a build needs more than that to be called stuck
  assert.equal(await stuckAfter(quick, 4), false);
  assert.equal(await stuckAfter(quick, 6), true);
  assert.equal(await stuckAfter([], 120), false, 'without history there is nothing to compare with');
  const [stuck] = await snapshot({ nowMs: NOW, history: usual, lanes: [{ name: 'heavy', holder: await live({ repo: 'acme/app', pr: 12 }, { since: new Date(NOW - 16 * MIN).toISOString() }), stale: false, waiters: [] }] });
  assert.match(render([stuck]).join('\n'), /! possibly stuck: held for 16m00s, well over the usual 5m \(9 in 10 runs end within 6m\)/);
});

test('a stuck-looking holder says whether its log is still being written', async () => {
  const logRoot = await tempDir();
  const lineFor = async (quietMs) => {
    const log = join(logRoot, `holder-${quietMs}.log`);
    await writeFile(log, 'x');
    await utimes(log, new Date(NOW - quietMs), new Date(NOW - quietMs));
    const holder = await live({ repo: 'acme/app', pr: 12, log }, { since: new Date(NOW - 30 * MIN).toISOString() });
    const [heavy] = await snapshot({ nowMs: NOW, history: runs('acme/app', 'check', [4, 5, 6]), lanes: [{ name: 'heavy', holder, stale: false, waiters: [] }] });
    return render([heavy]).find((l) => l.includes('possibly stuck'));
  };
  assert.match(await lineFor(5_000), /\(9 in 10 runs end within 6m\), but its log is still being written$/);
  assert.match(await lineFor(2 * MIN), /\(9 in 10 runs end within 6m\)$/);
  assert.match(await lineFor(7 * MIN), /\(9 in 10 runs end within 6m\), and its log has been quiet for 7m00s$/);
});

test('a holder whose process is gone is said to be, not stuck', async () => {
  const holder = await deadOwner({ repo: 'acme/app', pr: 12 });
  const [heavy] = await snapshot({ nowMs: NOW, history: [], lanes: [{ name: 'heavy', holder: { ...holder, since: new Date(NOW - 99 * MIN).toISOString() }, stale: true, waiters: [] }] });
  assert.equal(heavy.holder.stuck, false);
  assert.match(render([heavy]).join('\n'), /✗ the holder's process is gone: the next in line takes the lane over/);
});

test('the log of a holder from before ship recorded it is found from its start time, and said to be a guess', async () => {
  const since = NOW - 6 * MIN;
  const holder = await live({ repo: 'acme/app', pr: 12 }, { since: new Date(since).toISOString() });
  const logRoot = await tempDir();
  const mine = join(logRoot, 'mine.log');
  await writeFile(mine, 'x');
  await utimes(mine, new Date(NOW - 20_000), new Date(NOW - 20_000));
  const history = [
    { repo: 'acme/app', kind: 'check', file: mine, startMs: since + 3000, endMs: NOW - 20_000, ms: 6 * MIN },
    { repo: 'acme/app', kind: 'check', file: '/other-repo-run', startMs: since - 30 * MIN, endMs: since - 25 * MIN, ms: 5 * MIN }, // finished before it took the lane
    { repo: 'acme/app', kind: 'deploy', file: '/deploy-run', startMs: since + 1000, endMs: NOW, ms: 6 * MIN },
  ];
  const [heavy] = await snapshot({ nowMs: NOW, history, lanes: [{ name: 'heavy', holder, stale: false, waiters: [] }] });
  assert.deepEqual(heavy.holder.log, { file: mine, guessed: true, quietMs: 20_000 });
});

test('waiters: how long each has waited and when it should start, from the holder\'s time left and the runs ahead', async () => {
  const holder = await live({ repo: 'acme/app', pr: 12 }, { since: new Date(NOW - 3 * MIN).toISOString() });
  const history = [...runs('acme/app', 'check', [5, 5, 5]), ...runs('acme/app', 'deploy', [8, 8, 8])];
  const waiters = [
    { priority: 0, arrivedAt: NOW - 90_000, owner: { repo: 'acme/app', command: 'deploy app' } },
    { priority: 1, arrivedAt: NOW - 4 * MIN, owner: { repo: 'acme/app', pr: 13 } },
    { priority: 1, arrivedAt: NOW - 2 * MIN, owner: { repo: 'acme/app', pr: 14 } },
  ];
  const [heavy] = await snapshot({ nowMs: NOW, history, lanes: [{ name: 'heavy', holder, stale: false, waiters }] });
  // the holder has ~2m left; then 8m of deploy, then 5m of PR #13
  assert.deepEqual(heavy.waiters.map((w) => [w.text, w.waitedMs, w.startsInMs, w.atLeast]), [
    ['acme/app deploy app', 90_000, 2 * MIN, false],
    ['acme/app PR #13', 4 * MIN, 10 * MIN, false],
    ['acme/app PR #14', 2 * MIN, 15 * MIN, false],
  ]);
  const lines = render([heavy]);
  assert.match(lines[2], /^ {2} 1\. acme\/app deploy app {2}· {2}deploy work, ahead of checks {2}· {2}waited 1m30s {2}· {2}starts in ~2m$/);
  assert.match(lines[4], /^ {2} 3\. acme\/app PR #14 {2}· {2}check {2}· {2}waited 2m00s {2}· {2}starts in ~15m$/);
});

test('a holder past its usual time makes the estimate "at least"; a waiter nothing is known about makes the rest unknown', async () => {
  const holder = await live({ repo: 'acme/app', pr: 12 }, { since: new Date(NOW - 9 * MIN).toISOString() });
  const history = runs('acme/app', 'check', [5, 5, 5]);
  const waiters = [
    { priority: 1, arrivedAt: NOW - MIN, owner: { repo: 'acme/app', pr: 13 } },
    { priority: 1, arrivedAt: NOW - MIN, owner: { repo: 'acme/newcomer', pr: 4 } },
    { priority: 1, arrivedAt: NOW - MIN, owner: { repo: 'acme/app', pr: 15 } },
  ];
  const [heavy] = await snapshot({ nowMs: NOW, history, lanes: [{ name: 'heavy', holder, stale: false, waiters }] });
  assert.deepEqual(heavy.waiters.map((w) => [w.startsInMs, w.atLeast]), [[0, true], [5 * MIN, true], [null, true]]);
  const lines = render([heavy]);
  assert.match(lines[2], /starts in ~1m\+$/);
  assert.match(lines[4], /start unknown$/);
});

test('ship queue on idle lanes, end to end: it says so, exits 0 and writes nothing', async () => {
  const tmpRoot = await tempDir();
  const logRoot = await tempDir();
  const lines = [];
  assert.equal(await runQueue({ deps: { tmpRoot, logRoot, out: (l) => lines.push(l), nowMs: NOW } }), 0);
  assert.deepEqual(lines, ['heavy lane: free', 'light lane: free']);
  assert.deepEqual(await readdir(tmpRoot), [], 'nothing created, not even the lanes directory');
});

test('ship queue on busy lanes, end to end', async () => {
  const tmpRoot = await tempDir();
  const logRoot = await tempDir();
  await laneDir(tmpRoot, 'heavy', await live({ repo: 'acme/app', pr: 12 }, { since: new Date(NOW - 2 * MIN).toISOString() }));
  await ticket(tmpRoot, 'heavy', { arrivedAt: NOW - MIN, owner: await live({ repo: 'acme/app', pr: 13 }) });
  const before = (await readdir(join(tmpRoot, 'lanes'))).sort();
  const lines = [];
  assert.equal(await runQueue({ deps: { tmpRoot, logRoot, out: (l) => lines.push(l), nowMs: NOW } }), 0);
  assert.match(lines[0], /^heavy lane: in use, 1 waiting$/);
  assert.match(lines[1], /holds {5}acme\/app PR #12 {2}for 2m00s .* {2}· {2}no run history to compare with$/);
  assert.match(lines[2], /^ {2} 1\. acme\/app PR #13 .*waited 1m00s {2}· {2}start unknown$/);
  assert.equal(lines.at(-2), 'light lane: free');
  assert.match(lines.at(-1), /^Estimates use the median/);
  assert.deepEqual((await readdir(join(tmpRoot, 'lanes'))).sort(), before);
});

const BIN = fileURLToPath(new URL('../bin/ship.mjs', import.meta.url));
const ship = (args, env) => promisify(execFile)(process.execPath, [BIN, ...args], { timeout: 20_000, env: { ...process.env, ...env } })
  .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('the ship command: `ship queue` reads the lanes of SHIP_TMP, takes no arguments and is in the usage', { timeout: 40_000 }, async () => {
  const env = { SHIP_TMP: await tempDir(), SHIP_HOME: await tempDir() };
  const r = await ship(['queue'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'heavy lane: free\nlight lane: free\n');
  const bad = await ship(['queue', '--now'], env);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /^✗ ship queue: .*--now/);
  assert.match(bad.stdout, /^ship queue {3,}who holds each lane/);
  assert.match((await ship([], env)).stdout, /ship queue /);
});

test('a check on GitHub is listed with its run, not as a lane, and is never called stuck', async () => {
  const root = await tempDir();
  const place = join(root, 'tmp', 'lanes', 'github-0');
  await mkdir(place, { recursive: true });
  const since = new Date(Date.now() - 18 * 60_000).toISOString();
  await writeFile(join(place, 'owner.json'), JSON.stringify({ pid: process.pid, startTime: await processStartTime(process.pid), nonce: 'n', since, repo: 'acme/app', pr: 12 }));
  await writeFile(join(place, 'run.json'), JSON.stringify({ runId: 5, url: 'https://example.com/runs/5' }));
  const lanes = await snapshot({ tmpRoot: join(root, 'tmp'), logRoot: join(root, 'logs') });
  const lines = render(lanes);
  const line = lines.find((l) => l.startsWith('on GitHub: acme/app PR #12'));
  assert.ok(line, lines.join('\n'));
  assert.match(line, /for 18m/);
  assert.match(line, /https:\/\/example\.com\/runs\/5$/);
  assert.ok(!lines.some((l) => l.includes('github-0') || l.includes('stuck')), lines.join('\n'));
  assert.ok(lines.includes('heavy lane: free'), 'the lanes are listed as ever');
  await rm(join(place, 'run.json'));
  const starting = render(await snapshot({ tmpRoot: join(root, 'tmp'), logRoot: join(root, 'logs') })).find((l) => l.startsWith('on GitHub:'));
  assert.match(starting, /starting$/, 'between taking the place and GitHub naming the run');
});

test('a check on Cloudflare is listed with its commit, next to one on GitHub, and neither is a lane', async () => {
  const root = await tempDir();
  const since = new Date(Date.now() - 12 * 60_000).toISOString();
  for (const [name, pr, run] of [['cloudflare-0', 12, { url: 'https://example.com/runner/commit/abc' }], ['github-0', 13, { runId: 5, url: 'https://example.com/runs/5' }], ['cloudflare-1', 14, null]]) {
    const place = join(root, 'tmp', 'lanes', name);
    await mkdir(place, { recursive: true });
    await writeFile(join(place, 'owner.json'), JSON.stringify({ pid: process.pid, startTime: await processStartTime(process.pid), nonce: name, since, repo: 'acme/app', pr }));
    if (run) await writeFile(join(place, 'run.json'), JSON.stringify(run));
  }
  const lines = render(await snapshot({ tmpRoot: join(root, 'tmp'), logRoot: join(root, 'logs') }));
  const on = (re) => lines.find((l) => re.test(l));
  assert.match(on(/^on Cloudflare: acme\/app PR #12/), /for 12m.*https:\/\/example\.com\/runner\/commit\/abc$/);
  assert.match(on(/^on GitHub: acme\/app PR #13/), /https:\/\/example\.com\/runs\/5$/);
  assert.match(on(/^on Cloudflare: acme\/app PR #14/), /starting$/, 'between taking the place and the push');
  assert.ok(!lines.some((l) => /cloudflare-|github-|stuck/.test(l)), lines.join('\n'));
  assert.ok(lines.includes('heavy lane: free'));
});

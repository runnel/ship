import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { landDeps } from '../lib/land.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { contains, decide, landedChanges, liveFor, readLiveCache, recordFloors, waitLive } from '../lib/land-live.mjs';
import { recordDeployEnd, recordDeployStart } from '../lib/land-deploy.mjs';
import { acquire, ownerInfo } from '../lib/lock.mjs';
import { iso, landDir } from '../lib/land-line.mjs';
import { addAcks, clearHold, writeHold } from '../lib/state.mjs';
import { localTime } from '../lib/report.mjs';
import { commitTimeMs, mirrorPath } from '../lib/git.mjs';
import { syncMirror } from '../lib/repo.mjs';
import { at, inProcessDeploy, requiresSetup, setupDeploy } from './deploy-fixture.mjs';
import { capture } from '../lib/proc.mjs';
import { atTestEnd, commitFiles, git, stopBackground } from './helpers.mjs';

afterEach(stopBackground, { timeout: 30_000 });

test('landedChanges: the deployables the merge commit touches and the migrations it adds', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: { 'app/src/a.ts': '2', 'db/002_x.sql': '', 'README.md': 'r' } });
  const d = { ...landDeps(), ...s.deps };
  const r = await syncMirror({ repo: 't/r', d });
  const c = await landedChanges({ d, r, mergeSha: s.head });
  assert.deepEqual(c.touched, ['app']);
  assert.deepEqual(c.added, ['db/002_x.sql']);
  assert.equal(c.config.repo, 't/r');
});

test('landedChanges: a migration the merge deletes is not one it adds', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: { 'db/002_x.sql': '' } });
  await git(['rm', '--quiet', 'db/001.sql'], s.work);
  await git(['commit', '--quiet', '-m', 'drop (#10)'], s.work);
  const dropped = (await git(['rev-parse', 'HEAD'], s.work)).trim();
  await git(['push', '--quiet', s.deps.remoteUrl(), 'main'], s.work);
  const d = { ...landDeps(), ...s.deps };
  const r = await syncMirror({ repo: 't/r', d });
  const c = await landedChanges({ d, r, mergeSha: dropped });
  assert.deepEqual(c.added, []);
  assert.deepEqual(c.touched, []);
});

const seedFirst = ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) });

// Land deps on a setupDeploy repository, with a clock that starts now and moves only when told.
function landD(s, extra = {}) {
  const clock = { t: Date.now() };
  return { clock, d: { ...landDeps(), ...s.deps, liveCacheMs: 300_000, now: () => clock.t, ...extra } };
}

test('the live cache is read through the deploy plan, then served without Cloudflare calls until it is stale', async () => {
  const s = await setupDeploy({ seed: seedFirst, change: { 'app/src/a.ts': '2' } });
  const { clock, d } = landD(s);
  const cache = await liveFor({ d, repo: 't/r' });
  assert.deepEqual(Object.keys(cache.deployables).sort(), ['app', 'tick']);
  assert.deepEqual([cache.deployables.app.state, cache.deployables.app.sha, cache.deployables.app.status], ['known', s.first, 'pending']);
  assert.equal(cache.mainSha, s.head);
  const calls = s.cloud.apiCalls.length;
  assert.ok(calls > 0);
  clock.t += 4 * 60_000;
  await liveFor({ d, repo: 't/r' });
  assert.equal(s.cloud.apiCalls.length, calls, 'fresh: no Cloudflare calls');
  await liveFor({ d, repo: 't/r', staleBeforeMs: clock.t });
  const afterDeploy = s.cloud.apiCalls.length;
  assert.ok(afterDeploy > calls, 'a deploy ended after it was read: read again');
  clock.t += 5 * 60_000;
  await liveFor({ d, repo: 't/r' });
  assert.ok(s.cloud.apiCalls.length > afterDeploy, 'five minutes old: read again');
});

test('a refresh another land is making is not waited for: the file as it is will do', async () => {
  const s = await setupDeploy({ seed: seedFirst, change: { 'app/src/a.ts': '2' } });
  const { clock, d } = landD(s);
  const cached = await liveFor({ d, repo: 't/r' });
  const busy = atTestEnd(await acquire(join(landDir(d, 't/r'), 'refresh'), await ownerInfo({ command: 'another land' })));
  clock.t += 10 * 60_000;
  const calls = s.cloud.apiCalls.length;
  assert.deepEqual(await liveFor({ d, repo: 't/r' }), cached);
  assert.equal(s.cloud.apiCalls.length, calls);
  await busy();
});

test('a cache read before a deploy ended is not handed out while another land reads it again: the tick waits', async () => {
  const s = await setupDeploy({ seed: seedFirst, change: { 'app/src/a.ts': '2' } });
  const { clock, d } = landD(s);
  await liveFor({ d, repo: 't/r' });
  const busy = atTestEnd(await acquire(join(landDir(d, 't/r'), 'refresh'), await ownerInfo({ command: 'another land' })));
  clock.t += 60_000;
  const calls = s.cloud.apiCalls.length;
  await assert.rejects(liveFor({ d, repo: 't/r', staleBeforeMs: clock.t - 1000 }),
    (e) => e.notYet === true && e.message === 'what is live in t/r is being read again after a deploy; waiting for it');
  assert.equal(s.cloud.apiCalls.length, calls);
  await busy();
  assert.ok(Date.parse((await liveFor({ d, repo: 't/r', staleBeforeMs: clock.t - 1000 })).readAt) >= clock.t - 1000, 'once the lock is free it is read again');
});

test('the oldest commit not live leaves out a held deployable\'s backlog', async () => {
  const s = await setupDeploy({ seed: seedFirst, change: { 'workers/tick/src/index.ts': '2' } });
  const { clock, d } = landD(s);
  await writeHold(s.deps.stateRoot, 't/r', 'tick', { reason: 'being looked at' });
  assert.equal((await liveFor({ d, repo: 't/r' })).oldestUnliveAtMs, null, 'only the held tick has commits to ship');
  await clearHold(s.deps.stateRoot, 't/r', 'tick');
  clock.t += 5 * 60_000;
  assert.equal((await liveFor({ d, repo: 't/r' })).oldestUnliveAtMs, await commitTimeMs(mirrorPath('t/r', d.mirrorRoot), s.head));
});

test('…and a skipped deployable\'s backlog: one that waits for a held one (`after`)', async () => {
  // tick comes after app; app is held, so tick's undeployed commit is planned as skipped.
  const s = await setupDeploy({ seed: seedFirst, change: { 'workers/tick/src/index.ts': '2' } });
  const { d } = landD(s);
  await writeHold(s.deps.stateRoot, 't/r', 'app', { reason: 'being looked at' });
  const cache = await liveFor({ d, repo: 't/r' });
  assert.equal(cache.deployables.tick.status, 'skipped');
  assert.equal(cache.oldestUnliveAtMs, null);
});

test('a refresh that was under way when a deploy ended is not trusted for that deploy', async () => {
  const s = await setupDeploy({ seed: seedFirst, change: { 'app/src/a.ts': '2' } });
  const { clock, d } = landD(s);
  let endedAt = null;
  const inner = d.fetch;
  d.fetch = async (url, init) => {
    if (endedAt === null) { // a deploy ends while this refresh reads Cloudflare
      clock.t += 1000;
      endedAt = clock.t;
    }
    return inner(url, init);
  };
  const during = await liveFor({ d, repo: 't/r' });
  assert.ok(Date.parse(during.readAt) < endedAt, 'stamped when the refresh began, before the deploy ended');
  const calls = s.cloud.apiCalls.length;
  const after = await liveFor({ d, repo: 't/r', staleBeforeMs: endedAt });
  assert.ok(s.cloud.apiCalls.length > calls, 'read again: the first read may show what was live before the deploy');
  assert.ok(Date.parse(after.readAt) >= endedAt);
});

// A commit whose committer date is `at` (unix seconds), pushed to main.
async function commitAt(s, files, message, at) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(s.work, path)), { recursive: true });
    await writeFile(join(s.work, path), content);
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost', GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` };
  await capture('git', ['add', '-A'], { cwd: s.work, env });
  await capture('git', ['commit', '--quiet', '-m', message], { cwd: s.work, env });
  const sha = (await git(['rev-parse', 'HEAD'], s.work)).trim();
  await git(['push', '--quiet', s.deps.remoteUrl(), 'main'], s.work);
  return sha;
}

test('a change and its revert leave nothing to ship: the plan says live, so there is no deadline to count from', async () => {
  const s = await setupDeploy({ seed: seedFirst, change: { 'app/src/a.ts': '2' } });
  await commitFiles(s.work, { 'app/src/a.ts': 'export const a = 1;\n' }, 'revert (#10)');
  await git(['push', '--quiet', s.deps.remoteUrl(), 'main'], s.work);
  const { d } = landD(s);
  const cache = await liveFor({ d, repo: 't/r' });
  assert.equal(cache.deployables.app.status, 'live');
  assert.equal(cache.oldestUnliveAtMs, null);
});

test('the oldest commit not live is the oldest pending one, whichever deployable it is for', async () => {
  const s = await setupDeploy({ seed: seedFirst });
  const old = await commitAt(s, { 'workers/tick/src/index.ts': 'export default { a: 1 };\n' }, 'older (#11)', 1_700_000_000);
  await commitAt(s, { 'app/src/a.ts': '3' }, 'newer (#12)', 1_700_000_005);
  const { d } = landD(s);
  const cache = await liveFor({ d, repo: 't/r' });
  assert.equal(cache.deployables.app.status, 'pending');
  assert.equal(cache.oldestUnliveAtMs, 1_700_000_000_000);
  assert.equal(cache.oldestUnliveAtMs, await commitTimeMs(mirrorPath('t/r', d.mirrorRoot), old));
});

test('a blocked deployable\'s backlog is left out too (it imports files outside its paths)', async () => {
  const s = await setupDeploy({ seed: seedFirst, change: { 'workers/tick/src/index.ts': "import '../../../app/src/a.ts';\nexport default {};\n" } });
  const { d } = landD(s);
  const cache = await liveFor({ d, repo: 't/r' });
  assert.equal(cache.deployables.tick.status, 'blocked');
  assert.equal(cache.oldestUnliveAtMs, null);
});

test('liveFor with no cache yet and another land reading: the tick waits, saying it has not been read', async () => {
  const s = await setupDeploy({ seed: seedFirst, change: { 'app/src/a.ts': '2' } });
  const { d } = landD(s);
  const busy = atTestEnd(await acquire(join(landDir(d, 't/r'), 'refresh'), await ownerInfo({ command: 'another land' })));
  await assert.rejects(liveFor({ d, repo: 't/r' }), (e) => e.notYet === true && e.message === 'what is live in t/r has not been read yet; waiting for it');
  await busy();
});

test('contains: equal counts, a later commit has its ancestor, an earlier one does not', async () => {
  const s = await setupDeploy({ seed: seedFirst, change: { 'app/src/a.ts': '2' } });
  const { d } = landD(s);
  const r = await syncMirror({ repo: 't/r', d });
  assert.equal(await contains({ d, repo: 't/r', mirror: r.mirror, ancestor: s.first, sha: s.first }), true);
  assert.equal(await contains({ d, repo: 't/r', mirror: r.mirror, ancestor: s.first, sha: s.head }), true);
  assert.equal(await contains({ d, repo: 't/r', mirror: r.mirror, ancestor: s.head, sha: s.first }), false);
});

test('contains: a commit the mirror lacks is fetched for once; one still missing is false', async () => {
  const s = await setupDeploy({ seed: seedFirst, change: { 'app/src/a.ts': '2' } });
  const { d } = landD(s);
  const r = await syncMirror({ repo: 't/r', d });
  const later = await commitFiles(s.work, { 'app/src/a.ts': '3' }, 'later (#10)');
  await git(['push', '--quiet', s.deps.remoteUrl(), 'main'], s.work);
  assert.equal(await contains({ d, repo: 't/r', mirror: r.mirror, ancestor: s.head, sha: later }), true, 'fetched, then found');
  assert.equal(await contains({ d, repo: 't/r', mirror: r.mirror, ancestor: s.head, sha: 'a'.repeat(40) }), false, 'not there even after the fetch');
  assert.equal(await contains({ d, repo: 't/r', mirror: r.mirror, ancestor: 'b'.repeat(40), sha: later }), false, 'an ancestor the mirror lacks');
});

const MERGE = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const LAND = { deployAfterMin: 60, debounceSec: 120, liveWaitHours: 12 };
const T0 = Date.parse('2026-11-10T12:00:00Z');
const facts = (over = {}) => ({
  tip: TIP, live: { app: { sha: TIP, contains: false, blocked: false } }, holds: {}, uncleared: [], tipUncleared: [], migrations: [],
  requires: [], deployRunning: false, deployedOk: null, failed: null, lineEmpty: true, tipAtMs: T0 - 10_000, oldestUnliveAtMs: T0 - 10_000, ...over,
});
const step = (f, extra = {}) => decide({ facts: f, pr: 7, mergeSha: MERGE, touched: ['app'], added: [], land: LAND, nowMs: T0, quietSinceMs: 0, ...extra });

test('decide, step 1: live by ancestry; held, blocked or no live commit never count', () => {
  assert.deepEqual(step(facts({ live: { app: { sha: TIP, contains: true, blocked: false } } })), { done: 0, line: '✓ PR #7 is live (merged as aaaaaaa): app at bbbbbbb' });
  assert.notEqual(step(facts({ live: { app: { sha: TIP, contains: true, blocked: true } } })).done, 0);
  assert.notEqual(step(facts({ live: { app: { sha: null, contains: false, blocked: false } } })).done, 0);
  const held = step(facts({ live: { app: { sha: TIP, contains: true, blocked: false } }, holds: { app: { reason: 'probe failed', at: null } } }));
  assert.deepEqual(held, { done: 3, line: '✗ PR #7 merged as aaaaaaa but not live: app is held since ?: probe failed — the owner decides; ship status' });
});

test('decide: a migration-only PR is live once its migration is cleared, and waits until then', () => {
  const only = { touched: [], added: ['db/002_x.sql'] };
  assert.deepEqual(step(facts({ uncleared: ['db/002_x.sql'], tipUncleared: [{ file: 'db/002_x.sql', ours: true, by: '#7' }] }), only), { wait: 'migration' });
  assert.deepEqual(step(facts(), only), { done: 0, line: '✓ PR #7 is live (merged as aaaaaaa): 1 migration(s) cleared' });
});

test('decide, steps 6 and 2–4 in order: a failed deploy, a migration at the tip, a hold, a requirement', () => {
  const failed = { tip: TIP, code: 1, log: '/x.out' };
  assert.deepEqual(step(facts({ failed, tipUncleared: [{ file: 'db/9.sql', ours: false, by: '#12' }] })), { done: 3, line: '✗ PR #7 merged as aaaaaaa but not live: the deploy of main@bbbbbbb ended with exit 1 (output: /x.out) — the owner decides; ship status' });
  assert.deepEqual(step(facts({ tipUncleared: [{ file: 'db/9.sql', ours: false, by: '#12' }], holds: { app: { reason: 'x', at: null } } })), { wait: 'migration' }, 'the migration gate comes before the hold');
  assert.equal(step(facts({ holds: { app: { reason: 'x', at: null } } })).done, 3);
  const unmet = { repo: 't/api', deployable: 'app', floor: 'c'.repeat(40), met: false, now: 'live at ddddddd' };
  assert.deepEqual(step(facts({ requires: [unmet] })), { wait: 'requires', line: '… waiting for t/api app to be live at or past ccccccc (live at ddddddd)' });
  assert.deepEqual(step(facts({ deployRunning: true })), { wait: 'deploying', line: '… a deploy of this repository is running; waiting for it to end' });
});

test('decide: the current tip whose deploy ended ok is not deployed again; it waits for the live cache', () => {
  const r = step(facts({ deployedOk: { tip: TIP } }));
  assert.equal(r.deploy, undefined);
  assert.deepEqual(r, { wait: 'live', line: '… the deploy of main@bbbbbbb ended ok; waiting for it to show as live' });
  assert.equal(step(facts({ deployedOk: { tip: TIP }, live: { app: { sha: TIP, contains: true, blocked: false } } })).done, 0, 'live wins');
});

test('decide: an ok deploy of an older tip is ignored; this merge deploys on debounce or deadline', () => {
  const OLD = 'c'.repeat(40);
  assert.deepEqual(step(facts({ deployedOk: { tip: OLD }, tipAtMs: T0 - 120_000 })), { deploy: true, why: 'the land line has been quiet for 120 s' });
  assert.deepEqual(step(facts({ deployedOk: { tip: OLD }, lineEmpty: false, tipAtMs: T0 - 600_000, oldestUnliveAtMs: T0 - 60 * 60_000 })), { deploy: true, why: 'a merge has waited 60 min' });
  assert.equal(step(facts({ deployedOk: { tip: OLD }, tipAtMs: T0 - 10_000 })).wait, 'debounce');
});

test('decide: failed, a migration, a hold, a requirement and a running deploy all outrank a matching deployedOk', () => {
  const ok = { deployedOk: { tip: TIP } };
  assert.equal(step(facts({ ...ok, failed: { tip: TIP, code: 1, log: '/x.out' } })).done, 3);
  assert.equal(step(facts({ ...ok, tipUncleared: [{ file: 'db/9.sql', ours: false, by: '#12' }] })).wait, 'migration');
  assert.equal(step(facts({ ...ok, holds: { app: { reason: 'x', at: null } } })).done, 3);
  assert.equal(step(facts({ ...ok, requires: [{ repo: 't/api', deployable: 'app', floor: 'c'.repeat(40), now: 'd'.repeat(7), met: false }] })).wait, 'requires');
  assert.equal(step(facts({ ...ok, deployRunning: true })).wait, 'deploying');
});

test('decide: no backlog (null) counts the deadline from the tip, not from 1970', () => {
  const r = step(facts({ lineEmpty: false, tipAtMs: T0 - 10_000, oldestUnliveAtMs: null }));
  assert.equal(r.wait, 'debounce');
  assert.deepEqual(step(facts({ lineEmpty: false, tipAtMs: T0 - 60 * 60_000, oldestUnliveAtMs: null })), { deploy: true, why: 'a merge has waited 60 min' });
});

test('decide: the debounce wait line names the quiet time and the deadline', () => {
  const r = step(facts({ lineEmpty: false, tipAtMs: T0 - 10_000, oldestUnliveAtMs: T0 - 10 * 60_000 }));
  const when = localTime(new Date(T0 + 50 * 60_000).toISOString());
  assert.deepEqual(r, { wait: 'debounce', line: `… merged as aaaaaaa; the deploy starts once the land line has been quiet for 120 s, or by ${when}` });
});

test('decide: a change with no net effect counts as live by the caller\'s `contains`', () => {
  // gather sets contains when the cache says live and the merge is an ancestor of its mainSha,
  // even though the live commit never moved past the merge.
  assert.equal(step(facts({ live: { app: { sha: MERGE, contains: true, blocked: false } } })).done, 0);
});

test('decide, step 5: deploy once the line has been quiet for debounceSec, or at deployAfterMin', () => {
  assert.equal(step(facts({ tipAtMs: T0 - 119_000 })).wait, 'debounce');
  assert.deepEqual(step(facts({ tipAtMs: T0 - 120_000 })), { deploy: true, why: 'the land line has been quiet for 120 s' });
  assert.equal(step(facts({ tipAtMs: T0 - 600_000 }), { quietSinceMs: T0 - 60_000 }).wait, 'debounce', 'the line was busy a minute ago');
  assert.equal(step(facts({ lineEmpty: false, tipAtMs: T0 - 600_000, oldestUnliveAtMs: T0 - 59 * 60_000 })).wait, 'debounce');
  assert.deepEqual(step(facts({ lineEmpty: false, tipAtMs: T0 - 600_000, oldestUnliveAtMs: T0 - 60 * 60_000 })), { deploy: true, why: 'a merge has waited 60 min' });
});

// A repository as setupDeploy makes it (or `from`, one made already), whose last commit on main
// (`change (#9)`, or what `merge(s)` returns) is the merge a land waits for. The clock starts now and
// moves when the land sleeps; `ticks` holds the number of Cloudflare calls made so far at each of the
// land's 30 s sleeps, and `onTick(n, { s, d, starts })` runs at the nth.
async function landed({ change = { 'app/src/a.ts': '2' }, seed = seedFirst, ack = ['db/001.sql'], land = {}, from = null, merge = async (s) => s.head, onTick = async () => {} } = {}) {
  const s = from ?? await setupDeploy({ seed, change });
  if (ack.length > 0) await addAcks(s.deps.stateRoot, 't/r', ack);
  const mergeSha = await merge(s);
  const clock = { t: Date.now() };
  const starts = [];
  const ticks = [];
  const d = {
    ...landDeps(), ...s.deps, liveCacheMs: 300_000, liveTickMs: 30_000, keepAwake: () => ({ stop() {} }),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      if (ms === 30_000) {
        ticks.push(s.cloud.apiCalls.length);
        await onTick(ticks.length, { s, d, starts });
      }
    },
  };
  d.startDeploy = inProcessDeploy(starts);
  const r = await syncMirror({ repo: 't/r', d });
  const changes = await landedChanges({ d, r, mergeSha });
  changes.config = { ...changes.config, land: { ...changes.config.land, ...land } };
  const wait = (over = {}) => waitLive({ d, repo: 't/r', cwd: s.work, pr: 9, mergeSha, mergedAtMs: clock.t, changes, floors: {}, ...over });
  return { s, d, clock, starts, ticks, mergeSha, wait };
}
const tipTime = (l) => commitTimeMs(mirrorPath('t/r', l.d.mirrorRoot), l.s.head);

test('live by ancestry: a later deploy past the merge commit counts, and nothing is deployed', async () => {
  const l = await landed();
  const later = await commitFiles(l.s.work, { 'app/src/b.ts': '3' }, 'later (#10)');
  await git(['push', '--quiet', l.d.remoteUrl(), 'main'], l.s.work);
  const v = l.s.cloud.addVersion('example-app', { message: `sha:${later} x` });
  l.s.cloud.addDeployment('example-app', v.id, { message: `sha:${later} x` });
  assert.equal(await l.wait(), 0, l.s.lines.join('\n'));
  assert.equal(l.s.lines.at(-1), `✓ PR #9 is live (merged as ${l.s.head.slice(0, 7)}): app at ${later.slice(0, 7)}`);
  assert.deepEqual(l.starts, []);
});

test('a hold on a deployable the PR touches ends the land with 3; a hold elsewhere does not stop it', async () => {
  const here = await landed();
  await writeHold(here.s.deps.stateRoot, 't/r', 'app', { reason: 'probe failed after the deploy' });
  assert.equal(await here.wait(), 3);
  assert.match(here.s.lines.at(-1), /^✗ PR #9 merged as [0-9a-f]{7} but not live: app is held since .+: probe failed after the deploy — the owner decides; ship status$/);
  assert.deepEqual(here.starts, []);

  const elsewhere = await landed();
  await writeHold(elsewhere.s.deps.stateRoot, 't/r', 'tick', { reason: 'being looked at' });
  assert.equal(await elsewhere.wait(), 0, elsewhere.s.lines.join('\n'));
  assert.equal(elsewhere.starts.length, 1, 'the deploy ran (and returned 1 for the held tick)');
  assert.match(elsewhere.s.lines.at(-1), /^✓ PR #9 is live \(merged as [0-9a-f]{7}\): app at [0-9a-f]{7}$/);
});

test('a migration-only PR prints the clearing hint, waits, and is live once its migration is cleared', async () => {
  const m = await landed({ change: { 'db/002_x.sql': '' }, onTick: async (n, { s }) => { if (n === 2) await addAcks(s.deps.stateRoot, 't/r', ['db/002_x.sql']); } });
  assert.equal(await m.wait(), 0, m.s.lines.join('\n'));
  assert.ok(m.s.lines.includes('! PR #9 added migration(s) not cleared for deploy: db/002_x.sql; ship land waits until they are'), m.s.lines.join('\n'));
  assert.ok(m.s.lines.some((l) => l.includes('ship migrations ack 002_x.sql')), 'the hint of the PR that added it');
  assert.equal(m.s.lines.at(-1), `✓ PR #9 is live (merged as ${m.s.head.slice(0, 7)}): 1 migration(s) cleared`);
  assert.deepEqual(m.starts, []);
});

test('an uncleared migration at the tip from another PR makes the land wait without the hint; liveWaitHours ends it with 3', async () => {
  const o = await landed({ land: { liveWaitHours: 0.02 } });
  await commitFiles(o.s.work, { 'db/003_y.sql': '' }, 'another migration (#10)');
  await git(['push', '--quiet', o.d.remoteUrl(), 'main'], o.s.work);
  assert.equal(await o.wait(), 3);
  assert.ok(o.s.lines.includes('… waiting for migration db/003_y.sql (#10)'), o.s.lines.join('\n'));
  assert.ok(!o.s.lines.some((l) => l.includes('ship migrations ack')), 'the hint is for the PR that added it');
  assert.deepEqual(o.starts, []);
  assert.equal(o.s.lines.at(-1), `✗ PR #9 merged as ${o.s.head.slice(0, 7)} but not live after 0.02 h — ship status`);
});

test('the deploy starts once the line has been quiet for debounceSec; ticks make no Cloudflare calls between refreshes', async () => {
  const l = await landed();
  const tipAt = await tipTime(l);
  assert.equal(await l.wait(), 0, l.s.lines.join('\n'));
  assert.equal(l.starts.length, 1);
  const waited = l.starts[0].at - tipAt;
  assert.ok(waited >= 120_000 && waited < 120_000 + 30_000 + 10_000, String(waited));
  assert.match(l.s.lines.join('\n'), /▸ deploying t\/r main@[0-9a-f]{7} \(the land line has been quiet for 120 s\), detached/);
  const beforeDeploy = l.ticks.slice(0, -1);
  assert.ok(beforeDeploy.length >= 3, String(l.ticks));
  assert.equal(new Set(beforeDeploy).size, 1, `a tick reads the cache, not Cloudflare: ${l.ticks}`);
  assert.ok(l.ticks.at(-1) > beforeDeploy[0], 'the deploy itself calls Cloudflare; the next tick reads the cache again and finds it live');
});

test('with the line busy, the deploy starts deployAfterMin after the oldest merge that is not live', async () => {
  const l = await landed({ land: { deployAfterMin: 5 } });
  await mkdir(landDir(l.d, 't/r'), { recursive: true });
  const waiter = await ownerInfo({ repo: 't/r', pr: 99, headSha: 'f'.repeat(40), land: true });
  await writeFile(join(landDir(l.d, 't/r'), `slot.q-01-${String(Date.now()).padStart(15, '0')}-000000-${waiter.nonce}.json`), JSON.stringify(waiter));
  const oldest = await tipTime(l);
  assert.equal(await l.wait(), 0, l.s.lines.join('\n'));
  assert.equal(l.starts.length, 1);
  assert.ok(l.starts[0].at - oldest >= 5 * 60_000, String(l.starts[0].at - oldest));
  assert.match(l.s.lines.join('\n'), /\(a merge has waited 5 min\), detached/);
});

test('two lands that decide at once start one deploy', async () => {
  const l = await landed();
  assert.deepEqual(await Promise.all([l.wait(), l.wait()]), [0, 0], l.s.lines.join('\n'));
  assert.equal(l.starts.length, 1);
  assert.equal((await l.s.cloud.wranglerCalls()).filter((c) => c.cmd === 'versions upload').length, 1);
});

test('a failed deploy is recorded: the land exits 3, and no land deploys that tip again', async () => {
  const l = await landed();
  const mergedAtMs = l.clock.t;
  await l.s.cloud.setWrangler({ 'versions upload': { exit: 1, create: false } });
  assert.equal(await l.wait(), 3);
  assert.match(l.s.lines.at(-1), /^✗ PR #9 merged as [0-9a-f]{7} but not live: the deploy of main@[0-9a-f]{7} ended with exit 1 \(output: .+\) — the owner decides; ship status$/);
  assert.equal(l.starts.length, 1);
  assert.equal(await l.wait({ mergedAtMs }), 3, 'another land whose merge that deploy carried');
  assert.equal(l.starts.length, 1, 'nobody deploys the same tip again');
});

test('requires with a floor: the land waits until the required deployable is live at or past it, not at its current main', async () => {
  const rq = await requiresSetup();
  const third = await commitFiles(rq.other.work, { 'src/x.ts': '3' }, 'api change 2');
  await git(['push', '--quiet', 'origin', 'main'], rq.other.work);
  const l = await landed({ from: rq.s, ack: [], onTick: async (n, { s }) => {
    if (n !== 3) return;
    const v = s.cloud.addVersion('example-api', { message: `sha:${rq.otherSecond} x` });
    s.cloud.addDeployment('example-api', v.id, { message: `sha:${rq.otherSecond} x` });
  } });
  assert.equal(await l.wait({ floors: { 't/api': rq.otherSecond } }), 0, l.s.lines.join('\n'));
  assert.ok(l.s.lines.includes(`… waiting for t/api app to be live at or past ${rq.otherSecond.slice(0, 7)} (live at ${rq.otherFirst.slice(0, 7)})`), l.s.lines.join('\n'));
  assert.equal(l.starts.length, 1);
  assert.ok(l.s.lines.includes(`✓ requires t/api app: live at or past ${rq.otherSecond.slice(0, 7)}`), 'the deploy was given the floor');
  // Fails if the floor were t/api's current main: main (third) is past the floor, but the app is only
  // live at the floor (otherSecond), so the land passed on the floor, not on main.
  const api = await readLiveCache(l.d, 't/api');
  assert.equal(api.mainSha, third, 't/api main is past the floor');
  assert.equal(api.deployables.app.sha, rq.otherSecond, 'and its app is live at the floor, not at main');
});

test('right after a deploy, a cache another land is still reading again is not judged by: the land waits a tick', async () => {
  // The deploy returns 1 (a hold on tick, which this PR does not touch) while app goes live. Judged by
  // the cache from before the deploy, that would read "not live, and a failed deploy": exit 3.
  let busy = null;
  const l = await landed({ onTick: async (n, { d, starts }) => {
    if (starts.length === 1 && busy === null) busy = await acquire(join(landDir(d, 't/r'), 'refresh'), await ownerInfo({ command: 'another land' }));
    else if (busy) { await busy(); busy = false; }
  } });
  await writeHold(l.s.deps.stateRoot, 't/r', 'tick', { reason: 'being looked at' });
  assert.equal(await l.wait(), 0, l.s.lines.join('\n'));
  assert.ok(l.s.lines.includes('! could not read what is live (what is live in t/r is being read again after a deploy; waiting for it); trying again every 30 s'), l.s.lines.join('\n'));
  assert.equal(l.starts.length, 1);
});

test('a held deployable\'s old backlog does not turn off the debounce', async () => {
  // tick has an undeployed commit from two hours ago and is held; the merge under test touches app.
  const l = await landed({
    change: null, land: { liveWaitHours: 0.02 },
    merge: async (s) => {
      await writeHold(s.deps.stateRoot, 't/r', 'tick', { reason: 'being looked at' });
      await mkdir(join(s.work, 'workers', 'tick', 'src'), { recursive: true });
      await writeFile(join(s.work, 'workers', 'tick', 'src', 'index.ts'), '2');
      await git(['add', '-A'], s.work);
      const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      await capture('git', ['commit', '--quiet', '-m', 'old tick change (#5)'], { cwd: s.work,
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost', GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
      const merged = await commitFiles(s.work, { 'app/src/a.ts': '2' }, 'change (#9)');
      await git(['push', '--quiet', s.deps.remoteUrl(), 'main'], s.work);
      return merged;
    },
  });
  await mkdir(landDir(l.d, 't/r'), { recursive: true });
  const waiter = await ownerInfo({ repo: 't/r', pr: 99, headSha: 'f'.repeat(40), land: true });
  await writeFile(join(landDir(l.d, 't/r'), `slot.q-01-${String(Date.now()).padStart(15, '0')}-000000-${waiter.nonce}.json`), JSON.stringify(waiter));
  assert.equal(await l.wait(), 3, l.s.lines.join('\n'));
  assert.deepEqual(l.starts, [], 'the line is busy and the merge is minutes old: no deploy yet');
});

test('a deploy started by hand: the land sees the deploy lock go free and reads what is live at once', async () => {
  let lock = null;
  const l = await landed({ onTick: async (n, { s, d }) => {
    if (n === 1) lock = await acquire(join(d.tmpRoot, 'locks', 'deploy-t__r'), await ownerInfo({ repo: 't/r', command: 'deploy' }));
    if (n === 3) { // the manual deploy ships the merge and ends
      const v = s.cloud.addVersion('example-app', { message: `sha:${s.head} x` });
      s.cloud.addDeployment('example-app', v.id, { message: `sha:${s.head} x` });
      await lock();
    }
  } });
  assert.equal(await l.wait(), 0, l.s.lines.join('\n'));
  assert.deepEqual(l.starts, [], 'live after the manual deploy, before the debounce would start one');
  assert.ok(l.ticks.length <= 3, String(l.ticks));
});

test('a change and its revert: the plan calls the deployable live although its live commit never moved past the merge', async () => {
  const l = await landed();
  await commitFiles(l.s.work, { 'app/src/a.ts': 'export const a = 1;\n' }, 'revert (#10)');
  await git(['push', '--quiet', l.d.remoteUrl(), 'main'], l.s.work);
  assert.equal(await l.wait(), 0, l.s.lines.join('\n'));
  assert.deepEqual(l.starts, []);
  assert.equal(l.s.lines.at(-1), `✓ PR #9 is live (merged as ${l.s.head.slice(0, 7)}): app at ${l.s.first.slice(0, 7)}`);
});

test('the tip whose deploy ended ok is not deployed again: the land waits for it to show as live, then ends with 3', async () => {
  const l = await landed({ land: { liveWaitHours: 0.06 } }); // past the 120 s debounce, so only the guard keeps the deploy away
  await recordDeployEnd({ d: l.d, repo: 't/r', id: 'x1', tip: l.s.head, code: 0, log: '/dev/null' });
  assert.equal(await l.wait(), 3);
  assert.deepEqual(l.starts, []);
  assert.ok(l.s.lines.includes(`… the deploy of main@${l.s.head.slice(0, 7)} ended ok; waiting for it to show as live`), l.s.lines.join('\n'));
});

test('a deploy that stopped at an uncleared migration is not a failure of this land: the deploy is started again', async () => {
  const l = await landed();
  await recordDeployEnd({ d: l.d, repo: 't/r', id: 'x1', tip: l.s.head, code: 1, log: '/dev/null', migrationsWaiting: true });
  assert.equal(await l.wait(), 0, l.s.lines.join('\n'));
  assert.equal(l.starts.length, 1);
});

test('a deploy carries every merge below its tip: a later land\'s floor is met before A\'s tick ships it', async () => {
  // A merged with floor F1 (t/api live at it); B, merged after A on top of it, needs t/api at F2, which
  // is not live yet. A's tick must not ship B's merge under A's own floor.
  const rq = await requiresSetup();
  let apiLiveAt = null;
  const l = await landed({ from: rq.s, ack: [], onTick: async (n, { s, d }) => {
    if (n !== 7) return;
    apiLiveAt = d.now();
    const v = s.cloud.addVersion('example-api', { message: `sha:${rq.otherSecond} x` });
    s.cloud.addDeployment('example-api', v.id, { message: `sha:${rq.otherSecond} x` });
  } });
  const b = await commitFiles(l.s.work, { 'app/src/a.ts': '3' }, 'b change (#10)');
  await git(['push', '--quiet', l.d.remoteUrl(), 'main'], l.s.work);
  await recordFloors({ d: l.d, repo: 't/r', mergeSha: b, floors: { 't/api': rq.otherSecond } });
  assert.equal(await l.wait({ floors: { 't/api': rq.otherFirst } }), 0, l.s.lines.join('\n'));
  assert.ok(l.s.lines.some((x) => x.startsWith(`… waiting for t/api app to be live at or past ${rq.otherSecond.slice(0, 7)} (live at ${rq.otherFirst.slice(0, 7)}) before deploying`)), l.s.lines.join('\n'));
  assert.equal(l.starts.length, 1);
  assert.ok(l.starts[0].at > apiLiveAt, 'the deploy of the tip that carries B waited for B\'s floor');
  assert.ok(l.s.lines.includes(`✓ requires t/api app: live at or past ${rq.otherSecond.slice(0, 7)}`), 'the deploy was given the newest floor');
});

test('a floor recorded for a merge the tip does not carry is not held to', async () => {
  const rq = await requiresSetup();
  const l = await landed({ from: rq.s, ack: [] });
  await recordFloors({ d: l.d, repo: 't/r', mergeSha: 'c'.repeat(40), floors: { 't/api': rq.otherSecond } });
  assert.equal(await l.wait({ floors: { 't/api': rq.otherFirst } }), 0, l.s.lines.join('\n'));
  assert.equal(l.starts.length, 1);
});

test('waitLive with no floor for a required repository holds it to that repository\'s main now', async () => {
  const rq = await requiresSetup();
  const l = await landed({ from: rq.s, ack: [], land: { liveWaitHours: 0.02 } });
  assert.equal(await l.wait(), 3);
  assert.ok(l.s.lines.includes(`… waiting for t/api app to be live at or past ${rq.otherSecond.slice(0, 7)} (live at ${rq.otherFirst.slice(0, 7)})`), l.s.lines.join('\n'));
  assert.deepEqual(l.starts, []);
});

test('maybeDeploy\'s own check: a deploy of the tip that ended ok after the land decided is not started again', async () => {
  const l = await landed({ land: { liveWaitHours: 0.06 } });
  const orig = l.d.now;
  let armed = false;
  // The record appears after gather has read the deploys and before maybeDeploy does: the first
  // time the land itself (decide's nowMs) asks for the time once the debounce has passed.
  l.d.now = () => {
    if (!armed && orig() - l.clock.t0 >= 120_000 && new Error().stack.split('\n')[2].includes('waitLive')) {
      armed = true;
      const dir = join(landDir(l.d, 't/r'), 'deploys');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${l.s.head}-zz.end.json`), JSON.stringify({ id: 'zz', tip: l.s.head, code: 0, log: '/dev/null', migrationsWaiting: false, endedAt: iso({ now: orig }) }));
    }
    return orig();
  };
  l.clock.t0 = l.clock.t;
  assert.equal(await l.wait(), 3);
  assert.ok(armed, 'the record was written between the read and the decision');
  assert.deepEqual(l.starts, []);
});

test('an error starting the deploy is said once and tried again next tick, not the end of the land', async () => {
  const l = await landed();
  const real = l.d.startDeploy;
  let failed = false;
  l.d.startDeploy = async (a) => {
    if (!failed) { failed = true; throw new Error('spawn boom'); }
    return real(a);
  };
  assert.equal(await l.wait(), 0, l.s.lines.join('\n'));
  assert.equal(l.s.lines.filter((x) => x === '! could not decide or start the deploy (spawn boom); trying again every 30 s').length, 1);
  assert.equal(l.starts.length, 1);
});

test('floors that diverge (a force-push) go to the later record, whichever land looks', async () => {
  const rq = await requiresSetup();
  const l = await landed({ from: rq.s, ack: [], land: { liveWaitHours: 0.06 } });
  const b = await commitFiles(l.s.work, { 'app/src/a.ts': '3' }, 'b change (#10)');
  await git(['push', '--quiet', l.d.remoteUrl(), 'main'], l.s.work);
  const put = (mergeSha, floor, at) => writeFile(join(landDir(l.d, 't/r'), 'floors', `${mergeSha}.json`), JSON.stringify({ mergeSha, floors: { 't/api': floor }, at }));
  await mkdir(join(landDir(l.d, 't/r'), 'floors'), { recursive: true });
  const now = l.clock.t;
  // neither commit is in t/api's history: neither is an ancestor of the other
  await put(l.s.head, 'a'.repeat(40), new Date(now - 60_000).toISOString());
  await put(b, 'b'.repeat(40), new Date(now - 30_000).toISOString());
  assert.equal(await l.wait({ floors: { 't/api': rq.otherFirst } }), 3);
  assert.deepEqual(l.starts, []);
  assert.ok(l.s.lines.some((x) => x.includes('… waiting for t/api app to be live at or past bbbbbbb')), l.s.lines.join('\n'));
  assert.ok(!l.s.lines.some((x) => x.includes('aaaaaaa')));
});

test('a floor behind nothing but a docs commit is met: the required deployable is live at the commit before it', async () => {
  // t/api's app is live at its deploy; a docs-only commit then lands on t/api main and is the floor. The
  // live commit is behind the floor, but nothing of the app's files is pending (requiredState's rule).
  const rq = await requiresSetup({ apiLive: (_, second) => at(second) });
  const docs = await commitFiles(rq.other.work, { 'README.md': 'docs' }, 'docs only');
  await git(['push', '--quiet', 'origin', 'main'], rq.other.work);
  const l = await landed({ from: rq.s, ack: [], land: { liveWaitHours: 0.5 } });
  assert.equal(await l.wait({ floors: { 't/api': docs } }), 0, l.s.lines.join('\n'));
  assert.equal(l.starts.length, 1);
  assert.ok(l.s.lines.includes(`✓ requires t/api app: live at or past ${docs.slice(0, 7)}`), l.s.lines.join('\n'));
});

test('a merge that lands between the decision and the freeze, with a floor not met, is not shipped by the deploy', async () => {
  // A's floor (t/api at otherFirst) is met, so the land decides to deploy. Before the runner has frozen
  // what it ships, B merges on top with a floor that is not met (t/api live at otherFirst, floor
  // otherSecond). The runner judges the tip it actually deploys, so it refuses: B is not shipped.
  const rq = await requiresSetup();
  const l = await landed({ from: rq.s, ack: [], land: { liveWaitHours: 0.5 } });
  const start = l.d.startDeploy;
  l.d.startDeploy = async (args) => {
    const b = await commitFiles(l.s.work, { 'app/src/a.ts': '3' }, 'b change (#10)');
    await git(['push', '--quiet', l.d.remoteUrl(), 'main'], l.s.work);
    await recordFloors({ d: l.d, repo: 't/r', mergeSha: b, floors: { 't/api': rq.otherSecond } });
    return start(args);
  };
  // The refusal is the floor's wait, not a failure: the land ends 3 only when liveWaitHours is up, and no
  // second deploy starts while the floor is not met.
  assert.equal(await l.wait({ floors: { 't/api': rq.otherFirst } }), 3, l.s.lines.join('\n'));
  assert.match(l.s.lines.at(-1), /not live after 0\.5 h/);
  assert.equal(l.starts.length, 1);
  assert.match(l.s.lines.join('\n'), new RegExp(`✗ requires t/api app: live at ${rq.otherFirst.slice(0, 7)}, before ${rq.otherSecond.slice(0, 7)} — deploy that first`));
  assert.equal((await l.s.cloud.wranglerCalls()).filter((c) => c.cmd === 'versions upload').length, 0, 'nothing was uploaded');
});

test('the migrations the tip\'s config watches decide the migration gate, not the merge commit\'s: no deploy is started every tick', async () => {
  // The tip's config also watches db2/, where an uncleared migration sits. The deploy judges the tip, so
  // it would refuse at once and stop at the migration gate; the land must wait there too, not start
  // a deploy at every tick.
  const l = await landed({ land: { liveWaitHours: 0.5 } });
  const config = (await readFile(join(l.s.work, 'ship.config.mjs'), 'utf8')).replace("['db/*.sql']", "['db/*.sql', 'db2/*.sql']");
  await commitFiles(l.s.work, { 'ship.config.mjs': config, 'db2/002.sql': '' }, 'watch db2 (#10)');
  await git(['push', '--quiet', l.d.remoteUrl(), 'main'], l.s.work);
  assert.equal(await l.wait(), 3, l.s.lines.join('\n'));
  assert.deepEqual(l.starts, [], 'the migration gate holds the deploy back');
  assert.ok(l.s.lines.includes('… waiting for migration db2/002.sql (#10)'), l.s.lines.join('\n'));
});

test('a deploy refused at a later merge\'s floor is not a failure of this land: it waits for the floor, then ships', async () => {
  const rq = await requiresSetup();
  let n0 = null;
  const l = await landed({ from: rq.s, ack: [], onTick: async (n, { s }) => {
    if (n !== 12) return;
    n0 = n;
    const v = s.cloud.addVersion('example-api', { message: `sha:${rq.otherSecond} x` });
    s.cloud.addDeployment('example-api', v.id, { message: `sha:${rq.otherSecond} x` });
  } });
  const start = l.d.startDeploy;
  let first = true;
  l.d.startDeploy = async (args) => {
    if (first) {
      first = false;
      const b = await commitFiles(l.s.work, { 'app/src/a.ts': '3' }, 'b change (#10)');
      await git(['push', '--quiet', l.d.remoteUrl(), 'main'], l.s.work);
      await recordFloors({ d: l.d, repo: 't/r', mergeSha: b, floors: { 't/api': rq.otherSecond } });
    }
    return start(args);
  };
  assert.equal(await l.wait({ floors: { 't/api': rq.otherFirst } }), 0, l.s.lines.join('\n'));
  assert.equal(n0, 12, 'the required deployable went live at the floor');
  assert.equal(l.starts.length, 2, 'the refused deploy, then the one that ships');
  assert.ok(l.s.lines.some((x) => x.startsWith('✗ requires t/api app:')), 'the first was refused at B\'s floor');
  assert.ok(l.s.lines.some((x) => x.startsWith(`… waiting for t/api app to be live at or past ${rq.otherSecond.slice(0, 7)}`)), l.s.lines.join('\n'));
});

test('the requirements of the tip\'s config count, not only the merge commit\'s', async () => {
  const rq = await requiresSetup();
  const off = (await readFile(join(rq.s.work, 'ship.config.mjs'), 'utf8'));
  const l = await landed({ from: rq.s, ack: [], land: { liveWaitHours: 0.5 }, merge: async (s) => {
    const sha = await commitFiles(s.work, { 'ship.config.mjs': off.replace("requires: [{ repo: 't/api', deployable: 'app' }]", 'requires: []'), 'app/src/a.ts': '5' }, 'merge without requires (#11)');
    await git(['push', '--quiet', s.deps.remoteUrl(), 'main'], s.work);
    return sha;
  } });
  await commitFiles(l.s.work, { 'ship.config.mjs': off }, 'require t/api (#12)');
  await git(['push', '--quiet', l.d.remoteUrl(), 'main'], l.s.work);
  assert.equal(await l.wait({ floors: {} }), 3, l.s.lines.join('\n'));
  assert.deepEqual(l.starts, [], 'the land waits for t/api like the deploy would');
  assert.ok(l.s.lines.some((x) => x.startsWith('… waiting for t/api app to be live at or past')), l.s.lines.join('\n'));
});

test('a deploy refused at a floor the land judged met is not started again every tick: at most one within liveCacheMs', async () => {
  const rq = await requiresSetup();
  const l = await landed({ from: rq.s, ack: [], land: { liveWaitHours: 0.05 } }); // 180 s, under liveCacheMs (300 s)
  l.d.startDeploy = async ({ d, repo, tip }) => {
    l.starts.push({ tip, at: d.now() });
    const id = `r${l.starts.length}`;
    await recordDeployStart({ d, repo, id, tip, log: '/dev/null', owner: await ownerInfo() });
    await recordDeployEnd({ d, repo, id, tip, code: 1, log: '/dev/null', requiresWaiting: true });
    return { id, log: '/dev/null', pid: process.pid };
  };
  assert.equal(await l.wait({ floors: { 't/api': rq.otherFirst } }), 3, l.s.lines.join('\n'));
  assert.equal(l.starts.length, 1, 'refused once, not again within liveCacheMs');
});

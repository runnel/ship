import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { landDeps } from '../lib/land.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { contains, decide, landedChanges, liveFor } from '../lib/land-live.mjs';
import { acquire, ownerInfo } from '../lib/lock.mjs';
import { landDir } from '../lib/land-line.mjs';
import { clearHold, writeHold } from '../lib/state.mjs';
import { commitTimeMs, mirrorPath } from '../lib/git.mjs';
import { syncMirror } from '../lib/repo.mjs';
import { at, setupDeploy } from './deploy-fixture.mjs';
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
  requires: [], deployRunning: false, deployedOk: false, failed: null, lineEmpty: true, tipAtMs: T0 - 10_000, oldestUnliveAtMs: T0 - 10_000, ...over,
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

test('decide: a tip whose deploy ended ok is not deployed again; it waits for the live cache', () => {
  const r = step(facts({ deployedOk: true }));
  assert.equal(r.deploy, undefined);
  assert.equal(r.wait, 'live');
  assert.match(r.line, /^… the deploy of main@bbbbbbb ended ok; waiting for it to show as live/);
  assert.equal(step(facts({ deployedOk: true, holds: { app: { reason: 'x', at: null } } })).done, 3, 'a hold still ends the land');
  assert.equal(step(facts({ deployedOk: true, live: { app: { sha: TIP, contains: true, blocked: false } } })).done, 0, 'live wins');
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

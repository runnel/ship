import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { landDeps } from '../lib/land.mjs';
import { join } from 'node:path';
import { landedChanges, liveFor } from '../lib/land-live.mjs';
import { acquire, ownerInfo } from '../lib/lock.mjs';
import { landDir } from '../lib/land-line.mjs';
import { clearHold, writeHold } from '../lib/state.mjs';
import { commitTimeMs, mirrorPath } from '../lib/git.mjs';
import { syncMirror } from '../lib/repo.mjs';
import { at, setupDeploy } from './deploy-fixture.mjs';
import { atTestEnd, git, stopBackground } from './helpers.mjs';

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

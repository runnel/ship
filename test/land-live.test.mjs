import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { landDeps } from '../lib/land.mjs';
import { landedChanges } from '../lib/land-live.mjs';
import { syncMirror } from '../lib/repo.mjs';
import { at, setupDeploy } from './deploy-fixture.mjs';
import { git, stopBackground } from './helpers.mjs';

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

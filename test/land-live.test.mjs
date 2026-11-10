import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { landDeps } from '../lib/land.mjs';
import { landedChanges } from '../lib/land-live.mjs';
import { syncMirror } from '../lib/repo.mjs';
import { at, setupDeploy } from './deploy-fixture.mjs';
import { stopBackground } from './helpers.mjs';

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

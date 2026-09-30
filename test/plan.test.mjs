import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { commitFiles, git, makeOrigin, tempDir } from './helpers.mjs';
import { ensureMirror } from '../lib/git.mjs';
import { validateConfig } from '../lib/config.mjs';
import { cloudflare } from '../lib/cloudflare.mjs';
import { writeHold } from '../lib/state.mjs';
import { planDeploy } from '../lib/plan.mjs';
import { fakeCloud } from './fake-cloud.mjs';

const creds = { file: '/unused', map: { CLOUDFLARE_API_TOKEN: 'T', CLOUDFLARE_ACCOUNT_ID: 'A' } };
const config = validateConfig({
  repo: 't/r', checks: [{ name: 'u', paths: ['**'], steps: ['true'] }], credentials: creds,
  deployables: [
    { name: 'app', worker: 'example-app', cwd: 'app', paths: ['app/**'], mode: 'versioned', probes: [{ path: '/', status: 200 }], liveHost: 'https://app.example.com' },
    { name: 'tick', worker: 'example-tick', cwd: 'workers/tick', paths: ['workers/tick/**'], mode: 'direct', after: ['app'] },
    { name: 'solo', worker: 'example-solo', cwd: 'solo', paths: ['solo/**'], mode: 'direct' },
  ],
});

async function setup(seed) {
  const { origin, work, root } = await makeOrigin({ 'app/a.ts': '1', 'workers/tick/i.ts': '1', 'solo/s.ts': '1' });
  const first = (await git(['rev-parse', 'HEAD'], work)).trim();
  const second = await commitFiles(work, { 'app/a.ts': '2', 'workers/tick/i.ts': '2' }, 'change app and tick (#5)');
  await git(['push', '--quiet', 'origin', 'main'], work);
  await git(['checkout', '--quiet', '-b', 'side', first], work);
  const side = await commitFiles(work, { 'solo/s.ts': 'side' }, 'side');
  await git(['push', '--quiet', 'origin', 'side'], work);
  const mirror = await ensureMirror('t/r', { root: join(root, 'm'), url: origin });
  const cloud = await fakeCloud({ dir: join(root, 'cloud'), workers: seed({ first, second, side }) });
  const cf = cloudflare({ token: 't', accountId: 'acc', fetchImpl: cloud.fetch });
  const stateRoot = await tempDir('state-');
  const r = { repo: 't/r', mirror, mainBranch: 'main' };
  const plan = (selected = ['app', 'tick', 'solo'], opts = {}) =>
    planDeploy({ r, config: opts.config ?? config, selected: new Set(selected), target: second, cf, stateRoot, redeploy: new Set(opts.redeploy ?? []) });
  return { plan, stateRoot, first, second };
}
const at = (sha) => ({ versions: [{ message: `sha:${sha} x` }], deployments: [{ versionId: null, message: `sha:${sha} x` }] });
const byName = (entries) => Object.fromEntries(entries.map((e) => [e.dep.name, e]));

test('pending, live and first deploy', async () => {
  const { plan } = await setup(({ first, second }) => ({ 'example-app': at(first), 'example-tick': at(second) }));
  const e = byName(await plan());
  assert.equal(e.app.status, 'pending');
  assert.deepEqual(e.app.files, ['app/a.ts']);
  assert.equal(e.tick.status, 'live');
  assert.equal(e.solo.status, 'pending');
  assert.equal(e.solo.reason, 'first deploy');
});

test('a hold or an unknown live stops the dependents; independents go on', async () => {
  const { plan, stateRoot } = await setup(({ first }) => ({ 'example-app': at(first), 'example-tick': at(first), 'example-solo': at(first) }));
  await writeHold(stateRoot, 't/r', 'app', { reason: 'live probes failed' });
  let e = byName(await plan());
  assert.equal(e.app.status, 'held');
  assert.equal(e.tick.status, 'skipped');
  assert.match(e.tick.reason, /waits for app \(held\)/);
  assert.equal(e.solo.status, 'live');
  const unknown = await setup(({ first }) => ({ 'example-app': { versions: [{ message: 'by hand' }], deployments: [{ versionId: null }] }, 'example-tick': at(first) }));
  e = byName(await unknown.plan());
  assert.equal(e.app.status, 'blocked');
  assert.match(e.app.reason, /ship adopt --at <sha> app/);
  assert.equal(e.tick.status, 'skipped');
});

test('live that is not an ancestor of main is blocked', async () => {
  const { plan } = await setup(({ first, side }) => ({ 'example-app': at(first), 'example-tick': at(first), 'example-solo': at(side) }));
  assert.match(byName(await plan()).solo.reason, /not an ancestor of main/);
});

test('ignored files do not make a deployable pending; --redeploy does', async () => {
  const { plan } = await setup(({ first, second }) => ({ 'example-app': at(first), 'example-tick': at(second), 'example-solo': at(second) }));
  const ignoring = validateConfig({ ...config, deployables: config.deployables.map((d) => (d.name === 'app' ? { ...d, ignore: ['app/a.ts'] } : d)) });
  assert.equal(byName(await plan(['app'], { config: ignoring })).app.status, 'live');
  const e = byName(await plan(['tick'], { redeploy: ['tick'] }));
  assert.equal(e.tick.status, 'skipped'); // app (its dependency) is pending but not selected
  const r = byName(await plan(['solo'], { redeploy: ['solo'] }));
  assert.equal(r.solo.status, 'pending');
  assert.match(r.solo.reason, /redeploy of [0-9a-f]{7} requested/);
});

test('an unselected pending dependency stops a selected dependent', async () => {
  const { plan } = await setup(({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }));
  const e = byName(await plan(['tick']));
  assert.equal(e.tick.status, 'skipped');
  assert.match(e.tick.reason, /app has undeployed changes/);
});

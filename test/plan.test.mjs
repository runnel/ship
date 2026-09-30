import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { commitFiles, git, makeOrigin, tempDir } from './helpers.mjs';
import { addWorktree, ensureMirror } from '../lib/git.mjs';
import { validateConfig } from '../lib/config.mjs';
import { cloudflare } from '../lib/cloudflare.mjs';
import { writeHold } from '../lib/state.mjs';
import { planDeploy, propagate } from '../lib/plan.mjs';
import { localTime } from '../lib/report.mjs';
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
  const third = await commitFiles(work, { 'app/README.md': 'docs' }, 'docs only');
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
    planDeploy({ r, config: opts.config ?? config, selected: new Set(selected), target: opts.target ?? second, cf, stateRoot, wt: opts.wt ?? null, redeploy: new Set(opts.redeploy ?? []) });
  return { plan, stateRoot, first, second, third, mirror, root };
}
// A worktree of `second` with `files` written over it, the way a deploy run sees the tree.
async function worktreeWith({ mirror, root, second }, files) {
  const wt = join(root, 'wt');
  await addWorktree(mirror, wt, second);
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(wt, path)), { recursive: true });
    await writeFile(join(wt, path), body);
  }
  return wt;
}
async function withZone(zone, fn) {
  const saved = process.env.SHIP_TZ;
  process.env.SHIP_TZ = zone;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.SHIP_TZ;
    else process.env.SHIP_TZ = saved;
  }
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
  const e = byName(await plan());
  assert.equal(e.solo.status, 'blocked');
  assert.match(e.solo.reason, /not an ancestor of main/);
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

test('a hold is reported in local time, and an unusable time reads as ?', async () => {
  const { plan, stateRoot } = await setup(({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }));
  const since = '2026-09-30T10:53:57.966Z';
  await writeHold(stateRoot, 't/r', 'app', { reason: 'live probes failed', at: since });
  const e = await withZone('Asia/Tokyo', async () => byName(await plan()));
  assert.equal(e.app.status, 'held');
  assert.equal(e.app.reason, `held since ${localTime(since, { timeZone: 'Asia/Tokyo' })}: live probes failed`);
  assert.match(e.app.reason, /^held since 30\/09, 19:53: /);
  assert.doesNotMatch(e.app.reason, /\d{4}-\d{2}-\d{2}T|Z\b/);
  for (const bad of ['not a date', '', 42]) {
    await writeHold(stateRoot, 't/r', 'app', { reason: 'live probes failed', at: bad });
    assert.equal(byName(await plan()).app.reason, 'held since ?: live probes failed', JSON.stringify(bad));
  }
});

test('an unreadable hold file still holds', async () => {
  const { plan, stateRoot } = await setup(({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }));
  await mkdir(join(stateRoot, 'holds', 't__r'), { recursive: true });
  await writeFile(join(stateRoot, 'holds', 't__r', 'app.json'), '{ not json');
  const e = byName(await plan());
  assert.equal(e.app.status, 'held');
  assert.match(e.app.reason, /^held since \?: unreadable hold file/);
  assert.equal(e.tick.status, 'skipped');
});

test('a selected deployable that imports outside its paths is blocked; an unselected one is not scanned', async () => {
  const s = await setup(({ second }) => ({ 'example-app': at(second), 'example-tick': at(second), 'example-solo': at(second) }));
  const wt = await worktreeWith(s, { 'solo/s.ts': "import '../app/a.ts';\n" });
  let e = byName(await s.plan(['solo'], { wt }));
  assert.equal(e.solo.status, 'blocked');
  assert.match(e.solo.reason, /^imports files outside its paths: solo\/s\.ts → app\/a\.ts — add them to its paths in ship\.config\.mjs$/);
  assert.equal(e.app.status, 'live'); // only the importing deployable is blocked
  e = byName(await s.plan(['app'], { wt }));
  assert.equal(e.solo.status, 'live');
  e = byName(await s.plan(['solo']));
  assert.equal(e.solo.status, 'live'); // without a worktree nothing is scanned
});

test('the outside imports listed are capped at five, with the rest counted', async () => {
  const s = await setup(({ second }) => ({ 'example-app': at(second), 'example-tick': at(second), 'example-solo': at(second) }));
  const outside = Array.from({ length: 7 }, (_, i) => `shared/f${i}.ts`);
  const wt = await worktreeWith(s, {
    ...Object.fromEntries(outside.map((f) => [f, '1'])),
    'solo/s.ts': outside.map((f) => `import '../${f}';`).join('\n'),
  });
  const { reason } = byName(await s.plan(['solo'], { wt })).solo;
  assert.match(reason, /solo\/s\.ts → shared\/f4\.ts and 2 more — add them/);
  assert.doesNotMatch(reason, /f5|f6/);
  assert.equal(reason.split(' → ').length - 1, 5);
});

test('docs-only changes inside a deployable do not make it pending', async () => {
  const { plan, second, third } = await setup(({ second }) => ({ 'example-app': at(second), 'example-tick': at(second), 'example-solo': at(second) }));
  const docs = validateConfig({ ...config, docsOnly: ['**/*.md'] });
  assert.equal(byName(await plan(['app'], { config: docs, target: third })).app.status, 'live');
  const e = byName(await plan(['app'], { target: third })); // without the filter the same change is pending
  assert.equal(e.app.status, 'pending');
  assert.deepEqual(e.app.files, ['app/README.md']);
  assert.equal(byName(await plan(['app'], { config: docs, target: second })).app.status, 'live');
});

test('propagate: a hold stops a pending dependent through a live middle; independents stay pending', () => {
  const deployables = [{ name: 'a' }, { name: 'b', after: ['a'] }, { name: 'c', after: ['b'] }, { name: 'd' }];
  const entry = (i, status) => ({ dep: deployables[i], selected: true, status, reason: `was ${status}` });
  const entries = propagate([entry(0, 'held'), entry(1, 'live'), entry(2, 'pending'), entry(3, 'pending')], deployables);
  const by = byName(entries);
  assert.equal(by.a.status, 'held');
  assert.equal(by.b.status, 'live');
  assert.equal(by.b.reason, 'was live');
  assert.equal(by.c.status, 'skipped');
  assert.equal(by.c.reason, 'waits for a (held)');
  assert.equal(by.d.status, 'pending');
  assert.equal(by.d.reason, 'was pending');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAcks, readHold, writeHold } from '../lib/state.mjs';
import { runAck, runAdopt, runRollback, runUnhold } from '../lib/admin.mjs';
import { runDeploy } from '../lib/deploy.mjs';
import { at, setupDeploy } from './deploy-fixture.mjs';

const posts = (cloud) => cloud.apiCalls.filter((c) => c.method === 'POST').map((c) => c.body.annotations['workers/message']);

test('adopt records the current versions and seeds the ack ledger', async () => {
  const s = await setupDeploy({ seed: () => ({ 'example-app': { versions: [{ message: 'by hand' }], deployments: [{ versionId: null }] }, 'example-tick': { versions: [{}], deployments: [{ versionId: null }] } }) });
  assert.equal(await runAdopt({ cwd: s.work, at: s.first.slice(0, 9), all: true, deps: s.deps }), 0, s.lines.join('\n'));
  assert.deepEqual(posts(s.cloud), [`sha:${s.first} adopt`, `sha:${s.first} adopt`]);
  assert.deepEqual([...(await readAcks(s.deps.stateRoot, 't/r'))], ['db/001.sql']);
  s.lines.length = 0;
  assert.equal(await runDeploy({ cwd: s.work, deps: s.deps }), 0);
  assert.match(s.lines.join('\n'), /✓ app: already live/);
});

test('adopt refuses a commit that is not on main, and needs --all or names', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }) });
  assert.equal(await runAdopt({ cwd: s.work, at: 'f'.repeat(40), all: true, deps: s.deps }), 2);
  assert.equal(await runAdopt({ cwd: s.work, at: s.first, deps: s.deps }), 2);
});

test('adopt --plan suggests the main commit at upload time', async () => {
  const s = await setupDeploy({ clockStart: Date.now() + 60_000, seed: () => ({ 'example-app': { versions: [{ message: 'by hand' }, { triggered: 'secret' }], deployments: [{ versionId: null }] } }), change: { 'app/src/a.ts': '2' } });
  assert.equal(await runAdopt({ cwd: s.work, plan: true, deps: s.deps }), 0);
  const text = s.lines.join('\n');
  assert.match(text, new RegExp(`· app: code uploaded .*; main then: ${s.head.slice(0, 7)}; 0 later commit`));
  assert.match(text, new RegExp(`ship adopt --at ${s.head.slice(0, 12)} app`));
  assert.deepEqual(posts(s.cloud), []);
});

test('rollback: without --to it only shows the plan; --to needs --revert-secrets across a secret change', async () => {
  const s = await setupDeploy({ change: { 'app/src/a.ts': '2' }, seed: ({ first, head }) => ({
    'example-app': { versions: [{ message: `sha:${first} a` }, { message: `sha:${head} b` }, { triggered: 'secret' }],
      deployments: [{ versionId: null }] },
    'example-tick': at(first) }) });
  // the seed deployed only the last version (the secret change on top of `head`)
  assert.equal(await runRollback({ cwd: s.work, name: 'app', deps: s.deps }), 0, s.lines.join('\n'));
  const text = s.lines.join('\n');
  assert.match(text, new RegExp(`back to: ${s.first.slice(0, 7)} initial`));
  assert.match(text, /never the live version as far as the history shows/);
  assert.match(text, /undoes 1 secret change/);
  assert.match(text, /database migrations are not rolled back/);
  const cmd = text.match(/run: ship rollback app --to ([0-9a-f]{8}) --revert-secrets/);
  assert.ok(cmd, text);
  assert.deepEqual(posts(s.cloud), []);
  assert.equal(await runRollback({ cwd: s.work, name: 'app', to: cmd[1], deps: s.deps }), 1);
  assert.match(s.lines.join('\n'), /Cloudflare refuses: .*secret has changed/);
  assert.equal(await readHold(s.deps.stateRoot, 't/r', 'app'), null);
  assert.equal(await runRollback({ cwd: s.work, name: 'app', to: cmd[1], revertSecrets: true, deps: s.deps }), 0, s.lines.join('\n'));
  assert.equal(posts(s.cloud).at(-1), `sha:${s.first} rollback`);
  assert.equal(s.cloud.live('example-app'), (await s.cloud.state('example-app')).versions[0].id);
  assert.match((await readHold(s.deps.stateRoot, 't/r', 'app')).reason, /rolled back to/);
});

test('rollback refuses across a Durable Object migration', async () => {
  const s = await setupDeploy({ change: { 'app/wrangler.json': '{"name":"example-app","migrations":[{"tag":"v1","new_sqlite_classes":["Box"]}]}' },
    seed: ({ first, head }) => ({ 'example-app': { versions: [{ message: `sha:${first} a` }, { message: `sha:${head} b` }], deployments: [{ versionId: null }] }, 'example-tick': at(first) }) });
  assert.equal(await runRollback({ cwd: s.work, name: 'app', deps: s.deps }), 1);
  assert.match(s.lines.join('\n'), /Durable Object migration changed/);
  assert.deepEqual(posts(s.cloud), []);
});

test('unhold and migrations ack', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }) });
  await writeHold(s.deps.stateRoot, 't/r', 'app', { reason: 'x' });
  assert.equal(await runUnhold({ cwd: s.work, name: 'app', deps: s.deps }), 0);
  assert.equal(await readHold(s.deps.stateRoot, 't/r', 'app'), null);
  assert.equal(await runAck({ cwd: s.work, files: ['nope.sql'], deps: s.deps }), 2);
  assert.equal(await runAck({ cwd: s.work, files: ['001.sql'], deps: s.deps }), 0);
  assert.deepEqual([...(await readAcks(s.deps.stateRoot, 't/r'))], ['db/001.sql']);
});

// A fetch that rewrites what the fake cloud answers, or fails a request outright.
const asSplit = (cloud, worker) => async (url, init) => {
  const res = await cloud.fetch(url, init);
  if ((init?.method ?? 'GET') !== 'GET' || !url.includes(`/${worker}/deployments`)) return res;
  const body = await res.json();
  body.result.deployments[0].versions = [{ version_id: 'a', percentage: 50 }, { version_id: 'b', percentage: 50 }];
  return new Response(JSON.stringify(body), { status: 200 });
};
const promoteFails = (cloud, failure) => async (url, init) => {
  if (init?.method === 'POST' && url.includes('/deployments')) return failure();
  return cloud.fetch(url, init);
};
const versionPrefix = async (cloud, worker, index) => (await cloud.state(worker)).versions[index].id.slice(0, 8);
const twoVersions = ({ first, head }) => ({
  'example-app': { versions: [{ message: `sha:${first} a` }, { message: `sha:${head} b` }], deployments: [{ versionId: null }] },
  'example-tick': at(first),
});

test('adopt refuses a split deployment and skips a Worker without a deployment, but adopts the rest', async () => {
  const s = await setupDeploy({ options: { third: true }, seed: () => ({
    'example-app': { versions: [{}, {}], deployments: [{ versionId: null }] },
    'example-tick': { versions: [{}], deployments: [] },
    'example-job': { versions: [{}], deployments: [{ versionId: null }] } }) });
  assert.equal(await runAdopt({ cwd: s.work, at: s.first, all: true, deps: { ...s.deps, fetch: asSplit(s.cloud, 'example-app') } }), 1);
  const text = s.lines.join('\n');
  assert.match(text, /✗ app: the current deployment splits traffic/);
  assert.match(text, /! tick: example-tick has no deployment/);
  assert.match(text, /✓ job: version [0-9a-f]{8} recorded as/);
  assert.deepEqual(posts(s.cloud), [`sha:${s.first} adopt`]);
});

test('adopt reports a failing Worker by name and still adopts the others', async () => {
  const s = await setupDeploy({ seed: () => ({ 'example-app': { versions: [{}], deployments: [{ versionId: null }] }, 'example-tick': { versions: [{}], deployments: [{ versionId: null }] } }) });
  const broken = async (url, init) => (url.includes('/example-app/deployments') && init?.method === 'POST'
    ? new Response('bad gateway', { status: 502 })
    : s.cloud.fetch(url, init));
  assert.equal(await runAdopt({ cwd: s.work, at: s.first, all: true, deps: { ...s.deps, fetch: broken } }), 1);
  assert.match(s.lines.join('\n'), /✗ app: adopt failed \(Cloudflare POST .*HTTP 502/);
  assert.deepEqual(posts(s.cloud), [`sha:${s.first} adopt`]);
});

test('adopt checks its arguments before touching anything', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }) });
  assert.equal(await runAdopt({ cwd: s.work, at: 'main', all: true, deps: s.deps }), 2);
  assert.match(s.lines.join('\n'), /--at main: give a commit sha/);
  assert.equal(await runAdopt({ cwd: s.work, at: s.first, names: ['nope'], deps: s.deps }), 2);
  assert.match(s.lines.join('\n'), /unknown deployable: nope \(known: app, tick\)/);
  assert.equal(await runAdopt({ cwd: s.work, at: s.first, names: ['app'], all: true, deps: s.deps }), 2);
  assert.equal(await runAdopt({ cwd: s.work, plan: true, names: ['app'], deps: s.deps }), 2);
  assert.deepEqual(posts(s.cloud), []);
  assert.deepEqual([...(await readAcks(s.deps.stateRoot, 't/r'))], []);
});

test('adopt --plan leaves a deployable whose live commit is known alone and flags a split', async () => {
  const s = await setupDeploy({ clockStart: Date.now() + 60_000, seed: ({ first }) => ({
    'example-app': at(first),
    'example-tick': { versions: [{ message: 'by hand' }], deployments: [{ versionId: null }] } }) });
  assert.equal(await runAdopt({ cwd: s.work, plan: true, deps: { ...s.deps, fetch: asSplit(s.cloud, 'example-tick') } }), 0);
  const text = s.lines.join('\n');
  assert.match(text, new RegExp(`· app: live commit already known \\(${s.first.slice(0, 7)}\\)`));
  assert.match(text, /\? tick: the current deployment splits traffic/);
  assert.doesNotMatch(text, /ship adopt --at/);
});

test('rollback with no earlier version with a known commit says so and changes nothing', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }) });
  assert.equal(await runRollback({ cwd: s.work, name: 'app', deps: s.deps }), 1);
  assert.match(s.lines.join('\n'), /✗ app: no earlier version with a known commit/);
  assert.deepEqual(posts(s.cloud), []);
});

test('rollback --to checks the version before it holds anything', async () => {
  const s = await setupDeploy({ change: { 'app/src/a.ts': '2' }, seed: twoVersions });
  assert.equal(await runRollback({ cwd: s.work, name: 'app', to: 'zzzzzz', deps: s.deps }), 2);
  assert.equal(await runRollback({ cwd: s.work, name: 'app', to: '000000', deps: s.deps }), 2);
  assert.match(s.lines.join('\n'), /--to 000000: no such version/);
  assert.equal(await runRollback({ cwd: s.work, name: 'app', to: await versionPrefix(s.cloud, 'example-app', 1), deps: s.deps }), 1);
  assert.match(s.lines.join('\n'), /is already live/);
  assert.equal(await runRollback({ cwd: s.work, name: 'nope', deps: s.deps }), 2);
  assert.equal(await readHold(s.deps.stateRoot, 't/r', 'app'), null);
  assert.deepEqual(posts(s.cloud), []);
});

test('rollback keeps the hold when the promote may or may not have happened', async () => {
  const s = await setupDeploy({ change: { 'app/src/a.ts': '2' }, seed: twoVersions });
  const to = await versionPrefix(s.cloud, 'example-app', 0);
  const down = promoteFails(s.cloud, () => { throw new TypeError('fetch failed'); });
  assert.equal(await runRollback({ cwd: s.work, name: 'app', to, deps: { ...s.deps, fetch: down } }), 1);
  assert.match(s.lines.join('\n'), /rollback outcome unknown \(fetch failed\); the hold stays/);
  assert.match((await readHold(s.deps.stateRoot, 't/r', 'app')).reason, /rolled back to/);
  // an answer that is not Cloudflare's own refusal counts as unknown as well
  await runUnhold({ cwd: s.work, name: 'app', deps: s.deps });
  const gateway = promoteFails(s.cloud, () => new Response('bad gateway', { status: 502 }));
  assert.equal(await runRollback({ cwd: s.work, name: 'app', to, deps: { ...s.deps, fetch: gateway } }), 1);
  assert.match(s.lines.join('\n'), /outcome unknown \(Cloudflare POST .*HTTP 502/);
  assert.ok(await readHold(s.deps.stateRoot, 't/r', 'app'));
});

test('rollback refused by Cloudflare puts an earlier hold back exactly as it was', async () => {
  const s = await setupDeploy({ change: { 'app/src/a.ts': '2' }, seed: ({ first, head }) => ({
    'example-app': { versions: [{ message: `sha:${first} a` }, { message: `sha:${head} b` }, { triggered: 'secret' }], deployments: [{ versionId: null }] },
    'example-tick': at(first) }) });
  const earlier = { reason: 'an earlier problem', versionId: 'v-1', sha: s.head, at: '2026-01-02T03:04:05.000Z' };
  await writeHold(s.deps.stateRoot, 't/r', 'app', earlier);
  assert.equal(await runRollback({ cwd: s.work, name: 'app', to: await versionPrefix(s.cloud, 'example-app', 0), deps: s.deps }), 1);
  assert.match(s.lines.join('\n'), /✗ Cloudflare refuses: A secret has changed .*\[10220\]\. If reverting those secrets is intended: ship rollback app --to [0-9a-f]{8} --revert-secrets/);
  assert.deepEqual(await readHold(s.deps.stateRoot, 't/r', 'app'), earlier);
});

test('rollback says when it cannot compare the Worker config, and still shows the plan', async () => {
  const gone = 'a'.repeat(40);
  const s = await setupDeploy({ seed: ({ first }) => ({
    'example-app': { versions: [{ message: `sha:${first} a` }, { message: `sha:${gone} b` }], deployments: [{ versionId: null }] },
    'example-tick': at(first) }) });
  assert.equal(await runRollback({ cwd: s.work, name: 'app', deps: s.deps }), 0, s.lines.join('\n'));
  const text = s.lines.join('\n');
  assert.match(text, /now: aaaaaaa \(commit not in the repo\)/);
  assert.match(text, /! could not compare the Worker config between the two commits \(app\/wrangler.json: commit aaaaaaa is not in t\/r\)/);
  assert.match(text, /run: ship rollback app --to [0-9a-f]{8}$/);
});

test('unhold names what is held when the name is not, and survives a damaged time', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }) });
  await writeHold(s.deps.stateRoot, 't/r', 'tick', { reason: 'odd', at: 'not a time' });
  assert.equal(await runUnhold({ cwd: s.work, name: 'app', deps: s.deps }), 0);
  assert.match(s.lines.join('\n'), /· app: no hold \(held: tick\)/);
  assert.equal(await runUnhold({ cwd: s.work, name: '../x', deps: s.deps }), 2);
  assert.equal(await runUnhold({ cwd: s.work, name: 'tick', deps: s.deps }), 0);
  assert.match(s.lines.join('\n'), /✓ tick: hold cleared \(was: odd\)/);
  assert.equal(await readHold(s.deps.stateRoot, 't/r', 'tick'), null);
});

test('migrations ack is all or nothing, prefers an exact path to a bare name, and needs no credentials', async () => {
  const s = await setupDeploy({ options: { migrationPaths: "['db/*.sql', 'db/old/*.sql']" }, change: { 'db/old/001.sql': '' },
    seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }) });
  const deps = { ...s.deps, readCredentials: async () => { throw new Error('the credentials file must not be read'); } };
  assert.equal(await runAck({ cwd: s.work, files: ['001.sql'], deps }), 2);
  assert.match(s.lines.join('\n'), /✗ 001.sql: ambiguous/);
  assert.equal(await runAck({ cwd: s.work, files: ['db/001.sql', 'nope.sql'], deps }), 2);
  assert.deepEqual([...(await readAcks(s.deps.stateRoot, 't/r'))], []);
  assert.equal(await runAck({ cwd: s.work, files: ['./db/001.sql'], deps }), 0);
  assert.equal(await runAck({ cwd: s.work, files: ['db/001.sql'], deps }), 0);
  assert.match(s.lines.join('\n'), /✓ cleared for deploy: \(already cleared\)/);
  assert.deepEqual([...(await readAcks(s.deps.stateRoot, 't/r'))], ['db/001.sql']);
});

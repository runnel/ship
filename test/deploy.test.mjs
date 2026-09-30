import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { commitFiles, git, makeOrigin } from './helpers.mjs';
import { addAcks, writeHold } from '../lib/state.mjs';
import { UsageError } from '../lib/shared.mjs';
import { at, setupDeploy } from './deploy-fixture.mjs';

test('nothing pending: already live, no build, exit 0', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }) });
  assert.equal(await s.deploy(), 0, s.lines.join('\n'));
  assert.match(s.lines.join('\n'), /✓ app: already live/);
  assert.deepEqual(await s.cloud.wranglerCalls(), []);
});

test('app, then tick after it; a second run finds nothing to do', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: { 'app/src/a.ts': '2', 'workers/tick/src/index.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  assert.equal(await s.deploy(), 0, s.lines.join('\n'));
  assert.deepEqual((await s.cloud.wranglerCalls()).map((c) => c.cmd), ['versions upload', 'deploy']);
  assert.match((await s.cloud.state('example-app')).deployments.at(-1).annotations['workers/message'], new RegExp(`^sha:${s.head} app run:[0-9a-f]{6} #9$`));
  assert.match(s.lines.join('\n'), /✓ setup: mkdir -p tools/);
  assert.match(s.lines.join('\n'), /✓ guard: test -x tools\/wrangler/);
  s.lines.length = 0;
  assert.equal(await s.deploy(), 0);
  assert.match(s.lines.join('\n'), /✓ tick: already live/);
});

test('an unacked migration stops everything before any work', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: { 'app/src/a.ts': '2', 'db/002.sql': '' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  assert.equal(await s.deploy(), 1);
  assert.match(s.lines.join('\n'), /migrations not cleared for deploy: db\/002.sql/);
  assert.match(s.lines.join('\n'), /ship migrations ack 002.sql/);
  assert.deepEqual(await s.cloud.wranglerCalls(), []);
  await addAcks(s.deps.stateRoot, 't/r', ['db/002.sql']);
  assert.equal(await s.deploy(), 0, s.lines.join('\n'));
});

test('the ack hint names the path of a migration whose file name is not unique', async () => {
  const s = await setupDeploy({
    options: { migrationPaths: "['db/**']" },
    seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }),
    change: { 'app/src/a.ts': '2', 'db/a/001.sql': '', 'db/002.sql': '' },
  });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  assert.equal(await s.deploy(), 1);
  assert.match(s.lines.join('\n'), /migrations not cleared for deploy: db\/002.sql, db\/a\/001.sql\n/);
  assert.match(s.lines.join('\n'), /ship migrations ack 002.sql db\/a\/001.sql$/m);
});

test('an unknown live blocks it and its dependents', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': { versions: [{ message: 'by hand' }], deployments: [{ versionId: null }] }, 'example-tick': at(first) }), change: { 'workers/tick/src/index.ts': '2' } });
  assert.equal(await s.deploy(), 1);
  assert.match(s.lines.join('\n'), /✗ app: live unknown/);
  assert.match(s.lines.join('\n'), /! tick: waits for app \(blocked\)/);
  assert.deepEqual(await s.cloud.wranglerCalls(), []);
});

test('a hold skips the deployable and its dependents', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: { 'app/src/a.ts': '2', 'workers/tick/src/index.ts': '2' } });
  await writeHold(s.deps.stateRoot, 't/r', 'app', { reason: 'rolled back by the owner' });
  assert.equal(await s.deploy(), 1);
  assert.match(s.lines.join('\n'), /! app: held since .*rolled back by the owner/);
  assert.deepEqual(await s.cloud.wranglerCalls(), []);
});

test('a red deploy-time check deploys nothing', async () => {
  const s = await setupDeploy({ options: { guard: 'false' }, seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: { 'workers/tick/src/index.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  assert.equal(await s.deploy(), 1);
  assert.match(s.lines.join('\n'), /deploy-time check guard is red/);
  assert.deepEqual(await s.cloud.wranglerCalls(), []);
});

test('a dry run builds but uploads nothing', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: { 'app/src/a.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  assert.equal(await s.deploy([], true), 0, s.lines.join('\n'));
  assert.match(s.lines.join('\n'), /would deploy/);
  assert.deepEqual(await s.cloud.wranglerCalls(), []);
});

test('an import outside paths blocks that deployable only', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: { 'workers/tick/src/index.ts': "import '../../../app/src/a';\n" } });
  assert.equal(await s.deploy(), 1);
  assert.match(s.lines.join('\n'), /✗ tick: imports files outside its paths: workers\/tick\/src\/index.ts → app\/src\/a.ts/);
  assert.deepEqual(await s.cloud.wranglerCalls(), []);
});

test('--redeploy deploys a live deployable again; it needs names', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }) });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  await assert.rejects(s.deploy([], false, true), (e) => e instanceof UsageError && e.message === '--redeploy needs deployable names');
  assert.equal(await s.deploy(['tick'], false, true), 0, s.lines.join('\n'));
  assert.deepEqual((await s.cloud.wranglerCalls()).map((c) => c.cmd), ['deploy']);
});

test('an unknown deployable name is a usage error', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }) });
  await assert.rejects(s.deploy(['nope']), (e) => e instanceof UsageError && e.message === 'unknown deployable: nope (known: app, tick)');
  assert.deepEqual(await s.cloud.wranglerCalls(), []);
});

test('requires: a pending deployable of another repo stops the deploy', async () => {
  const other = await makeOrigin({ 'ship.config.mjs': `export default { repo: 't/api', checks: [{ name: 'u', paths: ['**'], steps: ['true'] }],
    deployables: [{ name: 'app', worker: 'example-api', cwd: '.', paths: ['src/**'], mode: 'direct' }],
    credentials: { file: '/unused', map: { CLOUDFLARE_API_TOKEN: 'T', CLOUDFLARE_ACCOUNT_ID: 'A' } } };\n`, 'src/x.ts': '1', 'wrangler.json': '{"name":"example-api"}' });
  const otherFirst = (await git(['rev-parse', 'HEAD'], other.work)).trim();
  await commitFiles(other.work, { 'src/x.ts': '2' }, 'api change');
  await git(['push', '--quiet', 'origin', 'main'], other.work);
  const s = await setupDeploy({
    options: { requires: "[{ repo: 't/api', deployable: 'app' }]" },
    seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first), 'example-api': at(otherFirst) }),
    change: { 'app/src/a.ts': '2' },
  });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  const origin = s.deps.remoteUrl();
  s.deps.remoteUrl = (repo) => (repo === 't/api' ? other.origin : origin);
  assert.equal(await s.deploy(), 1);
  assert.match(s.lines.join('\n'), /requires t\/api app: pending/);
  assert.deepEqual(await s.cloud.wranglerCalls(), []);
});

// The nth read of a Worker's deployments fails. For a versioned deployable the 1st is the plan and
// the 2nd the re-read just before the promote, so nothing of ours is live when it fails.
function failDeploymentsRead(s, worker, nth, error) {
  const inner = s.deps.fetch;
  let seen = 0;
  s.deps.fetch = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET' && url.includes(`/scripts/${worker}/deployments`) && ++seen === nth) throw error;
    return await inner(url, init);
  };
}
const bothChanged = { 'app/src/a.ts': '2', 'workers/tick/src/index.ts': '2' };

test('an exception in one deployable fails it and skips its dependents', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: bothChanged });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  failDeploymentsRead(s, 'example-app', 2, new Error('socket hang up'));
  assert.equal(await s.deploy(), 1);
  assert.match(s.lines.join('\n'), /✗ app: ship error: socket hang up/);
  assert.match(s.lines.join('\n'), /! tick: waits for app \(failed\)/);
  assert.match(s.lines.join('\n'), /✗ ship deploy: app failed, tick skipped/);
  assert.deepEqual((await s.cloud.wranglerCalls()).map((c) => c.cmd), ['versions upload']);
});

test('a failed deployable does not stop an independent one', async () => {
  const s = await setupDeploy({
    options: { third: true },
    seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first), 'example-job': at(first) }),
    change: { ...bothChanged, 'workers/job/src/index.ts': '2' },
  });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  failDeploymentsRead(s, 'example-app', 2, new Error('socket hang up'));
  assert.equal(await s.deploy(), 1);
  assert.match(s.lines.join('\n'), /! tick: waits for app \(failed\)/);
  assert.match(s.lines.join('\n'), /✓ job: [0-9a-f]{8} live at /);
  assert.deepEqual((await s.cloud.wranglerCalls()).map((c) => [c.cmd, c.worker]), [['versions upload', 'example-app'], ['deploy', 'example-job']]);
});

test('an interrupt inside a deployable ends the run: not a deploy failure, nothing left behind', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: bothChanged });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  failDeploymentsRead(s, 'example-app', 2, Object.assign(new Error('interrupted'), { aborted: true }));
  await assert.rejects(s.deploy(), (e) => e.aborted === true);
  assert.doesNotMatch(s.lines.join('\n'), /ship error|! tick/);
  assert.deepEqual((await s.cloud.wranglerCalls()).map((c) => c.cmd), ['versions upload']);
  for (const dir of ['w', 'locks', 'lanes']) assert.deepEqual(await readdir(join(s.deps.tmpRoot, dir)), [], dir);
});

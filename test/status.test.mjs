import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAcks, writeHold } from '../lib/state.mjs';
import { runStatus } from '../lib/status.mjs';
import { at, setupDeploy } from './deploy-fixture.mjs';

test('status shows live, pending, holds, an undeployed newest version and migrations', async () => {
  const s = await setupDeploy({ seed: ({ first, head }) => ({ 'example-app': at(first), 'example-tick': at(head) }), change: { 'app/src/a.ts': '2' } });
  await writeHold(s.deps.stateRoot, 't/r', 'tick', { reason: 'checking something' });
  s.cloud.addVersion('example-app', { message: 'Updated secret "K"' });
  assert.equal(await runStatus({ cwd: s.work, deps: s.deps }), 0);
  const text = s.lines.join('\n');
  assert.match(text, new RegExp(`· app: live ${s.first.slice(0, 7)} "initial" · pending: 1 commit\\(s\\) #9 · newest version [0-9a-f]{8} \\(.*\\) is not deployed`));
  assert.match(text, /! tick: live [0-9a-f]{7} #9 · held since .*checking something/);
  assert.match(text, /! migrations not cleared for deploy: db\/001.sql/);
});

test('status reports a held deployable whose live commit is not in the repository instead of failing', async () => {
  const gone = 'a'.repeat(40);
  const s = await setupDeploy({ seed: ({ head }) => ({ 'example-app': at(gone), 'example-tick': at(head) }), change: { 'app/src/a.ts': '2' } });
  await writeHold(s.deps.stateRoot, 't/r', 'app', { reason: 'looking into it' });
  assert.equal(await runStatus({ cwd: s.work, deps: s.deps }), 0);
  assert.match(s.lines.join('\n'), /! app: live aaaaaaa · held since .*looking into it/);
});

// Cloudflare's versions without their `metadata`: a record that is missing or damaged must not stop the report.
const withoutVersionMetadata = (cloud) => async (url, init) => {
  const res = await cloud.fetch(url, init);
  if (!url.includes('/versions')) return res;
  const body = await res.json();
  for (const v of body.result.items) delete v.metadata;
  return new Response(JSON.stringify(body), { status: 200 });
};

test('status reads only, tells the owner how to adopt a live-unknown Worker, and names the migration ack', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': { versions: [{ message: 'by hand' }], deployments: [{ versionId: null }] }, 'example-tick': at(first) }) });
  assert.equal(await runStatus({ cwd: s.work, deps: s.deps }), 0);
  const text = s.lines.join('\n');
  assert.match(text, /✗ app: live unknown \(version [0-9a-f]{8} was made outside ship \("by hand"\)\) · to adopt: ship adopt --plan, then ship adopt --at <sha> app$/m);
  assert.match(text, /! migrations not cleared for deploy: db\/001\.sql\n {2}the owner applies them .* and runs: ship migrations ack 001\.sql$/m);
  assert.ok(s.cloud.apiCalls.length > 0);
  assert.ok(s.cloud.apiCalls.every((c) => c.method === 'GET'), 'status must not change anything on Cloudflare');
  assert.deepEqual(await s.cloud.wranglerCalls(), []);
});

test('status: when every migration is cleared it says so and asks for nothing', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }) });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  assert.equal(await runStatus({ cwd: s.work, deps: s.deps }), 0);
  const text = s.lines.join('\n');
  assert.match(text, /^✓ migrations: all cleared$/m);
  assert.doesNotMatch(text, /ship migrations ack|ship adopt/);
});

test('status: an ambiguous migration name is given as a path', async () => {
  const s = await setupDeploy({ options: { migrationPaths: "['db/*.sql', 'db/old/*.sql']" }, change: { 'db/old/001.sql': '' }, seed: ({ first, head }) => ({ 'example-app': at(head), 'example-tick': at(head) }) });
  assert.equal(await runStatus({ cwd: s.work, deps: s.deps }), 0);
  assert.match(s.lines.join('\n'), /ship migrations ack db\/001\.sql db\/old\/001\.sql$/m);
});

test('status survives a newest version without a time', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }) });
  s.cloud.addVersion('example-app', { message: 'Updated secret "K"' });
  assert.equal(await runStatus({ cwd: s.work, deps: { ...s.deps, fetch: withoutVersionMetadata(s.cloud) } }), 0, s.lines.join('\n'));
  assert.match(s.lines.join('\n'), /newest version [0-9a-f]{8} \(\?\) is not deployed/);
});

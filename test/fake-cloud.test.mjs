import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capture } from '../lib/proc.mjs';
import { CloudflareError, cloudflare } from '../lib/cloudflare.mjs';
import { fakeCloud } from './fake-cloud.mjs';
import { tempDir } from './helpers.mjs';

const API = 'https://api.cloudflare.com/client/v4/accounts/acc/';
const records = async (file) => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

// A working directory for the fake wrangler: a config naming the Worker, and an output file.
async function workDir(dir, name = 'example-app') {
  const work = join(dir, 'work');
  await mkdir(work);
  await writeFile(join(work, 'wrangler.json'), JSON.stringify({ name }));
  return { work, outFile: join(dir, 'out.ndjson') };
}
const wrangler = (cloud, args, { work, outFile }) => capture(cloud.bin, args, { cwd: work, env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outFile } });
const seeded = { 'example-app': { versions: [{ message: 'seed' }], deployments: [{ versionId: null }] } };

test('the fake wrangler and the fake API share one state', async () => {
  const dir = await tempDir('cloud-');
  const cloud = await fakeCloud({ dir: join(dir, 'cloud'), workers: { 'example-app': { versions: [{ message: 'seed' }], deployments: [{ versionId: null }] } },
    hosts: { 'https://app.example.com': 'example-app' }, probe: ({ versionId }) => ({ status: 200, body: versionId }) });
  const seededId = (await cloud.state('example-app')).versions[0].id;
  assert.equal(cloud.live('example-app'), seededId);
  const where = await workDir(dir);
  await wrangler(cloud, ['versions', 'upload', '--message', 'sha:x'], where);
  const all = await records(where.outFile);
  assert.equal(all[0].type, 'wrangler-session');
  assert.equal(all[0].version, 1);
  assert.deepEqual(all[0].command_line_args, ['versions', 'upload', '--message', 'sha:x']);
  const rec = all.find((r) => r.type === 'version-upload');
  assert.equal(rec.version, 1);
  assert.equal(rec.worker_name, 'example-app');
  assert.ok(Number.isFinite(Date.parse(rec.timestamp)));
  assert.equal(rec.preview_url, `https://${rec.version_id.slice(0, 8)}-example-app.example.workers.dev`);
  const cf = cloudflare({ token: 't', accountId: 'acc', fetchImpl: cloud.fetch });
  assert.equal((await cf.versions('example-app'))[0].annotations['workers/message'], 'sha:x');
  assert.equal(await (await cloud.fetch(`${rec.preview_url}/x`)).text(), rec.version_id);
  assert.equal(await (await cloud.fetch('https://app.example.com/x')).text(), seededId);
  await cf.createDeployment('example-app', rec.version_id, 'sha:x');
  assert.equal(await (await cloud.fetch('https://app.example.com/x')).text(), rec.version_id);
  assert.deepEqual((await cloud.wranglerCalls()).map((c) => c.cmd), ['versions upload']);
});

test('wrangler deploy makes an upload version and a deployment, and the deployment message is cut to 50 characters', async () => {
  const dir = await tempDir('cloud-');
  const cloud = await fakeCloud({ dir: join(dir, 'cloud'), workers: seeded });
  const where = await workDir(dir);
  const long = 'sha:' + 'x'.repeat(76);
  await wrangler(cloud, ['deploy', '--message', long], where);
  const w = await cloud.state('example-app');
  const version = w.versions.at(-1);
  assert.equal(w.versions.length, 2);
  assert.equal(version.annotations['workers/triggered_by'], 'upload');
  assert.equal(version.annotations['workers/message'], long);
  const deployment = w.deployments.at(-1);
  assert.equal(deployment.annotations['workers/message'], `${long.slice(0, 47)}...`);
  assert.equal(deployment.annotations['workers/message'].length, 50);
  assert.equal(deployment.versions[0].version_id, version.id);
  assert.equal(cloud.live('example-app'), version.id);
  const [session, done] = await records(where.outFile);
  assert.equal(session.type, 'wrangler-session');
  assert.equal(done.type, 'deploy');
  assert.equal(done.version_id, version.id);
  assert.equal(done.worker_name, 'example-app');
  assert.deepEqual(done.targets, []);
  // Exactly 50 characters is not cut.
  await wrangler(cloud, ['deploy', '--message', 'm'.repeat(50)], where);
  assert.equal((await cloud.state('example-app')).deployments.at(-1).annotations['workers/message'], 'm'.repeat(50));
});

test('a deployment of a version older than a later secret change answers 10220 unless forced', async () => {
  const dir = await tempDir('cloud-');
  const cloud = await fakeCloud({ dir: join(dir, 'cloud'), workers: { 'example-app': { versions: [{ message: 'a' }, { message: 'b', triggered: 'secret' }], deployments: [{ versionId: null }] } } });
  const cf = cloudflare({ token: 't', accountId: 'acc', fetchImpl: cloud.fetch });
  const [older, secret] = (await cloud.state('example-app')).versions;
  assert.equal(cloud.live('example-app'), secret.id);
  await assert.rejects(cf.createDeployment('example-app', older.id, 'm'), (e) => e instanceof CloudflareError && e.status === 400 && e.codes.join() === '10220');
  assert.equal(cloud.live('example-app'), secret.id);
  assert.equal(cloud.apiCalls.at(-1).path, 'workers/scripts/example-app/deployments');
  await cf.createDeployment('example-app', older.id, 'm', { force: true });
  assert.equal(cloud.apiCalls.at(-1).path, 'workers/scripts/example-app/deployments?force=true');
  assert.equal(cloud.live('example-app'), older.id);
  const forced = (await cloud.state('example-app')).deployments.at(-1);
  assert.equal(forced.source, 'api');
  assert.equal(forced.annotations['workers/message'], 'm');
  // The secret version itself is newer than the target: no force needed.
  await cf.createDeployment('example-app', secret.id, 'again');
  assert.equal(cloud.live('example-app'), secret.id);
  await assert.rejects(cf.createDeployment('example-app', 'no-such-version', 'm'), (e) => e instanceof CloudflareError && e.status === 400 && e.codes.join() === '10209');
});

test('a missing Worker answers 10007; a route or host the fake does not model fails loudly', async () => {
  const dir = await tempDir('cloud-');
  const cloud = await fakeCloud({ dir: join(dir, 'cloud'), workers: seeded, hosts: { 'https://app.example.com': 'example-app' } });
  const cf = cloudflare({ token: 't', accountId: 'acc', fetchImpl: cloud.fetch });
  await assert.rejects(cf.subdomain('nope'), (e) => e instanceof CloudflareError && e.status === 404 && e.codes.join() === '10007');
  assert.deepEqual(await cf.versions('nope'), []);
  assert.deepEqual(await cf.deployments('nope'), []);
  await assert.rejects(cloud.fetch(`${API}workers/scripts/example-app/routes`), /no such API route: GET workers\/scripts\/example-app\/routes/);
  await assert.rejects(cloud.fetch(`${API}workers/scripts/example-app/versions`, { method: 'POST', body: '{}' }), /no such API route: POST /);
  await assert.rejects(cloud.fetch(`${API}workers/scripts/nope/routes`), /no such API route/);
  await assert.rejects(cloud.fetch('https://other.example.com/x'), /https:\/\/other\.example\.com/);
  await assert.rejects(cloud.fetch('https://api.cloudflare.com/client/v4/accounts/other/workers/subdomain'), /api\.cloudflare\.com/);
  assert.equal((await cloud.fetch('https://app.example.com/x')).status, 200);
});

test('the fake wrangler: create false, a failing exit, --flag=value, and a config it cannot read', async () => {
  const dir = await tempDir('cloud-');
  const cloud = await fakeCloud({ dir: join(dir, 'cloud'), workers: seeded });
  const where = await workDir(dir);
  await cloud.setWrangler({ 'versions upload': { create: false } });
  await wrangler(cloud, ['versions', 'upload', '--message', 'sha:one'], where);
  assert.equal((await cloud.state('example-app')).versions.length, 1);
  assert.deepEqual((await records(where.outFile)).map((r) => r.type), ['wrangler-session']);

  // A failing upload still leaves its version behind (it was uploaded, then wrangler died), but no record.
  await cloud.setWrangler({ 'versions upload': { exit: 3 } });
  await assert.rejects(wrangler(cloud, ['versions', 'upload', '--message=sha:two'], where), (e) => e.code === 3 && /failing as told/.test(e.stderr));
  const w = await cloud.state('example-app');
  assert.equal(w.versions.length, 2);
  assert.equal(w.versions.at(-1).annotations['workers/message'], 'sha:two');
  assert.deepEqual((await records(where.outFile)).map((r) => r.type), ['wrangler-session', 'wrangler-session']);

  // --config=<file> names the Worker; an unreadable config still leaves a call record and one line on stderr.
  await writeFile(join(where.work, 'alt.json'), JSON.stringify({ name: 'other-app' }));
  await cloud.setWrangler({});
  await wrangler(cloud, ['versions', 'upload', '--config=alt.json'], where);
  await assert.rejects(capture(cloud.bin, ['versions', 'upload'], { cwd: dir }), (e) => e.code === 1 && e.stderr.trim().split('\n').length === 1 && /wrangler\.json/.test(e.stderr));
  const calls = await cloud.wranglerCalls();
  assert.deepEqual(calls.map((c) => c.worker), ['example-app', 'example-app', 'other-app', null]);
  assert.equal(calls.at(-1).cmd, 'versions upload');
});

test('live(), addVersion() and addDeployment() see what wrangler did, even when it failed', async () => {
  const dir = await tempDir('cloud-');
  const cloud = await fakeCloud({ dir: join(dir, 'cloud'), workers: seeded });
  const where = await workDir(dir);
  const failingDeploy = () => assert.rejects(wrangler(cloud, ['deploy', '--message', 'sha:x'], where), (e) => e.code === 1);
  const before = cloud.live('example-app');
  await cloud.setWrangler({ deploy: { exit: 1 } });
  await failingDeploy();
  const after = cloud.live('example-app'); // nothing else was asked of the fake since wrangler ran
  assert.notEqual(after, before);
  await failingDeploy();
  const mine = cloud.addVersion('example-app', { message: 'mine' }); // wrangler's second version comes first
  assert.equal(mine.number, 4);
  await failingDeploy();
  cloud.addDeployment('example-app', mine.id); // wrangler's third deployment comes first
  assert.equal(cloud.live('example-app'), mine.id);
  const versions = (await cloud.state('example-app')).versions;
  assert.deepEqual(versions.map((v) => v.number), [1, 2, 3, 4, 5]);
  assert.equal(versions[1].id, after);
});

test('a half-written event line waits for its newline and is applied once', async () => {
  const dir = await tempDir('cloud-');
  const eventsFile = join(dir, 'cloud', 'events.jsonl');
  const cloud = await fakeCloud({ dir: join(dir, 'cloud'), workers: { 'example-app': {} } });
  const version = `${JSON.stringify({ worker: 'example-app', type: 'version', id: 'v-1', message: null, triggered: 'version_upload' })}\n`;
  const deployment = `${JSON.stringify({ worker: 'example-app', type: 'deployment', versionId: 'v-1', message: null, triggered: 'upload' })}\n`;
  await appendFile(eventsFile, version + deployment.slice(0, 20));
  let w = await cloud.state('example-app');
  assert.equal(w.versions.length, 1);
  assert.equal(w.deployments.length, 0);
  await appendFile(eventsFile, deployment.slice(20));
  w = await cloud.state('example-app');
  assert.equal(w.versions.length, 1);
  assert.equal(w.deployments.length, 1);
  assert.equal(cloud.live('example-app'), 'v-1');
  assert.equal((await cloud.state('example-app')).deployments.length, 1);
});

test('deployments and versions page the same way, newest first', async () => {
  const dir = await tempDir('cloud-');
  const cloud = await fakeCloud({ dir: join(dir, 'cloud'), workers: { 'example-app': { versions: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }], deployments: [{ versionId: 'v1' }, { versionId: 'v2' }, { versionId: 'v3' }] } } });
  const ids = async (query) => (await (await cloud.fetch(`${API}workers/scripts/example-app/deployments${query}`)).json()).result.deployments.map((d) => d.versions[0].version_id);
  assert.deepEqual(await ids('?per_page=2&page=1'), ['v3', 'v2']);
  assert.deepEqual(await ids('?per_page=2&page=2'), ['v1']);
  assert.deepEqual(await ids(''), ['v3', 'v2', 'v1']);
  const versions = async (query) => (await (await cloud.fetch(`${API}workers/scripts/example-app/versions${query}`)).json()).result.items.map((v) => v.id);
  assert.deepEqual(await versions('?per_page=2&page=2'), ['v1']);
  const cf = cloudflare({ token: 't', accountId: 'acc', fetchImpl: cloud.fetch });
  assert.deepEqual((await cf.deployments('example-app')).map((d) => d.versions[0].version_id), ['v3', 'v2', 'v1']);
});

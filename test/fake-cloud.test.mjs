import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capture } from '../lib/proc.mjs';
import { cloudflare } from '../lib/cloudflare.mjs';
import { fakeCloud } from './fake-cloud.mjs';
import { tempDir } from './helpers.mjs';

test('the fake wrangler and the fake API share one state', async () => {
  const dir = await tempDir('cloud-');
  const cloud = await fakeCloud({ dir: join(dir, 'cloud'), workers: { 'example-app': { versions: [{ message: 'seed' }], deployments: [{ versionId: null }] } },
    hosts: { 'https://app.example.com': 'example-app' }, probe: ({ versionId }) => ({ status: 200, body: versionId }) });
  const seeded = (await cloud.state('example-app')).versions[0].id;
  assert.equal(cloud.live('example-app'), seeded);
  const work = join(dir, 'work');
  await mkdir(work);
  await writeFile(join(work, 'wrangler.json'), '{"name":"example-app"}');
  const outFile = join(dir, 'out.ndjson');
  await capture(cloud.bin, ['versions', 'upload', '--message', 'sha:x'], { cwd: work, env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outFile } });
  const rec = JSON.parse((await readFile(outFile, 'utf8')).trim());
  assert.equal(rec.type, 'version-upload');
  assert.equal(rec.preview_url, `https://${rec.version_id.slice(0, 8)}-example-app.example.workers.dev`);
  const cf = cloudflare({ token: 't', accountId: 'acc', fetchImpl: cloud.fetch });
  assert.equal((await cf.versions('example-app'))[0].annotations['workers/message'], 'sha:x');
  assert.equal(await (await cloud.fetch(`${rec.preview_url}/x`)).text(), rec.version_id);
  assert.equal(await (await cloud.fetch('https://app.example.com/x')).text(), seeded);
  await cf.createDeployment('example-app', rec.version_id, 'sha:x');
  assert.equal(await (await cloud.fetch('https://app.example.com/x')).text(), rec.version_id);
  assert.deepEqual((await cloud.wranglerCalls()).map((c) => c.cmd), ['versions upload']);
});

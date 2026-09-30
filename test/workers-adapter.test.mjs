import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '../lib/config.mjs';
import { cloudflare } from '../lib/cloudflare.mjs';
import { resolveLive } from '../lib/live.mjs';
import { readHold, writeHold } from '../lib/state.mjs';
import { deployMessage, deployOne } from '../lib/adapters/workers.mjs';
import { fakeCloud } from './fake-cloud.mjs';
import { tempDir } from './helpers.mjs';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const creds = { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' };
const BUILD = 'test -f .env.local && mkdir -p .next out && echo BUILD42 > .next/BUILD_ID && echo "https://good.db.example" > out/handler.mjs';
const APP = {
  name: 'app', worker: 'example-app', cwd: 'app', paths: ['app/**'], mode: 'versioned', wrangler: 'tools/wrangler', build: BUILD,
  bundleCheck: { file: 'out/handler.mjs', pattern: 'https://[a-z]+\\.db\\.example', allow: ['https://good.db.example'] },
  probes: [{ path: '/health', status: 200 }], liveHost: 'https://app.example.com', liveMarker: { path: '/login', file: '.next/BUILD_ID' },
};
const TICK = { name: 'tick', worker: 'example-tick', cwd: 'workers/tick', paths: ['workers/tick/**'], mode: 'direct', wrangler: 'tools/wrangler',
  probes: [{ path: '/', status: 403 }], liveHost: 'https://tick.example.com' };
const healthy = ({ path }) => (path === '/login' ? { status: 200, body: '<!--BUILD42-->' } : path === '/' ? 403 : 200);

async function fixture({ dep = APP, patch = {}, probe = healthy, wrangler = {}, previews = true, liveConfig = null, targetConfig = null, configFile = 'wrangler.json', fresh = false, fetchWrap = (f) => f } = {}) {
  const dir = await tempDir('adapter-');
  const cloud = await fakeCloud({
    dir: join(dir, 'cloud'), probe, wrangler, hosts: { 'https://app.example.com': 'example-app', 'https://tick.example.com': 'example-tick' },
    workers: Object.fromEntries(['example-app', 'example-tick'].map((w) => [w, fresh ? { previews, versions: [], deployments: [] } : { previews, versions: [{ message: `sha:${OLD} old` }], deployments: [{ versionId: null, message: `sha:${OLD} old` }] }])),
  });
  const wt = join(dir, 'wt');
  const config = validateConfig({ repo: 't/r', checks: [{ name: 'u', paths: ['**'], steps: ['true'] }], credentials: { file: '/x', map: { CLOUDFLARE_API_TOKEN: 'T', CLOUDFLARE_ACCOUNT_ID: 'A' } },
    deployables: [{ ...dep, ...patch, envFiles: dep === APP ? [{ from: join(dir, 'secret.env'), to: 'app/.env.local' }] : [] }] });
  const d0 = config.deployables[0];
  const plain = `{"name":"${d0.worker}"}`;
  await writeFile(join(dir, 'secret.env'), 'K=v\n');
  await mkdir(join(wt, d0.cwd), { recursive: true });
  await mkdir(join(wt, 'tools'), { recursive: true });
  await copyFile(cloud.bin, join(wt, 'tools', 'wrangler'));
  await chmod(join(wt, 'tools', 'wrangler'), 0o755);
  if (configFile) await writeFile(join(wt, d0.cwd, configFile), targetConfig ?? plain);
  const fetchImpl = fetchWrap(cloud.fetch);
  const cf = cloudflare({ token: 'tok', accountId: 'acc', fetchImpl });
  const [deployments, versions] = await Promise.all([cf.deployments(d0.worker), cf.versions(d0.worker)]);
  const lines = [];
  const stateRoot = join(dir, 'state');
  const d = { out: (l) => lines.push(l), tmpRoot: join(dir, 'tmp'), pollMs: 10, stateRoot, fetch: fetchImpl, probeWindowMs: 0, probeIntervalMs: 0, sleep: async () => {} };
  const ctx = { d, r: { repo: 't/r' }, wt, dep: d0, entry: { live: resolveLive({ deployments, versions }) }, cf, creds, target: NEW, nonce: 'n0nce0', note: '#7',
    logFile: join(dir, 'deploy.log'), dryRun: false, readAt: async () => liveConfig ?? plain };
  return { cloud, ctx, lines, wt, stateRoot, d0 };
}
const exists = (p) => access(p).then(() => true, () => false);
const posts = (cloud) => cloud.apiCalls.filter((c) => c.method === 'POST');
const failsWith = async (opts, re) => {
  const { cloud, ctx, wt, stateRoot } = await fixture(opts);
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'failed');
  assert.match(res.detail, re);
  assert.equal(await readHold(stateRoot, 't/r', ctx.dep.name), null, 'a deploy that failed changed nothing and leaves no hold');
  return { cloud, wt };
};
// The rollback request reaches Cloudflare and is applied, but the answer never arrives.
const loseRollbackAnswer = (inner) => async (url, init = {}) => {
  const res = await inner(url, init);
  if (init.method === 'POST' && JSON.parse(init.body).annotations['workers/message'].endsWith(' rollback')) throw new Error('socket hang up');
  return res;
};

// Every read of Cloudflare after the promote fails: ship cannot check what it just did.
const failReadsAfterPromote = (inner) => {
  let promoted = false;
  return async (url, init = {}) => {
    if (promoted && (init.method ?? 'GET') === 'GET') throw new Error('socket hang up');
    const res = await inner(url, init);
    if (init.method === 'POST') promoted = true;
    return res;
  };
};
// From the promote on, the state directory is a file: no hold can be written or read any more.
const breakStateAfterPromote = (stateRoot, { failReads = false } = {}) => (inner) => {
  const base = failReads ? failReadsAfterPromote(inner) : inner;
  return async (url, init = {}) => {
    const res = await base(url, init);
    if (init.method === 'POST') {
      await rm(stateRoot(), { recursive: true, force: true });
      await writeFile(stateRoot(), 'a file where the state directory should be');
    }
    return res;
  };
};
const IN_PROGRESS = /^deploy of bbbbbbb in progress since \d\d\/\d\d, \d\d:\d\d: if ship is not running, the result was never verified — ship status, then the owner decides \(ship unhold (app|tick)\)$/;

// A deploy in a child process that gets SIGTERM once wrangler is running. Resolves to the hold the
// interrupted process left behind (null: none) and its exit code.
async function interruptDuringWrangler({ dep, wrangler }) {
  const dir = await tempDir('interrupt-');
  const href = (p) => JSON.stringify(new URL(p, import.meta.url).href);
  const script = join(dir, 'child.mjs');
  await writeFile(script, `
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateConfig } from ${href('../lib/config.mjs')};
import { cloudflare } from ${href('../lib/cloudflare.mjs')};
import { resolveLive } from ${href('../lib/live.mjs')};
import { onInterrupt } from ${href('../lib/interrupt.mjs')};
import { deployOne } from ${href('../lib/adapters/workers.mjs')};
import { fakeCloud } from ${href('./fake-cloud.mjs')};

const dir = ${JSON.stringify(dir)};
const OLD = 'a'.repeat(40);
const cloud = await fakeCloud({ dir: join(dir, 'cloud'), wrangler: ${JSON.stringify(wrangler)},
  workers: { 'example-app': { versions: [{ message: 'sha:' + OLD + ' old' }], deployments: [{ versionId: null, message: 'sha:' + OLD + ' old' }] } } });
const config = validateConfig({ repo: 't/r', checks: [{ name: 'u', paths: ['**'], steps: ['true'] }], credentials: { file: '/x', map: { CLOUDFLARE_API_TOKEN: 'T', CLOUDFLARE_ACCOUNT_ID: 'A' } },
  deployables: [{ name: 'app', worker: 'example-app', cwd: 'app', paths: ['app/**'], wrangler: 'tools/wrangler', probes: [{ path: '/', status: 200 }], liveHost: 'https://app.example.com', ...${JSON.stringify(dep)} }] });
const wt = join(dir, 'wt');
await mkdir(join(wt, 'app'), { recursive: true });
await mkdir(join(wt, 'tools'), { recursive: true });
await copyFile(cloud.bin, join(wt, 'tools', 'wrangler'));
await chmod(join(wt, 'tools', 'wrangler'), 0o755);
await writeFile(join(wt, 'app', 'wrangler.json'), '{"name":"example-app"}');
const cf = cloudflare({ token: 'tok', accountId: 'acc', fetchImpl: cloud.fetch });
const live = resolveLive({ deployments: await cf.deployments('example-app'), versions: await cf.versions('example-app') });
onInterrupt(() => {}); // as in ship, other parts of the run have installed the handlers by now
process.stdout.write('ready\\n');
await deployOne({ d: { out: () => {}, tmpRoot: join(dir, 'tmp'), pollMs: 10, stateRoot: join(dir, 'state'), fetch: cloud.fetch, probeWindowMs: 0, probeIntervalMs: 0, sleep: async () => {} },
  r: { repo: 't/r' }, wt, dep: config.deployables[0], entry: { live }, cf, creds: { CLOUDFLARE_API_TOKEN: 'tok' }, target: 'b'.repeat(40), nonce: 'n0nce0',
  logFile: join(dir, 'deploy.log'), readAt: async () => '{"name":"example-app"}' });
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exit = once(child, 'exit');
  try {
    const until = Date.now() + 15_000;
    const called = async () => (await readFile(join(dir, 'cloud', 'wrangler-calls.jsonl'), 'utf8').catch(() => '')).trim() !== '';
    while (!(await called())) {
      if (child.exitCode !== null || Date.now() > until) throw new Error('the child never started wrangler');
      await new Promise((r) => setTimeout(r, 25));
    }
    child.kill('SIGTERM');
    const [code] = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('the child did not exit')), 15_000).unref())]);
    return { code, hold: await readHold(join(dir, 'state'), 't/r', 'app') };
  } finally {
    child.kill('SIGKILL');
  }
}

// A deploy in a child process (leading its own process group) that is killed outright with SIGKILL
// once our code is live and not yet verified: for a versioned deploy while the live probes wait for
// an answer, for a direct one while `wrangler deploy` (which has already made the deployment) runs.
// Resolves to the hold the dead process left behind (null: none).
async function killedAfterPromote(mode) {
  const dir = await tempDir('killed-');
  const href = (p) => JSON.stringify(new URL(p, import.meta.url).href);
  const script = join(dir, 'child.mjs');
  await writeFile(script, `
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from ${href('../lib/config.mjs')};
import { cloudflare } from ${href('../lib/cloudflare.mjs')};
import { resolveLive } from ${href('../lib/live.mjs')};
import { deployOne } from ${href('../lib/adapters/workers.mjs')};
import { fakeCloud } from ${href('./fake-cloud.mjs')};

const dir = ${JSON.stringify(dir)};
const mode = ${JSON.stringify(mode)};
const OLD = 'a'.repeat(40);
const cloud = await fakeCloud({ dir: join(dir, 'cloud'), wrangler: { deploy: { sleepMs: 60_000 } },
  hosts: { 'https://app.example.com': 'example-app' },
  probe: ({ preview }) => {
    if (preview) return 200;
    writeFileSync(join(dir, 'live-probing'), '1');
    return new Promise(() => {}); // the live host never answers
  },
  workers: { 'example-app': { versions: [{ message: 'sha:' + OLD + ' old' }], deployments: [{ versionId: null, message: 'sha:' + OLD + ' old' }] } } });
const config = validateConfig({ repo: 't/r', checks: [{ name: 'u', paths: ['**'], steps: ['true'] }], credentials: { file: '/x', map: { CLOUDFLARE_API_TOKEN: 'T', CLOUDFLARE_ACCOUNT_ID: 'A' } },
  deployables: [{ name: 'app', worker: 'example-app', cwd: 'app', paths: ['app/**'], wrangler: 'tools/wrangler', probes: [{ path: '/', status: 200 }], liveHost: 'https://app.example.com', mode }] });
const wt = join(dir, 'wt');
await mkdir(join(wt, 'app'), { recursive: true });
await mkdir(join(wt, 'tools'), { recursive: true });
await copyFile(cloud.bin, join(wt, 'tools', 'wrangler'));
await chmod(join(wt, 'tools', 'wrangler'), 0o755);
await writeFile(join(wt, 'app', 'wrangler.json'), '{"name":"example-app"}');
const cf = cloudflare({ token: 'tok', accountId: 'acc', fetchImpl: cloud.fetch });
const live = resolveLive({ deployments: await cf.deployments('example-app'), versions: await cf.versions('example-app') });
process.stdout.write('ready\\n');
setInterval(() => {}, 1000); // a live host that never answers must not let the process end
await deployOne({ d: { out: () => {}, tmpRoot: join(dir, 'tmp'), pollMs: 10, stateRoot: join(dir, 'state'), fetch: cloud.fetch, probeWindowMs: 60_000, probeIntervalMs: 10, sleep: async () => {} },
  r: { repo: 't/r' }, wt, dep: config.deployables[0], entry: { live }, cf, creds: { CLOUDFLARE_API_TOKEN: 'tok' }, target: 'b'.repeat(40), nonce: 'n0nce0',
  logFile: join(dir, 'deploy.log'), readAt: async () => '{"name":"example-app"}' });
`);
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const exit = once(child, 'exit');
  const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
  try {
    const until = Date.now() + 20_000;
    const promoted = async () => (mode === 'versioned'
      ? existsSync(join(dir, 'live-probing'))
      : (await readFile(join(dir, 'cloud', 'wrangler-calls.jsonl'), 'utf8').catch(() => '')).trim() !== '');
    while (!(await promoted())) {
      if (child.exitCode !== null || Date.now() > until) throw new Error('the child never got to the promote');
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 300)); // the deployment request or wrangler has done its work
    killGroup();
    await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('the child did not die')), 15_000).unref())]);
    return await readHold(join(dir, 'state'), 't/r', 'app');
  } finally {
    killGroup();
  }
}

test('deployMessage starts with the sha and stays short', () => {
  assert.equal(deployMessage({ sha: NEW, name: 'app', nonce: 'n0nce0', note: '#7 #8' }), `sha:${NEW} app run:n0nce0 #7 #8`);
  assert.ok(deployMessage({ sha: NEW, name: 'app', nonce: 'x', note: 'y'.repeat(500) }).length <= 200);
});

test('versioned: upload, preview probes, promote, live probes, build marker', async () => {
  process.env.SHIP_TEST_CALLER_SECRET = 'must-not-leak';
  const { cloud, ctx, lines, wt } = await fixture();
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'deployed', lines.join('\n'));
  const [call] = await cloud.wranglerCalls();
  assert.equal(call.cmd, 'versions upload');
  assert.equal(call.token, 'tok');
  assert.ok(!call.envKeys.includes('SHIP_TEST_CALLER_SECRET'));
  assert.deepEqual(posts(cloud).map((p) => p.body.annotations['workers/message']), [`sha:${NEW} app run:n0nce0 #7`]);
  assert.equal(cloud.live('example-app'), res.versionId);
  assert.equal(await exists(join(wt, 'app', '.env.local')), false);
  assert.match(lines.join('\n'), /serves build BUILD42/);
});

test('versioned: stating preview_urls: true while previews are on is no change', async () => {
  const { ctx } = await fixture({ targetConfig: '{"name":"example-app","preview_urls":true}' });
  assert.equal((await deployOne(ctx)).outcome, 'deployed');
});

test('versioned: refusals before any build', async () => {
  const cron = await failsWith({ targetConfig: '{"name":"example-app","triggers":{"crons":["0 * * * *"]}}' }, /triggers\.crons \(config 0 \* \* \* \*, Worker none\)/);
  assert.deepEqual(await cron.cloud.wranglerCalls(), []);
  assert.equal(await exists(join(cron.wt, 'app', '.next')), false);
  await failsWith({ targetConfig: '{"name":"example-app","observability":{"enabled":true}}' }, /observability changed in app\/wrangler.json/);
  await failsWith({ previews: false }, /preview_urls \(config true, Worker false\)/);
  await failsWith({ targetConfig: '{"name":"example-app","preview_urls":false}', previews: false }, /preview URLs are off/);
});

test('versioned: a Worker that does not exist yet is not deployed to', async () => {
  const { cloud } = await failsWith({ patch: { worker: 'example-missing' } }, /example-missing does not exist yet/);
  assert.deepEqual(await cloud.wranglerCalls(), []);
});

test('a config that cannot be read or parsed names its file and stops before any build', async () => {
  const target = await failsWith({ targetConfig: '{ not json' }, /^app\/wrangler\.json: /);
  assert.deepEqual(await target.cloud.wranglerCalls(), []);
  assert.equal(await exists(join(target.wt, 'app', '.next')), false);
  await failsWith({ liveConfig: '{ not json' }, /^app\/wrangler\.json: /);
  await failsWith({ configFile: 'wrangler.toml', targetConfig: '[observability' }, /^app\/wrangler\.toml: unparseable TOML table header/);
  await failsWith({ dep: TICK, targetConfig: '{ not json' }, /^workers\/tick\/wrangler\.json: /);
  await failsWith({ patch: { wranglerConfig: 'custom.jsonc' } }, /^app\/custom\.jsonc: /);
  await failsWith({ configFile: null }, /no wrangler\.json \/ wrangler\.jsonc \/ wrangler\.toml in app/);
});

test('a config that names another Worker than the deployable is refused before any build or upload', async () => {
  const other = await failsWith({ targetConfig: '{"name":"example-other"}' }, /^app\/wrangler\.json: name "example-other" is not this deployable's worker "example-app"/);
  assert.deepEqual(await other.cloud.wranglerCalls(), []);
  assert.equal(await exists(join(other.wt, 'app', '.next')), false);
  // wrangler deploys to the config's name: the Worker that name belongs to must not be touched
  const typo = await fixture({ dep: TICK, targetConfig: '{"name":"example-tik"}' });
  const res = await deployOne(typo.ctx);
  assert.equal(res.outcome, 'failed');
  assert.match(res.detail, /^workers\/tick\/wrangler\.json: name "example-tik" is not this deployable's worker "example-tick"/);
  assert.deepEqual(await typo.cloud.wranglerCalls(), []);
  assert.equal((await typo.cloud.state('example-tick')).deployments.length, 1);
  await failsWith({ configFile: 'wrangler.toml', targetConfig: 'name = "example-other"\nmain = "src/index.ts"\n' }, /^app\/wrangler\.toml: name "example-other" is not/);
});

test('a config without a top-level name is refused: wrangler would pick a name of its own', async () => {
  await failsWith({ targetConfig: '{"vars":{"name":"example-app"}}' }, /^app\/wrangler\.json: no top-level "name"/);
  await failsWith({ configFile: 'wrangler.toml', targetConfig: '[vars]\nname = "example-app"\n' }, /^app\/wrangler\.toml: no top-level "name"/);
});

test('the config name may be written as jsonc or toml', async () => {
  // a dry run goes through the config checks and the build, and stops before wrangler
  const jsonc = await fixture({ configFile: 'wrangler.jsonc', targetConfig: '{ // the Worker\n "name": "example-app", }' });
  assert.equal((await deployOne({ ...jsonc.ctx, dryRun: true })).outcome, 'dry-run', jsonc.lines.join('\n'));
  const toml = await fixture({ configFile: 'wrangler.toml', targetConfig: 'main = "src/index.ts"\nname = "example-app" # the Worker\n[vars]\nname = "other"\n', liveConfig: 'name = "example-app"\n' });
  assert.equal((await deployOne({ ...toml.ctx, dryRun: true })).outcome, 'dry-run', toml.lines.join('\n'));
});

test('versioned: a failing preview probe leaves live untouched', async () => {
  const { cloud } = await failsWith({ probe: (p) => (p.preview ? 500 : healthy(p)) }, /preview probes failed .*secret put/);
  assert.deepEqual(posts(cloud), []);
});

test('versioned: a hung upload that made the version is found by its message', async () => {
  const { ctx, lines } = await fixture({ patch: { uploadTimeoutMin: 0.05 }, wrangler: { 'versions upload': { sleepMs: 30_000 } } });
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'deployed', lines.join('\n'));
  assert.match(lines.join('\n'), /upload timed out, but version .* with our message exists/);
});

test('versioned: a failed upload without a version stops', async () => {
  const { cloud } = await failsWith({ wrangler: { 'versions upload': { create: false, exit: 1 } } }, /no version carries our message; live untouched/);
  assert.deepEqual(posts(cloud), []);
});

test('versioned: a version made after ours blocks the promote', async () => {
  let once = true;
  const { cloud } = await failsWith({ probe: (p) => {
    if (p.preview && once) { once = false; p.cloud.addVersion('example-app', { message: 'Updated secret "K"' }); }
    return healthy(p);
  } }, /was made after ours; not promoting/);
  assert.deepEqual(posts(cloud), []);
});

test('versioned: live changing during the deploy blocks the promote', async () => {
  const other = 'c'.repeat(40);
  let once = true;
  const { cloud } = await failsWith({ probe: (p) => {
    if (p.preview && once) {
      once = false;
      const v = p.cloud.addVersion('example-app', { message: `sha:${other} other` });
      p.cloud.addDeployment('example-app', v.id, { message: `sha:${other} other` });
    }
    return healthy(p);
  } }, /live changed during the deploy \(aaaaaaa .* → ccccccc .*\); not promoting/);
  assert.deepEqual(posts(cloud), []);
});

test('direct: live changing before the deploy blocks it', async () => {
  const other = 'c'.repeat(40);
  let cloud;
  let changed = false;
  const fx = await fixture({ dep: TICK, fetchWrap: (inner) => async (url, init = {}) => {
    if (cloud && !changed && String(url).includes('/deployments?')) {
      changed = true;
      const v = cloud.addVersion('example-tick', { message: `sha:${other} other` });
      cloud.addDeployment('example-tick', v.id, { message: `sha:${other} other` });
    }
    return inner(url, init);
  } });
  cloud = fx.cloud;
  const res = await deployOne(fx.ctx);
  assert.equal(res.outcome, 'failed');
  assert.match(res.detail, /live changed during the deploy .*; not deploying/);
  assert.deepEqual(await cloud.wranglerCalls(), []);
});

test('a failing live probe: hold, rollback to the previous version, re-probe', async () => {
  let oldId;
  const { cloud, ctx, stateRoot } = await fixture({ probe: (p) => (p.preview || p.versionId === oldId ? healthy(p) : 500) });
  oldId = cloud.live('example-app');
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'rolled-back');
  assert.match(res.detail, /live probes failed .*Rolled back to aaaaaaa.*live probes after rollback: ok/);
  assert.equal(cloud.live('example-app'), oldId);
  assert.equal(posts(cloud).at(-1).body.annotations['workers/message'], `sha:${OLD} rollback`);
  assert.match((await readHold(stateRoot, 't/r', 'app')).reason, /live probes failed/);
});

test('a failed rollback keeps the hold and says what is live', async () => {
  let oldId;
  const failRollback = (inner) => async (url, init = {}) =>
    (init.method === 'POST' && JSON.parse(init.body).annotations['workers/message'].endsWith(' rollback')
      ? new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'boom' }] }), { status: 500 })
      : inner(url, init));
  const { cloud, ctx, stateRoot } = await fixture({ fetchWrap: failRollback, probe: (p) => (p.preview || p.versionId === oldId ? healthy(p) : 500) });
  oldId = cloud.live('example-app');
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'stuck');
  assert.match(res.detail, /Rolling back to .* failed .*boom.*hold in place/);
  assert.ok(await readHold(stateRoot, 't/r', 'app'));
});

test('the auto-rollback re-reads the deployment first: another version live means no rollback', async () => {
  const other = 'c'.repeat(40);
  let injected = false;
  const { cloud, ctx, stateRoot } = await fixture({ probe: (p) => {
    if (p.preview) return healthy(p);
    if (!injected) {
      injected = true;
      const v = p.cloud.addVersion('example-app', { message: `sha:${other} other` });
      p.cloud.addDeployment('example-app', v.id, { message: `sha:${other} other` });
    }
    return 500;
  } });
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'stuck');
  assert.match(res.detail, /live probes failed .*Not rolling back: version [0-9a-f]{8} is live, not ours .*hold in place/);
  assert.equal(posts(cloud).length, 1, 'only our own promote; no rollback deployment');
  assert.ok(await readHold(stateRoot, 't/r', 'app'));
  assert.equal(cloud.live('example-app'), (await cloud.state('example-app')).versions.at(-1).id);
});

test('a rollback whose answer is lost is checked against what is live', async () => {
  let oldId;
  const { cloud, ctx, stateRoot } = await fixture({ fetchWrap: loseRollbackAnswer, probe: (p) => (p.preview || p.versionId === oldId ? healthy(p) : 500) });
  oldId = cloud.live('example-app');
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'stuck');
  assert.match(res.detail, /Rolling back to .* failed .*socket hang up.*the rollback did take effect: .*hold in place/);
  assert.equal(cloud.live('example-app'), oldId);
  assert.ok(await readHold(stateRoot, 't/r', 'app'));
});

test('a rollback Cloudflare refuses over a changed secret names the way out', async () => {
  let oldId;
  const { cloud, ctx, stateRoot } = await fixture({ probe: (p) => (p.preview || p.versionId === oldId ? healthy(p) : 500) });
  oldId = cloud.live('example-app');
  cloud.addVersion('example-app', { triggered: 'secret' });
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'stuck');
  assert.match(res.detail, /Rolling back to .* failed .*our version .* is live; hold in place/);
  assert.ok(res.detail.includes(`ship rollback app --to ${oldId.slice(0, 8)} --revert-secrets`), res.detail);
  assert.ok(await readHold(stateRoot, 't/r', 'app'));
});

test('a changed Durable Object migration is not rolled back past', async () => {
  const targetConfig = '{"name":"example-tick","migrations":[{"tag":"v1","new_classes":["Counter"]}]}';
  const { cloud, ctx, stateRoot } = await fixture({ dep: TICK, targetConfig, probe: () => 500 });
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'stuck');
  assert.match(res.detail, /live probes failed .*Durable Object migration changed/);
  assert.deepEqual(posts(cloud), []);
  assert.match((await readHold(stateRoot, 't/r', 'tick')).reason, /live probes failed/);
});

test('another version current right after the promote is held, not rolled over', async () => {
  const other = 'c'.repeat(40);
  let cloud;
  const fx = await fixture({ fetchWrap: (inner) => async (url, init = {}) => {
    const res = await inner(url, init);
    if (cloud && init.method === 'POST') {
      const v = cloud.addVersion('example-app', { message: `sha:${other} other` });
      cloud.addDeployment('example-app', v.id, { message: `sha:${other} other` });
    }
    return res;
  } });
  cloud = fx.cloud;
  const res = await deployOne(fx.ctx);
  assert.equal(res.outcome, 'stuck');
  assert.match(res.detail, /after the deploy the current version is .*, not ours .*hold set/);
  assert.equal(posts(cloud).length, 1);
  assert.ok(await readHold(fx.stateRoot, 't/r', 'app'));
});

test('a first deploy has nothing to roll back to: a failing live probe holds', async () => {
  const { cloud, ctx, stateRoot } = await fixture({ dep: TICK, fresh: true, probe: () => 500 });
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'stuck');
  assert.match(res.detail, /live probes failed .*no earlier version with a known commit/);
  assert.deepEqual(posts(cloud), []);
  assert.match((await readHold(stateRoot, 't/r', 'tick')).reason, /live probes failed/);
});

test('a live marker that never shows is a warning, not a rollback', async () => {
  const { cloud, ctx, lines } = await fixture({ probe: (p) => (p.path === '/login' ? { status: 200, body: 'an older build' } : healthy(p)) });
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'deployed', lines.join('\n'));
  assert.match(lines.join('\n'), /did not show build BUILD42.*not rolled back/);
  assert.equal(cloud.live('example-app'), res.versionId);
});

test('a live marker file that is missing or empty after the build stops before any upload', async () => {
  const missing = await failsWith({ patch: { liveMarker: { path: '/login', file: '.next/NOT_THERE' } } }, /live marker: app\/\.next\/NOT_THERE is missing after the build/);
  assert.deepEqual(await missing.cloud.wranglerCalls(), []);
  assert.deepEqual(posts(missing.cloud), []);
  const empty = await failsWith({ patch: { build: `${BUILD}; echo '  ' > .next/BUILD_ID` } }, /live marker: app\/\.next\/BUILD_ID is empty/);
  assert.deepEqual(await empty.cloud.wranglerCalls(), []);
  assert.equal(await exists(join(empty.wt, 'app', '.env.local')), false);
});

test('warmup paths are fetched on the preview and on the live host before the probes', async () => {
  const seen = [];
  const { ctx, lines } = await fixture({ patch: { warmup: ['/warm'] }, probe: (p) => { seen.push(`${p.preview ? 'preview' : 'live'} ${p.path}`); return healthy(p); } });
  assert.equal((await deployOne(ctx)).outcome, 'deployed', lines.join('\n'));
  assert.deepEqual(seen.filter((x) => x.endsWith('/warm')), ['preview /warm', 'live /warm']);
  assert.ok(seen.indexOf('preview /warm') < seen.indexOf('preview /health'));
  assert.ok(seen.indexOf('live /warm') < seen.indexOf('live /health'));
});

test('an error after the promote becomes a hold, never an exception', async () => {
  const { ctx, stateRoot } = await fixture({ fetchWrap: failReadsAfterPromote });
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'stuck');
  assert.match(res.detail, /ship error after the deploy.*socket hang up/);
  assert.match((await readHold(stateRoot, 't/r', 'app')).reason, /ship error after the deploy/);
});

test('a hold that cannot be written after the promote is reported, not thrown; the rollback still happens', async () => {
  let oldId;
  let rollback;
  rollback = await fixture({ fetchWrap: breakStateAfterPromote(() => rollback.stateRoot), probe: (p) => (p.preview || p.versionId === oldId ? healthy(p) : 500) });
  oldId = rollback.cloud.live('example-app');
  const rolled = await deployOne(rollback.ctx);
  assert.equal(rolled.outcome, 'rolled-back');
  assert.match(rolled.detail, /WARNING: the hold could not be written/);
  assert.doesNotMatch(rolled.detail, /Hold set/);
  assert.equal(rollback.cloud.live('example-app'), oldId);

  let broken;
  broken = await fixture({ fetchWrap: breakStateAfterPromote(() => broken.stateRoot, { failReads: true }) });
  const stuck = await deployOne(broken.ctx);
  assert.equal(stuck.outcome, 'stuck');
  assert.match(stuck.detail, /ship error after the deploy.*WARNING: the hold could not be written/);
  assert.doesNotMatch(stuck.detail, /hold set/);
});

test('a hold that cannot be written before the promote stops the deploy: nothing is promoted', async () => {
  for (const [dep, calls] of [[APP, ['versions upload']], [TICK, []]]) {
    const { cloud, ctx, stateRoot } = await fixture({ dep });
    await writeFile(stateRoot, 'a file where the state directory should be');
    const res = await deployOne(ctx);
    assert.equal(res.outcome, 'failed');
    assert.match(res.detail, /could not write the deploy-in-progress hold .*nothing was deployed/);
    assert.deepEqual((await cloud.wranglerCalls()).map((c) => c.cmd), calls);
    assert.deepEqual(posts(cloud), []);
    assert.equal(cloud.live(dep.worker), (await cloud.state(dep.worker)).deployments[0].versions[0].version_id);
  }
});

test('a hold marks the deploy from just before the promote to the end of the live probes, and a verified deploy leaves none', async () => {
  for (const dep of [APP, TICK]) {
    const seen = {};
    let fx;
    fx = await fixture({
      dep,
      fetchWrap: (inner) => async (url, init = {}) => {
        if (init.method === 'POST') seen.atPromote = await readHold(fx.stateRoot, 't/r', dep.name);
        return inner(url, init);
      },
      probe: async (p) => {
        if (!p.preview) seen.duringLiveProbes = await readHold(fx.stateRoot, 't/r', dep.name);
        return healthy(p);
      },
    });
    assert.equal(await readHold(fx.stateRoot, 't/r', dep.name), null);
    const res = await deployOne(fx.ctx);
    assert.equal(res.outcome, 'deployed', fx.lines.join('\n'));
    assert.match(seen.duringLiveProbes.reason, IN_PROGRESS, dep.name);
    assert.equal(seen.duringLiveProbes.sha, NEW);
    if (dep.mode === 'versioned') {
      assert.match(seen.atPromote.reason, IN_PROGRESS);
      assert.equal(seen.atPromote.versionId, res.versionId);
    }
    assert.equal(await readHold(fx.stateRoot, 't/r', dep.name), null, `${dep.name}: a verified deploy leaves no hold`);
  }
});

test('a verified deploy clears only its own hold', async () => {
  let fx;
  fx = await fixture({ probe: async (p) => {
    if (!p.preview) await writeHold(fx.stateRoot, 't/r', 'app', { reason: 'the owner is looking at it' });
    return healthy(p);
  } });
  const res = await deployOne(fx.ctx);
  assert.equal(res.outcome, 'deployed');
  assert.equal((await readHold(fx.stateRoot, 't/r', 'app')).reason, 'the owner is looking at it');
});

test('a hold that cannot be cleared after a verified deploy is reported and the deploy still counts', async () => {
  let fx;
  fx = await fixture({ probe: async (p) => {
    if (!p.preview) await chmod(join(fx.stateRoot, 'holds', 't__r'), 0o500); // its hold can be read, not removed
    return healthy(p);
  } });
  try {
    const res = await deployOne(fx.ctx);
    assert.equal(res.outcome, 'deployed');
    assert.match(fx.lines.join('\n'), /! app: deployed and verified, but its deploy-in-progress hold could not be cleared \(.*\) — ship unhold app/);
    assert.match((await readHold(fx.stateRoot, 't/r', 'app')).reason, IN_PROGRESS);
  } finally {
    await chmod(join(fx.stateRoot, 'holds', 't__r'), 0o700);
  }
});

// wrangler is told to make nothing, so the only thing that can write the hold is the interrupt
// handler: the deploy's own flow sees live untouched and reports a failure.
test('an interrupt while wrangler promotes leaves a hold; before the promote it leaves none', { timeout: 60_000 }, async () => {
  const promoting = await interruptDuringWrangler({ dep: { mode: 'direct' }, wrangler: { deploy: { create: false, sleepMs: 60_000 } } });
  assert.equal(promoting.code, 130);
  assert.match(promoting.hold?.reason ?? '', /interrupted while deploying/);
  const uploading = await interruptDuringWrangler({ dep: { mode: 'versioned' }, wrangler: { 'versions upload': { sleepMs: 60_000 } } });
  assert.equal(uploading.code, 130);
  assert.equal(uploading.hold, null);
});

// Nothing can run in a process that is killed outright, so the hold has to be there before.
test('a deploy killed outright after the promote leaves a hold that says the result was never verified', { timeout: 60_000 }, async () => {
  for (const mode of ['versioned', 'direct']) {
    const hold = await killedAfterPromote(mode);
    assert.match(hold?.reason ?? '', IN_PROGRESS, mode);
    assert.equal(hold.sha, NEW);
    if (mode === 'versioned') assert.ok(hold.versionId, 'the uploaded version is named');
  }
});

test('direct: wrangler deploy with the message, then live probes', async () => {
  const { cloud, ctx } = await fixture({ dep: TICK });
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'deployed');
  const [call] = await cloud.wranglerCalls();
  assert.equal(call.cmd, 'deploy');
  assert.equal(call.args[call.args.indexOf('--message') + 1], `sha:${NEW} tick run:n0nce0 #7`);
  assert.deepEqual(posts(cloud), []);
});

test('direct: wrangler failing after the code went live holds; failing before it changes nothing', async () => {
  const late = await fixture({ dep: TICK, wrangler: { deploy: { exit: 1 } } });
  const held = await deployOne(late.ctx);
  assert.equal(held.outcome, 'stuck');
  assert.match(held.detail, /wrangler deploy exited 1 after our code went live.*hold set/);
  assert.match((await readHold(late.stateRoot, 't/r', 'tick')).reason, /exited 1/);
  const early = await fixture({ dep: TICK, wrangler: { deploy: { create: false, exit: 1 } } });
  const failed = await deployOne(early.ctx);
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.detail, /wrangler deploy exited 1; live is aaaaaaa/);
  assert.equal(await readHold(early.stateRoot, 't/r', 'tick'), null);
});

test('direct --redeploy: wrangler failing before it uploads anything is not a hold, though live already is the target', async () => {
  const fx = await fixture({ dep: TICK, wrangler: { deploy: { create: false, exit: 1 } } });
  const version = fx.cloud.addVersion('example-tick', { message: `sha:${NEW} same code` });
  fx.cloud.addDeployment('example-tick', version.id, { message: `sha:${NEW} same code` });
  const entry = { live: resolveLive({ deployments: await fx.ctx.cf.deployments('example-tick'), versions: await fx.ctx.cf.versions('example-tick') }) };
  assert.equal(entry.live.sha, NEW);
  const res = await deployOne({ ...fx.ctx, entry });
  assert.equal(res.outcome, 'failed');
  assert.match(res.detail, /wrangler deploy exited 1; live is bbbbbbb/);
  assert.equal(await readHold(fx.stateRoot, 't/r', 'tick'), null);
});

test('direct: wrangler exiting 0 without a deploy record while our code is live continues to the live probes', async () => {
  const { cloud, ctx, lines, stateRoot } = await fixture({ dep: TICK, wrangler: { deploy: { noRecord: true } } });
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'deployed', `${res.detail}\n${lines.join('\n')}`);
  assert.equal(res.versionId, cloud.live('example-tick'));
  assert.match(lines.join('\n'), /! tick: wrangler wrote no deploy record, but version [0-9a-f]{8} with our commit is live — verifying it/);
  assert.match(lines.join('\n'), /✓ tick: live probes/);
  assert.equal(await readHold(stateRoot, 't/r', 'tick'), null);
});

test('direct: wrangler exiting 0 without a deploy record and nothing of ours live is a failure', async () => {
  const { ctx } = await fixture({ dep: TICK, wrangler: { deploy: { create: false } } });
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'failed');
  assert.match(res.detail, /wrangler deploy exited 0 without a deploy record; live is aaaaaaa/);
});

test('the build gets the deployable env and no credentials', async () => {
  const check = 'test "$STAGE" = prod && test -z "$CLOUDFLARE_API_TOKEN" && test -z "$CLOUDFLARE_ACCOUNT_ID"';
  const { ctx, lines } = await fixture({ patch: { env: { STAGE: 'prod' }, build: `${check} && ${BUILD}` } });
  assert.equal((await deployOne(ctx)).outcome, 'deployed', lines.join('\n'));
});

test('a failing build, a missing or empty bundle, a failing preDeploy and a missing wrangler stop before wrangler', async () => {
  const cases = [
    [{ patch: { build: 'exit 3' } }, /build failed: exit 3/],
    [{ patch: { build: `${BUILD}; rm out/handler.mjs` } }, /bundle check: out\/handler.mjs is missing/],
    [{ patch: { build: BUILD.replace('good.db.example', 'nothing here') } }, /bundle check: nothing in out\/handler.mjs matches/],
    [{ patch: { preDeploy: ['exit 4'] } }, /preDeploy failed: exit 4/],
  ];
  for (const [opts, re] of cases) {
    const { cloud, wt } = await failsWith(opts, re);
    assert.deepEqual(await cloud.wranglerCalls(), []);
    assert.equal(await exists(join(wt, 'app', '.env.local')), false);
  }
  const { ctx, wt } = await fixture();
  await rm(join(wt, 'tools', 'wrangler'));
  const res = await deployOne(ctx);
  assert.equal(res.outcome, 'failed');
  assert.match(res.detail, /wrangler missing at tools\/wrangler/);
});

test('a bundle with a foreign match fails; env files are removed anyway', async () => {
  const { wt } = await failsWith({ patch: { build: BUILD.replace('good', 'evil') } }, /bundle check: https:\/\/evil.db.example/);
  assert.equal(await exists(join(wt, 'app', '.env.local')), false);
});

test('env files are copied after install and before build, and removed when install fails', async () => {
  // install fails if the file is already there; build needs it (BUILD starts with test -f .env.local)
  const { ctx, lines, wt } = await fixture({ patch: { install: 'test ! -e .env.local && echo clean > .install-saw-no-env' } });
  assert.equal((await deployOne(ctx)).outcome, 'deployed', lines.join('\n'));
  assert.equal(await readFile(join(wt, 'app', '.install-saw-no-env'), 'utf8'), 'clean\n');
  assert.equal(await exists(join(wt, 'app', '.env.local')), false);
  const broken = await failsWith({ patch: { install: 'exit 5' } }, /build failed: exit 5/);
  assert.equal(await exists(join(broken.wt, 'app', '.env.local')), false);
  assert.equal(await exists(join(broken.wt, 'app', '.next')), false);
  assert.deepEqual(await broken.cloud.wranglerCalls(), []);
});

test('dry run builds and stops before wrangler', async () => {
  const { cloud, ctx } = await fixture();
  const res = await deployOne({ ...ctx, dryRun: true });
  assert.equal(res.outcome, 'dry-run');
  assert.deepEqual(await cloud.wranglerCalls(), []);
});

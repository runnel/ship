import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, loadConfigSource, ConfigError } from '../lib/config.mjs';

const base = { repo: 'acme/app', checks: [{ name: 'unit', paths: ['src/**'], steps: ['npm test'] }] };

test('fills defaults and normalises steps', () => {
  const c = validateConfig(base);
  assert.equal(c.mainBranch, 'main');
  assert.deepEqual(c.docsOnly, []);
  assert.deepEqual(c.deployables, []);
  assert.equal(c.checks[0].lane, 'light');
  assert.equal(c.checks[0].cwd, '.');
  assert.equal(c.checks[0].install, null);
  assert.equal(c.checks[0].onDeploy, false);
  assert.equal(c.checks[0].timeoutMin, 30);
  assert.deepEqual(c.checks[0].steps, [{ run: 'npm test', env: {} }]);
});

test('steps may be { run, env } objects; timeoutMin is configurable', () => {
  const c = validateConfig({ ...base, checks: [{ name: 'b', paths: ['x/**'], steps: ['a', { run: 'b', env: { K: 'v' } }], timeoutMin: 5 }] });
  assert.deepEqual(c.checks[0].steps, [{ run: 'a', env: {} }, { run: 'b', env: { K: 'v' } }]);
  assert.equal(c.checks[0].timeoutMin, 5);
  assert.throws(() => validateConfig({ ...base, checks: [{ name: 'b', paths: ['x/**'], steps: [{ env: {} }] }] }), /steps/);
  assert.throws(() => validateConfig({ ...base, checks: [{ ...base.checks[0], timeoutMin: 0 }] }), /timeoutMin/);
});

test('rejects unknown keys, bad repo, bad checks', () => {
  assert.throws(() => validateConfig({ ...base, extra: 1 }), ConfigError);
  assert.throws(() => validateConfig({ ...base, repo: 'nope' }), /owner\/name/);
  assert.throws(() => validateConfig({ ...base, checks: [] }), /non-empty/);
  assert.throws(() => validateConfig({ ...base, checks: [{ ...base.checks[0], foo: 1 }] }), /unknown key foo/);
  assert.throws(() => validateConfig({ ...base, checks: [base.checks[0], base.checks[0]] }), /duplicate/);
  assert.throws(() => validateConfig({ ...base, checks: [{ ...base.checks[0], lane: 'fast' }] }), /lane/);
  assert.throws(() => validateConfig({ ...base, checks: [{ ...base.checks[0], steps: [] }] }), /steps/);
  assert.throws(() => validateConfig({ ...base, checks: [{ ...base.checks[0], paths: [] }] }), /paths/);
  assert.throws(() => validateConfig({ ...base, deployables: 'x' }), /deployables/);
});

test('loads an object export', async () => {
  const c = await loadConfigSource(`export default ${JSON.stringify(base)};`, { root: '/x' });
  assert.equal(c.repo, 'acme/app');
});

test('loads a function export and passes root', async () => {
  const src = `export default ({ root }) => ({ repo: 'acme/app', checks: [{ name: 'u', paths: [root + '/**'], steps: ['true'] }] });`;
  const c = await loadConfigSource(src, { root: 'r' });
  assert.deepEqual(c.checks[0].paths, ['r/**']);
});

test('a syntax error surfaces as an error', async () => {
  await assert.rejects(() => loadConfigSource('export default {', { root: '.' }));
});

const creds = { file: '/secure/creds.env', map: { CLOUDFLARE_API_TOKEN: 'CF_TOKEN', CLOUDFLARE_ACCOUNT_ID: 'CF_ACCOUNT' } };
const app = { name: 'app', worker: 'example-app', cwd: 'app', paths: ['app/**'], mode: 'versioned', build: 'npm run build',
  probes: [{ path: '/health', status: 200 }], liveHost: 'https://app.example.com', liveMarker: { path: '/', file: '.next/BUILD_ID' } };
const tick = { name: 'tick', worker: 'example-tick', cwd: 'workers/tick', paths: ['workers/tick/**'], mode: 'direct',
  wrangler: 'app/node_modules/.bin/wrangler', probes: [{ path: '/', status: 403 }], liveHost: 'https://example-tick.example.workers.dev', after: ['app'] };
const withDeploy = (extra = {}) => ({ ...base, deploySetup: [{ run: 'npm ci', cwd: 'app' }], deployables: [app, tick], credentials: creds, ...extra });

test('deployables are normalised with defaults', () => {
  const c = validateConfig(withDeploy());
  assert.deepEqual(c.deploySetup, [{ run: 'npm ci', env: {}, cwd: 'app' }]);
  const [a, t] = c.deployables;
  assert.equal(a.adapter, 'workers');
  assert.equal(a.wrangler, 'app/node_modules/.bin/wrangler');
  assert.deepEqual(a.probes, [{ path: '/health', status: 200, method: 'GET', followRedirects: false }]);
  assert.equal(a.timeoutMin, 30);
  assert.equal(a.uploadTimeoutMin, 10);
  assert.deepEqual(a.envFiles, []);
  assert.equal(t.wrangler, 'app/node_modules/.bin/wrangler');
  assert.deepEqual(t.after, ['app']);
  assert.equal(t.liveMarker, null);
  assert.deepEqual(t.ignore, []);
  assert.deepEqual(c.requires, []);
  assert.equal(c.migrations, null);
});

test('deployable validation failures', () => {
  const bad = (patch, re) => assert.throws(() => validateConfig(withDeploy({ deployables: [{ ...app, ...patch }] })), re);
  bad({ extra: 1 }, /deployable app: unknown key extra/);
  bad({ name: 'App' }, /deployable name/);
  bad({ mode: 'blue-green' }, /mode must be/);
  bad({ probes: [] }, /versioned deployable needs probes/);
  bad({ liveHost: 'http://app.example.com' }, /liveHost/);
  bad({ liveHost: 'https://app.example.com/' }, /liveHost/);
  bad({ cwd: '../elsewhere' }, /cwd/);
  bad({ probes: [{ path: 'health', status: 200 }] }, /probe path/);
  bad({ probes: [{ path: '/h', status: 99 }] }, /probe status/);
  bad({ bundleCheck: { file: 'x', pattern: '(', allow: [] } }, /bundleCheck/);
  bad({ envFiles: [{ from: 'relative/.env', to: 'app/.env' }] }, /envFiles/);
  bad({ mode: 'direct', liveMarker: { path: '/', file: 'x' } }, /liveMarker/);
  bad({ ignore: 'app/docs/**' }, /ignore must be/);
  assert.throws(() => validateConfig(withDeploy({ deployables: [app, { ...app }] })), /duplicate deployable/);
  assert.throws(() => validateConfig(withDeploy({ deployables: [{ ...tick, after: ['nope'] }] })), /after: unknown deployable nope/);
  assert.throws(() => validateConfig(withDeploy({ credentials: null })), /credentials/);
  assert.throws(() => validateConfig(withDeploy({ credentials: { file: '/x', map: { CLOUDFLARE_API_TOKEN: 'T' } } })), /CLOUDFLARE_ACCOUNT_ID/);
});

test('migrations, requires, deploySetup shapes', () => {
  const c = validateConfig(withDeploy({ migrations: { paths: ['db/*.sql'] }, requires: [{ repo: 'acme/api', deployable: 'app' }] }));
  assert.deepEqual(c.migrations, { paths: ['db/*.sql'] });
  assert.deepEqual(c.requires, [{ repo: 'acme/api', deployable: 'app' }]);
  assert.throws(() => validateConfig(withDeploy({ migrations: { paths: [] } })), /migrations/);
  assert.throws(() => validateConfig(withDeploy({ requires: [{ repo: 'nope' }] })), /requires/);
  assert.throws(() => validateConfig(withDeploy({ deploySetup: [{ run: 'x', cwd: '../up' }] })), /deploySetup/);
});

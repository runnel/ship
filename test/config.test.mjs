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

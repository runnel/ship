import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_KEYS, changedSettings, expectedState, nonVersionedSettings } from '../lib/wrangler-config.mjs';

test('jsonc: comments and trailing commas are fine; only non-versioned keys count', () => {
  const a = `{ // app\n "name": "example-app", "vars": { "A": "1" }, "triggers": { "crons": ["0 * * * *"] }, }`;
  const b = `{ "name": "example-app", "vars": { "A": "2" }, /* x */ "triggers": { "crons": ["0 * * * *"] } }`;
  assert.deepEqual(changedSettings(a, b, 'wrangler.jsonc'), []);
  const c = `{ "name": "example-app", "triggers": { "crons": ["5 * * * *"] }, "preview_urls": true, "observability": { "enabled": true } }`;
  assert.deepEqual(changedSettings(a, c, 'wrangler.jsonc'), ['triggers', 'preview_urls', 'observability']);
  assert.deepEqual(changedSettings(a, c, 'wrangler.jsonc', CONFIG_KEYS), ['observability']);
});

test('toml: sections and top-level keys', () => {
  const a = `name = "example-tick"\nmain = "src/index.ts"\n\n[triggers]\ncrons = ["*/5 * * * *"]  # every 5 min\n\n[vars]\nA = "1"\n`;
  const b = `name = "example-tick"\nmain = "src/index.ts"\n\n[vars]\nA = "2"\n\n[triggers]\ncrons = ["*/5 * * * *"]\n`;
  assert.deepEqual(changedSettings(a, b, 'wrangler.toml'), []);
  const c = `${a}\n[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["Box"]\n`;
  assert.deepEqual(changedSettings(a, c, 'wrangler.toml'), ['migrations']);
  const d = `workers_dev = false\nroutes = [\n  { pattern = "api.example.com/*", zone_name = "example.com" }\n]\n${a}`;
  assert.deepEqual(changedSettings(a, d, 'wrangler.toml').sort(), ['routes', 'workers_dev']);
});

test('toml: a dotted table header belongs to its first segment', () => {
  const a = `name = "example-tick"\n\n[observability.logs]\nenabled = true\ninvocation_logs = true\n\n[vars.nested]\nA = "1"\n`;
  const b = a.replace('invocation_logs = true', 'invocation_logs = false');
  assert.deepEqual(changedSettings(a, b, 'wrangler.toml'), ['observability']);
  assert.deepEqual(changedSettings(a, `name = "example-tick"\n`, 'wrangler.toml'), ['observability']);
  const c = `${a}\n[[tail_consumers.extra]]\nservice = "example-consumer"\n`;
  assert.deepEqual(changedSettings(a, c, 'wrangler.toml'), ['tail_consumers']);
  assert.deepEqual(changedSettings(a, a.replace('"1"', '"2"'), 'wrangler.toml'), []);
});

test('a missing file on one side counts as all settings absent', () => {
  assert.deepEqual(changedSettings(null, `{ "name": "x" }`, 'wrangler.json'), []);
  assert.deepEqual(changedSettings(null, `{ "name": "x", "workers_dev": false }`, 'wrangler.json'), ['workers_dev']);
  assert.equal(nonVersionedSettings(null, 'wrangler.toml').triggers, '');
});

test('expectedState: explicit values, and wrangler defaults', () => {
  assert.deepEqual(expectedState(`{ "name": "x" }`, 'wrangler.jsonc'), { workersDev: true, previewUrls: true, crons: null });
  assert.deepEqual(expectedState(`{ "name": "x", "preview_urls": true }`, 'wrangler.jsonc'), { workersDev: true, previewUrls: true, crons: null });
  assert.deepEqual(expectedState(`{ "name": "x", "routes": [{ "pattern": "a.example.com", "custom_domain": true }] }`, 'wrangler.json'), { workersDev: false, previewUrls: false, crons: null });
  assert.deepEqual(expectedState(`name = "t"\nworkers_dev = true\n[triggers]\ncrons = [\n  "*/5 * * * *",\n  "0 1 * * *"\n]\n`, 'wrangler.toml'), { workersDev: true, previewUrls: true, crons: ['*/5 * * * *', '0 1 * * *'] });
});

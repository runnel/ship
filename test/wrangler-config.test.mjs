import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_KEYS, WRANGLER_FILES, changedSettings, expectedState, nonVersionedSettings, workerName } from '../lib/wrangler-config.mjs';

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

test('toml: dotted and quoted top-level keys count as their first segment', () => {
  const cron = (spec) => `name = "example-tick"\ntriggers.crons = ["${spec}"]\n`;
  assert.deepEqual(changedSettings(cron('*/5 * * * *'), cron('*/10 * * * *'), 'wrangler.toml'), ['triggers']);
  assert.deepEqual(changedSettings(cron('*/5 * * * *'), cron('*/5 * * * *'), 'wrangler.toml'), []);
  const obs = (on) => `name = "example-tick"\nobservability.enabled = ${on}\n`;
  assert.deepEqual(changedSettings(obs(true), obs(false), 'wrangler.toml'), ['observability']);
  const dev = (on) => `name = "example-tick"\n"workers_dev" = ${on}\n`;
  assert.deepEqual(changedSettings(dev(true), dev(false), 'wrangler.toml'), ['workers_dev']);
  const spaced = (on) => `name = "example-tick"\nobservability . enabled = ${on}\n`;
  assert.deepEqual(changedSettings(spaced(true), spaced(false), 'wrangler.toml'), ['observability']);
  const vars = (v) => `name = "example-tick"\nvars.triggers = "${v}"\n`;
  assert.deepEqual(changedSettings(vars('a'), vars('b'), 'wrangler.toml'), []);
});

test('toml: quoted and spaced table headers are read, and never leak into the previous table', () => {
  const doc = (header, on) => `[triggers]\ncrons = ["*/5 * * * *"]\n\n${header}\nenabled = ${on}\n`;
  for (const header of ['["observability"]', '[observability . logs]', '[ "observability" . "logs" ]', "['observability'.logs]"]) {
    assert.deepEqual(changedSettings(doc(header, true), doc(header, false), 'wrangler.toml'), ['observability'], header);
  }
  assert.deepEqual(changedSettings(doc('[[ tail_consumers ]]', true), doc('[[ tail_consumers ]]', false), 'wrangler.toml'), ['tail_consumers']);
  assert.deepEqual(changedSettings(doc('[vars]', true), doc('[vars]', false), 'wrangler.toml'), []);
});

test('toml: a line that opens with [ but is not a table header is an error', () => {
  assert.throws(() => nonVersionedSettings(`name = "x"\n[observability\nenabled = true\n`, 'wrangler.toml'), /unparseable TOML table header: \[observability/);
  assert.throws(() => nonVersionedSettings(`[[migrations]\ntag = "v1"\n`, 'wrangler.toml'), /unparseable/);
});

test('toml: multi-line values do not disturb table tracking', () => {
  const text = `[vars]\nA = "[not a bracket"\nMATRIX = [\n  ["a", "b"],\n  ["c"]\n]\n\n[observability]\nenabled = true\n`;
  assert.deepEqual(nonVersionedSettings(text, 'wrangler.toml').observability, '[observability]\nenabled = true\n');
  assert.equal(nonVersionedSettings(text, 'wrangler.toml').triggers, '');
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

test('expectedState: dotted and quoted top-level keys in toml', () => {
  const text = `name = "t"\ntriggers.crons = [\n  "*/5 * * * *",\n  "0 1 * * *"\n]\n"workers_dev" = false\npreview_urls = true\n`;
  assert.deepEqual(expectedState(text, 'wrangler.toml'), { workersDev: false, previewUrls: true, crons: ['*/5 * * * *', '0 1 * * *'] });
  assert.deepEqual(expectedState(`name = "t"\ntriggers . "crons" = ["0 1 * * *"]\n`, 'wrangler.toml'), { workersDev: true, previewUrls: true, crons: ['0 1 * * *'] });
});

test("WRANGLER_FILES follows wrangler's own lookup order", () => {
  assert.deepEqual(WRANGLER_FILES, ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']);
});

test('workerName: the top-level name of a json, jsonc or toml config; null when there is none', () => {
  assert.equal(workerName(`{ "name": "example-app" }`, 'wrangler.json'), 'example-app');
  assert.equal(workerName(`{ // the Worker\n "vars": { "name": "not-this" }, "name": "example-app", }`, 'wrangler.jsonc'), 'example-app');
  assert.equal(workerName(`{ "vars": { "name": "not-this" } }`, 'wrangler.json'), null);
  assert.equal(workerName(`{ "name": 7 }`, 'wrangler.json'), null);
  assert.equal(workerName(`main = "src/index.ts"\nname = "example-tick" # the Worker\n[vars]\nname = "not-this"\n`, 'wrangler.toml'), 'example-tick');
  assert.equal(workerName(`name = 'example-tick'\n`, 'wrangler.toml'), 'example-tick');
  assert.equal(workerName(`"name" = "example-tick"\n`, 'wrangler.toml'), 'example-tick');
  assert.equal(workerName(`[vars]\nname = "not-this"\n[[d1_databases]]\nname = "not-this-either"\n`, 'wrangler.toml'), null);
  assert.equal(workerName(`routes = [\n  "name = \\"not-this\\""\n]\nname = "example-tick"\n`, 'wrangler.toml'), 'example-tick');
  assert.equal(workerName(`compatibility_date = "2026-01-01"\n`, 'wrangler.toml'), null);
});

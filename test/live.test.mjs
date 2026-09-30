import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeSha, madeBySecretPut, newestVersion, parseSha, previousCode, resolveLive, secretChangesBetween } from '../lib/live.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const at = (s) => `2026-01-01T00:00:${String(s).padStart(2, '0')}Z`;
const ann = (message, triggered) => ({ ...(message ? { 'workers/message': message } : {}), 'workers/triggered_by': triggered });
const dep = (s, versionId, message, triggered = 'deployment', percentage = 100) =>
  ({ id: `d${s}`, created_on: at(s), versions: [{ version_id: versionId, percentage }], annotations: ann(message, triggered) });
const ver = (number, message, triggered = 'version_upload') => ({ id: `v${number}`, number, metadata: { created_on: at(number) }, annotations: ann(message, triggered) });

test('parseSha reads the leading sha only, and tolerates a truncated tail', () => {
  assert.equal(parseSha(`sha:${A} app run:abc123`), A);
  assert.equal(parseSha(`sha:${A} mi...`), A);
  assert.equal(parseSha(`sha:${A}0 too long`), null);
  assert.equal(parseSha(`deploy sha:${A}`), null);
  assert.equal(parseSha(undefined), null);
});

test('no deployment: none; a split: unknown', () => {
  assert.deepEqual(resolveLive({ deployments: [], versions: [] }), { state: 'none' });
  const split = { ...dep(1, 'v1', `sha:${A}`), versions: [{ version_id: 'v1', percentage: 50 }, { version_id: 'v2', percentage: 50 }] };
  assert.equal(resolveLive({ deployments: [split], versions: [] }).state, 'unknown');
});

test("the newest deployment's own sha wins, whatever order the API used", () => {
  const deployments = [dep(1, 'v1', `sha:${A} app`), dep(3, 'v2', `sha:${B} app`), dep(2, 'v1', 'manual')];
  assert.deepEqual(resolveLive({ deployments, versions: [ver(1), ver(2)] }), { state: 'known', sha: B, versionId: 'v2' });
});

test('a secret change on top of an adopted version resolves through the adopt', () => {
  const versions = [ver(1, 'main-1234567 free text'), ver(2, null, 'secret')];
  const deployments = [dep(1, 'v1', `sha:${A} adopt`), dep(2, 'v2', null, 'secret')];
  assert.deepEqual(resolveLive({ deployments, versions }), { state: 'known', sha: A, versionId: 'v2' });
});

test('chained secret changes on a ship upload resolve to its message', () => {
  const versions = [ver(5, `sha:${C} app run:x`), ver(6, null, 'secret'), ver(7, null, 'secret')];
  const deployments = [dep(1, 'v5', `sha:${C} app run:x`), dep(2, 'v6', null, 'secret'), dep(3, 'v7', null, 'secret')];
  assert.equal(resolveLive({ deployments, versions }).sha, C);
});

test('an unannotated or versions-secret-put version is unknown', () => {
  const outside = resolveLive({ deployments: [dep(1, 'v1', null)], versions: [ver(1, 'hand deploy')] });
  assert.equal(outside.state, 'unknown');
  assert.match(outside.reason, /made outside ship/);
  const vsp = resolveLive({ deployments: [dep(1, 'v1', `sha:${A}`), dep(2, 'v2', null)], versions: [ver(1, `sha:${A}`), ver(2, 'Updated secret "K"')] });
  assert.equal(vsp.state, 'unknown');
  const beyond = resolveLive({ deployments: [dep(2, 'v9', null, 'secret')], versions: [ver(9, null, 'secret')] });
  assert.match(beyond.reason, /older than the history ship reads/);
});

test('codeSha prefers a deployment stamp of the same version over the version message', () => {
  const versions = [ver(1, `sha:${A} app`)];
  assert.equal(codeSha('v1', { deployments: [dep(1, 'v1', `sha:${B} adopt`)], versions }).sha, B);
});

test('newestVersion, previousCode and secretChangesBetween', () => {
  const versions = [ver(1, `sha:${A}`), ver(2, `sha:${B}`), ver(3, null, 'secret'), ver(4, `sha:${C}`)];
  const deployments = [dep(1, 'v1', `sha:${A}`), dep(2, 'v2', `sha:${B}`), dep(3, 'v3', null, 'secret'), dep(4, 'v4', `sha:${C}`)];
  assert.equal(newestVersion(versions).id, 'v4');
  const live = resolveLive({ deployments, versions });
  assert.deepEqual(previousCode({ deployments, versions }, live), { versionId: 'v3', sha: B, created_on: at(3), deployed: true });
  assert.deepEqual(secretChangesBetween(versions, 'v4', 'v2').map((v) => v.id), ['v3']);
  assert.deepEqual(secretChangesBetween(versions, 'v4', 'v3').map((v) => v.id), []);
});

test('previousCode falls back to older versions outside the deployment history, marked as never deployed', () => {
  const versions = [ver(1, `sha:${A}`), ver(2, `sha:${B}`), ver(3, null, 'secret'), ver(4, `sha:${C}`)];
  const deployments = [dep(4, 'v4', `sha:${C}`)];
  const live = resolveLive({ deployments, versions });
  assert.deepEqual(previousCode({ deployments, versions }, live), { versionId: 'v2', sha: B, created_on: at(2), deployed: false });
});

test('the fallback of previousCode ignores newer versions, versions with the live code, and versions of unknown code', () => {
  const newer = [ver(1, `sha:${A}`), ver(2, `sha:${B}`), ver(3, `sha:${C}`)];
  const live = resolveLive({ deployments: [dep(2, 'v2', `sha:${B}`)], versions: newer });
  assert.deepEqual(previousCode({ deployments: [dep(2, 'v2', `sha:${B}`)], versions: newer }, live), { versionId: 'v1', sha: A, created_on: at(1), deployed: false });
  const same = [ver(1, `sha:${B}`), ver(2, `sha:${B}`)];
  assert.equal(previousCode({ deployments: [dep(2, 'v2', `sha:${B}`)], versions: same }, { state: 'known', sha: B, versionId: 'v2' }), null);
  const unknown = [ver(1, 'made by hand'), ver(2, `sha:${B}`)];
  assert.equal(previousCode({ deployments: [dep(2, 'v2', `sha:${B}`)], versions: unknown }, { state: 'known', sha: B, versionId: 'v2' }), null);
});

test('secret changes cannot be counted when either version is outside the history that was read', () => {
  const versions = [ver(3, `sha:${A}`), ver(4, null, 'secret')];
  assert.equal(secretChangesBetween(versions, 'v4', 'v1'), null);
  assert.equal(secretChangesBetween(versions, 'v1', 'v3'), null);
  assert.deepEqual(secretChangesBetween(versions, 'v4', 'v3').map((v) => v.id), ['v4']);
});

test('a version made by wrangler versions secret put is recognised by its message', () => {
  assert.equal(madeBySecretPut(ver(2, 'Updated secret "K"')), true);
  assert.equal(madeBySecretPut(ver(2, `sha:${A} app`)), false);
  assert.equal(madeBySecretPut(ver(2, null, 'secret')), false);
  assert.equal(madeBySecretPut({}), false);
});

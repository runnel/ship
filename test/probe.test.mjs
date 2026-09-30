import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeProbes, probeAll, probeOnce, waitForText } from '../lib/probe.mjs';

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
};
const scripted = (answers) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, redirect: init.redirect, method: init.method });
    const next = answers[url].length > 1 ? answers[url].shift() : answers[url][0];
    if (next instanceof Error) throw next;
    return new Response(typeof next === 'object' ? next.body : null, { status: typeof next === 'object' ? next.status : next });
  };
  return { fetchImpl, seen };
};

test('a probe is retried until it answers as expected', async () => {
  const { fetchImpl } = scripted({ 'https://a.example.com/login': [500, 500, 200], 'https://a.example.com/health': [403] });
  const r = await probeAll('https://a.example.com', [{ path: '/login', status: 200 }, { path: '/health', status: 403 }], { fetchImpl, windowMs: 60_000, intervalMs: 3000, ...clock() });
  assert.equal(r.ok, true);
});

test('the window ends a failing probe; the description names it', async () => {
  const { fetchImpl } = scripted({ 'https://a.example.com/x': [500] });
  const r = await probeAll('https://a.example.com', [{ path: '/x', status: 200 }], { fetchImpl, windowMs: 9000, intervalMs: 3000, ...clock() });
  assert.equal(r.ok, false);
  assert.equal(describeProbes(r.results), 'GET /x want 200 got 500');
});

test('redirects are not followed by default; network errors are reported, not thrown', async () => {
  const { fetchImpl, seen } = scripted({ 'https://a.example.com/': [307], 'https://a.example.com/e': [new TypeError('fetch failed')] });
  assert.equal(await probeOnce('https://a.example.com', { path: '/' }, { fetchImpl }), 307);
  assert.equal(seen[0].redirect, 'manual');
  assert.equal(await probeOnce('https://a.example.com', { path: '/e' }, { fetchImpl }), 'error: fetch failed');
});

test('waitForText', async () => {
  const { fetchImpl } = scripted({ 'https://a.example.com/login': [{ status: 200, body: 'old' }, { status: 200, body: '<!--BUILD42-->' }] });
  assert.equal(await waitForText('https://a.example.com', '/login', 'BUILD42', { fetchImpl, windowMs: 60_000, intervalMs: 3000, ...clock() }), true);
  const never = scripted({ 'https://a.example.com/login': [{ status: 200, body: 'old' }] });
  assert.equal(await waitForText('https://a.example.com', '/login', 'BUILD42', { fetchImpl: never.fetchImpl, windowMs: 6000, intervalMs: 3000, ...clock() }), false);
});

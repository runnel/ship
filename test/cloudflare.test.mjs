import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cloudflare, parseEnvFile, readCredentials, CloudflareError } from '../lib/cloudflare.mjs';
import { tempDir } from './helpers.mjs';

const ACCOUNT = 'acc0unt';
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) });
    const path = url.replace(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/`, '');
    const hit = routes[`${init.method} ${path}`];
    const body = hit ?? { success: false, errors: [{ code: 10007, message: 'This Worker does not exist' }] };
    return new Response(JSON.stringify(body), { status: hit ? 200 : 404 });
  };
  return { fetchImpl, calls };
}

test('parseEnvFile keeps values literally, strips matching quotes, ignores other lines', () => {
  const env = parseEnvFile(`# c\nA=1\nexport B="two words"\nC='x$9y'\nD = spaced \nnot a line\n`);
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x$9y', D: 'spaced' });
});

test('readCredentials maps file keys to env names and names a missing key only', async () => {
  const dir = await tempDir('creds-');
  const file = join(dir, '.env');
  await writeFile(file, 'CF_TOKEN=tok-secret\nCF_ACCOUNT=acc\nOTHER=zzz\n');
  assert.deepEqual(await readCredentials({ file, map: { CLOUDFLARE_API_TOKEN: 'CF_TOKEN', CLOUDFLARE_ACCOUNT_ID: 'CF_ACCOUNT' } }),
    { CLOUDFLARE_API_TOKEN: 'tok-secret', CLOUDFLARE_ACCOUNT_ID: 'acc' });
  await assert.rejects(readCredentials({ file, map: { X: 'MISSING' } }), (e) => /MISSING is missing/.test(e.message) && !/tok-secret/.test(e.message));
});

test('deployments: newest first; a missing Worker has none', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'GET workers/scripts/example-app/deployments?per_page=50': { success: true, result: { deployments: [
      { id: 'd1', created_on: '2026-01-01T00:00:01Z', versions: [] }, { id: 'd2', created_on: '2026-01-01T00:00:02Z', versions: [] }] } },
  });
  const cf = cloudflare({ token: 'tok', accountId: ACCOUNT, fetchImpl });
  assert.deepEqual((await cf.deployments('example-app')).map((d) => d.id), ['d2', 'd1']);
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.deepEqual(await cf.deployments('no-such-worker'), []);
});

test('versions: two pages at most, newest first', async () => {
  const page = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `v${from - i}`, number: from - i, annotations: {} }));
  const { fetchImpl, calls } = fakeFetch({
    'GET workers/scripts/w/versions?per_page=100&page=1': { success: true, result: { items: page(150, 100) } },
    'GET workers/scripts/w/versions?per_page=100&page=2': { success: true, result: { items: page(50, 50) } },
  });
  const v = await cloudflare({ token: 't', accountId: ACCOUNT, fetchImpl }).versions('w');
  assert.equal(v.length, 150);
  assert.equal(v[0].number, 150);
  assert.equal(calls.length, 2);
});

test('createDeployment sends what wrangler versions deploy sends; errors hide the account', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'POST workers/scripts/w/deployments': { success: true, result: { id: 'new' } },
    'POST workers/scripts/w/deployments?force=true': { success: true, result: { id: 'forced' } },
    'GET workers/scripts/w/schedules': { success: true, result: { schedules: [{ cron: '0 * * * *' }] } } });
  const cf = cloudflare({ token: 't', accountId: ACCOUNT, fetchImpl });
  assert.equal((await cf.createDeployment('w', 'ver-1', 'sha:abc rollback')).id, 'new');
  assert.ok(calls[0].url.endsWith('/workers/scripts/w/deployments'));
  assert.deepEqual(calls[0].body, { strategy: 'percentage', versions: [{ version_id: 'ver-1', percentage: 100 }], annotations: { 'workers/message': 'sha:abc rollback' } });
  assert.equal((await cf.createDeployment('w', 'ver-1', 'm', { force: true })).id, 'forced');
  assert.deepEqual(await cf.schedules('w'), ['0 * * * *']);
  await assert.rejects(cf.subdomain('gone'), (e) => e instanceof CloudflareError && e.codes.includes(10007) && !e.message.includes(ACCOUNT));
});

// A fetch that answers every request with one canned Response (a fresh one each time).
const answering = (make) => ({ token: 'tok-abcdefgh', accountId: ACCOUNT, fetchImpl: async () => make() });
const isPlain = (e) => e instanceof Error && !(e instanceof CloudflareError);

test('only an API refusal is a CloudflareError; an unknown outcome is a plain error', async () => {
  const envelope = (status, body) => () => new Response(JSON.stringify(body), { status });
  const refused = await cloudflare(answering(envelope(400, { success: false, errors: [{ code: 10021, message: 'nope' }] })))
    .createDeployment('w', 'v', 'm').catch((e) => e);
  assert.ok(refused instanceof CloudflareError);
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.codes, [10021]);

  const boom = await cloudflare(answering(envelope(500, { success: false, errors: [{ code: 10000, message: 'boom' }] })))
    .createDeployment('w', 'v', 'm').catch((e) => e);
  assert.ok(isPlain(boom));
  assert.equal(boom.status, 500);
  assert.match(boom.message, /HTTP 500.*boom/);

  const html = await cloudflare(answering(() => new Response('<html>Gateway Time-out</html>', { status: 504 })))
    .createDeployment('w', 'v', 'm').catch((e) => e);
  assert.ok(isPlain(html));
  assert.equal(html.status, 504);
  assert.match(html.message, /POST workers\/scripts\/w\/deployments: HTTP 504$/);

  const unwrapped = await cloudflare(answering(() => new Response('{}', { status: 200 }))).deployments('w').catch((e) => e);
  assert.ok(isPlain(unwrapped));
});

test('a body that fails while it is read keeps its native error', async () => {
  const dropped = new Error('socket hang up');
  const cf = cloudflare(answering(() => new Response(new ReadableStream({ start: (c) => c.error(dropped) }), { status: 200 })));
  await assert.rejects(cf.createDeployment('w', 'v', 'm'), (e) => e === dropped);
});

test('a missing Worker is only a missing Worker when Cloudflare says so with a refusal', async () => {
  const cf = cloudflare(answering(() => new Response('<html>Not Found</html>', { status: 404 })));
  await assert.rejects(cf.deployments('w'), isPlain);
  const gone = cloudflare(answering(() => new Response(JSON.stringify({ success: false, errors: [{ code: 10007, message: 'gone' }] }), { status: 404 })));
  assert.deepEqual(await gone.deployments('w'), []);
});

test('errors never carry the account id or the token, whichever kind they are', async () => {
  const token = 'tok-abcdefgh';
  const text = `Could not route to /client/v4/accounts/${ACCOUNT}/workers/scripts/w (token ${token})`;
  for (const status of [400, 502]) {
    const cf = cloudflare(answering(() => new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: text }] }), { status })));
    const e = await cf.subdomain('w').catch((err) => err);
    assert.equal(e instanceof CloudflareError, status < 500);
    assert.ok(!e.message.includes(ACCOUNT) && !e.message.includes(token), e.message);
    assert.match(e.message, /Could not route to \/client\/v4\/accounts\/<account>\/workers\/scripts\/w \(token <token>\)/);
  }
});

test('a token that cannot be a header value is refused without echoing it', () => {
  for (const token of ['', 'has space', 'bad\ntoken-value', 'tök-en-value', undefined]) {
    assert.throws(() => cloudflare({ token, accountId: ACCOUNT, fetchImpl: async () => {} }),
      (e) => /token/.test(e.message) && !e.message.includes('bad') && !e.message.includes('space') && !e.message.includes('value'));
  }
});

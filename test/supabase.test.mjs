import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutcomeUnknown, supabase } from '../lib/supabase.mjs';

const TOKEN = 'sbp_test_token_0123456789';
const PROJECT = 'abcdefghijklmnopqrst';
const answer = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const client = (fetchImpl) => supabase({ project: PROJECT, token: TOKEN, fetchImpl });

test('a request names the project, carries the token and a User-Agent, and posts the SQL as JSON', async () => {
  let seen;
  const db = client(async (url, init) => { seen = { url, init }; return new Response('[{"one":1}]', { status: 201 }); });
  assert.deepEqual(await db.query('select 1 as one'), { status: 201, body: [{ one: 1 }] });
  assert.equal(seen.url, `https://api.supabase.com/v1/projects/${PROJECT}/database/query`);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.match(seen.init.headers['User-Agent'], /^ship-local-ci\//);
  assert.deepEqual(JSON.parse(seen.init.body), { query: 'select 1 as one' });
});

test('a refusal is an answer, whatever the status; the token is removed from its message', async () => {
  const refusal = await client(answer(400, { message: `Failed to run sql query: ERROR:  42P01: no such table (${TOKEN})` })).query('x');
  assert.equal(refusal.status, 400);
  assert.equal(refusal.body.message, 'Failed to run sql query: ERROR:  42P01: no such table (<token>)');
  assert.deepEqual(await client(answer(401, { message: 'Unauthorized' })).query('x'), { status: 401, body: { message: 'Unauthorized' } });
  assert.deepEqual(await client(answer(403, 'error code: 1010')).query('x'), { status: 403, body: { message: 'error code: 1010' } });
});

test('Postgres refusing the SQL with a 5xx is an answer; a gateway error or no answer is an unknown outcome', async () => {
  assert.equal((await client(answer(500, { message: 'Failed to run sql query: ERROR:  23505: duplicate key' })).query('x')).status, 500);
  for (const unknown of [answer(502, '<html>Bad Gateway</html>'), answer(504, { message: 'upstream timed out' }), async () => { throw new TypeError('fetch failed'); }]) {
    await assert.rejects(client(unknown).query('x'), (e) => e instanceof OutcomeUnknown && !e.message.includes(TOKEN));
  }
});

test('a failure before the request left this machine is marked as not sent; any other lost answer is not', async () => {
  const fails = (code) => client(async () => { throw Object.assign(new TypeError('fetch failed'), code ? { cause: { code } } : {}); }).query('x');
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    await assert.rejects(fails(code), (e) => e instanceof OutcomeUnknown && e.notSent === true, code);
  }
  for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT', undefined]) {
    await assert.rejects(fails(code), (e) => e instanceof OutcomeUnknown && e.notSent === false, String(code));
  }
});

test('a token that JSON would escape is refused, so redacting the raw body is enough', () => {
  for (const bad of ['a"b', 'a\\b', 'a b', 'a\nb']) assert.throws(() => supabase({ project: PROJECT, token: bad }), /token/, JSON.stringify(bad));
  assert.doesNotThrow(() => supabase({ project: PROJECT, token: 'sbp_0123456789abcdef.ghi-jkl~+/=' }));
});

test('a token or project that cannot be used is refused at once, without being echoed', () => {
  assert.throws(() => supabase({ project: PROJECT, token: 'has space' }), (e) => !e.message.includes('has space'));
  assert.throws(() => supabase({ project: PROJECT, token: '' }), /token/);
  assert.throws(() => supabase({ project: '../x', token: TOKEN }), /project/);
});

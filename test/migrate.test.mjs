import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runMigrationsApply } from '../lib/migrate.mjs';
import { readAcks, readClearances } from '../lib/state.mjs';
import { UsageError } from '../lib/shared.mjs';
import { fakeGh, git, makeOrigin, tempDir } from './helpers.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const PROJECT = 'abcdefghijklmnopqrst';
const CONFIG = (extra = '') => `export default {
  repo: 't/r',
  checks: [{ name: 'unit', paths: ['**'], steps: ['true'] }],
  migrations: { paths: ['db/*.sql']${extra} },
  credentials: { file: '/unused/creds.env', map: { SUPABASE_ACCESS_TOKEN: 'SUPABASE_ACCESS_TOKEN' } },
};\n`;
const APPLY = `, apply: { adapter: 'supabase', project: '${PROJECT}', label: 'production' }`;

const THINGS = `-- Adds the things table.
-- ship:verify table public.things
-- ship:verify no-access anon,authenticated public.things
create table public.things (id uuid primary key);
revoke all on public.things from anon, authenticated;
notify pgrst, 'reload schema';
`;
const FACTS = [
  { label: 'table public.things', match: "to_regclass('public.things') is not null", before: false, after: true },
  { label: 'no-access anon,authenticated public.things', match: "has_table_privilege('anon'", before: false, after: true },
];

// A repository whose main holds `files`, a stand-in Supabase API and the deps that join them.
// `answers` is what the person at the terminal types, in order.
async function setup({ files = { 'db/001_old.sql': '', 'db/002_things.sql': THINGS }, config = CONFIG(APPLY), api = {}, answers = ['yes'], interactive = true } = {}) {
  const root = await tempDir('migrate-');
  const { origin, work } = await makeOrigin({ 'ship.config.mjs': config, ...files });
  await git(['remote', 'set-url', 'origin', 'https://github.com/t/r.git'], work);
  const supabase = fakeSupabase({ facts: FACTS, ...api });
  const { gh } = await fakeGh(root, { pr: null });
  const lines = [];
  const asked = [];
  const queue = [...answers];
  const credentialRequests = [];
  const deps = {
    gh, remoteUrl: () => origin, mirrorRoot: join(root, 'm'), tmpRoot: join(root, 'tmp'), logRoot: join(root, 'logs'), stateRoot: join(root, 'state'),
    out: (l) => lines.push(l), pollMs: 10, fetch: supabase.fetch,
    readCredentials: async (req) => { credentialRequests.push(req); return { SUPABASE_ACCESS_TOKEN: supabase.token }; },
    isInteractive: () => interactive,
    ask: async (prompt) => { asked.push(prompt); return queue.shift() ?? ''; },
    who: () => 'owner@laptop',
  };
  const apply = (file = '002_things.sql', opts = {}) => runMigrationsApply({ cwd: work, file, deps, ...opts });
  return { root, work, supabase, deps, lines, asked, credentialRequests, apply, text: () => lines.join('\n'), clearances: () => readClearances(deps.stateRoot, 't/r') };
}

test('a passing apply: plan, dry run, typed yes, the file as merged, proof from the database, then cleared', async () => {
  const s = await setup();
  assert.equal(await s.apply(), 0, s.text());
  assert.deepEqual(s.supabase.requests.map((r) => r.kind), ['check', 'check', 'dry-run', 'apply', 'check', 'check']);
  assert.equal(s.supabase.of('apply')[0].sql, THINGS, 'the bytes applied are the ones on main');
  assert.match(s.supabase.of('dry-run')[0].sql, /^begin;\n/);
  assert.doesNotMatch(s.supabase.of('dry-run')[0].sql, /notify pgrst/, 'the dry run drops the PostgREST notify');
  assert.ok(s.supabase.of('dry-run')[0].sql.trimEnd().endsWith('end $' + s.supabase.of('dry-run')[0].sql.match(/do \$(\w+)\$/)[1] + '$;'));

  const text = s.text();
  assert.match(text, /^▸ migrations apply t\/r main@[0-9a-f]{7}$/m);
  assert.match(text, /file {9}db\/002_things\.sql {2}\(\d+ lines, \d+ bytes, sha256 [0-9a-f]{12}\) as merged on main/);
  assert.match(text, new RegExp(`target {7}Supabase project ${PROJECT} \\(production\\)`));
  assert.match(text, /dry run {6}passed in one transaction, rolled back/);
  assert.match(text, /· table public\.things {3}\[now: does not hold\]/);
  assert.match(text, /\| create table public\.things/);
  assert.match(text, /✓ applied db\/002_things\.sql/);
  assert.match(text, /✓ 2 post-condition\(s\) hold in the database/);
  assert.match(text, /✓ cleared for deploy: db\/002_things\.sql \(applied and proven; owner@laptop, sha256 [0-9a-f]{12}\)/);
  assert.match(text, /! earlier migrations are not cleared yet: db\/001_old\.sql/);

  assert.equal(s.asked.length, 1);
  assert.match(s.asked[0], /^Apply db\/002_things\.sql to production\? Type "yes"/);
  const record = (await s.clearances()).get('db/002_things.sql');
  assert.equal(record.kind, 'applied');
  assert.equal(record.by, 'owner@laptop');
  assert.equal(record.checks, 2);
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([...(await readAcks(s.deps.stateRoot, 't/r'))], ['db/002_things.sql'], 'ship deploy now sees the file as cleared');
  assert.deepEqual(s.credentialRequests, [{ file: '/unused/creds.env', map: { SUPABASE_ACCESS_TOKEN: 'SUPABASE_ACCESS_TOKEN' } }]);
});

test('the token goes only in the Authorization header: not in the output, not in a recorded error', async () => {
  const s = await setup({ api: { applyStatus: 400, echoTokenInErrors: true }, answers: ['yes'] });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ apply: HTTP 400: Failed to run sql query: ERROR: {2}42P07: relation "x" already exists \(Bearer <token>\)/);
  assert.ok(!s.text().includes(s.supabase.token), 'no output line carries the token');
  assert.ok(s.supabase.requests.every((r) => r.headers.Authorization === `Bearer ${s.supabase.token}`));
  assert.ok(!(await readFile(join(s.deps.stateRoot, 'acks', 't__r'), 'utf8').catch(() => '')).includes(s.supabase.token));
});

test('a post-condition that fails after the apply: not cleared, and the failed one is named', async () => {
  // The rolled-back dry run saw the condition hold; the database after the real apply does not.
  const facts = [FACTS[0], { ...FACTS[1], after: false, afterDry: true }];
  const s = await setup({ api: { facts } });
  assert.equal(await s.apply(), 1);
  const text = s.text();
  assert.match(text, /✓ applied db\/002_things\.sql/);
  assert.match(text, /✗ applied, but NOT cleared: these post-conditions do not hold:\n {4}✗ no-access anon,authenticated public\.things/);
  assert.doesNotMatch(text, /✗ table public\.things/, 'only the failed condition is named');
  assert.doesNotMatch(text, /✓ cleared for deploy/);
  assert.equal((await s.clearances()).size, 0);
  assert.equal((await readAcks(s.deps.stateRoot, 't/r')).size, 0, 'ship deploy still refuses');
});

test('without a terminal nothing is read, sent or recorded', async () => {
  const s = await setup({ interactive: false });
  assert.equal(await s.apply(), 2);
  assert.match(s.text(), /^✗ ship migrations apply changes the production database, so it only runs where the owner can read the plan and type "yes"/);
  assert.deepEqual(s.supabase.requests, []);
  assert.deepEqual(s.credentialRequests, []);
  assert.deepEqual(s.asked, []);
  assert.equal((await s.clearances()).size, 0);
});

test('anything but a typed yes cancels before the SQL is sent', async () => {
  for (const answer of ['y', 'no', '', 'yes please', 'YES!']) {
    const s = await setup({ answers: [answer] });
    assert.equal(await s.apply(), 1, JSON.stringify(answer));
    assert.match(s.text(), /✗ cancelled: only "yes" goes on\. Nothing was changed\./);
    assert.deepEqual(s.supabase.of('apply'), [], JSON.stringify(answer));
    assert.equal((await s.clearances()).size, 0);
  }
  const upper = await setup({ answers: [' YES '] });
  assert.equal(await upper.apply(), 0, 'case and spaces around yes do not matter');
});

test('v shows all of the SQL and asks again', async () => {
  const long = `${THINGS}${Array.from({ length: 60 }, (_, i) => `-- filler ${i}`).join('\n')}\nselect 1;\n`;
  const s = await setup({ files: { 'db/002_things.sql': long }, answers: ['v', 'yes'] });
  assert.equal(await s.apply(), 0, s.text());
  assert.match(s.text(), /\| \(\d+ more line\(s\); type v at the prompt to see all of it\)/);
  assert.match(s.text(), /\| select 1;/, 'the tail appears after v');
  assert.equal(s.asked.length, 2);
});

test('--dry-run needs no terminal, asks nothing, applies nothing and records nothing', async () => {
  const s = await setup({ interactive: false });
  assert.equal(await s.apply('002_things.sql', { dryRunOnly: true }), 0, s.text());
  assert.deepEqual(s.supabase.requests.map((r) => r.kind), ['check', 'check', 'dry-run']);
  assert.match(s.text(), /· dry run only: nothing applied, nothing recorded\./);
  assert.deepEqual(s.asked, []);
  assert.equal((await s.clearances()).size, 0);
});

test('a failed dry run stops before the owner is asked', async () => {
  const s = await setup({ api: { dryMessage: 'ERROR:  42P01: relation "public.missing" does not exist\nLINE 3: ...' } });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ dry run failed \(rolled back; nothing changed\): Failed to run sql query: ERROR: {2}42P01: relation "public\.missing" does not exist/);
  assert.deepEqual(s.asked, []);
  assert.deepEqual(s.supabase.of('apply'), []);
});

test('post-conditions that do not hold at the end of the dry run block the apply', async () => {
  const s = await setup({ api: { facts: [FACTS[0], { ...FACTS[1], afterDry: false }] } });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ the dry run ran the migration, but these post-conditions do not hold after it \(rolled back; nothing changed\):\n {4}✗ no-access anon,authenticated public\.things/);
  assert.deepEqual(s.asked, []);
  assert.deepEqual(s.supabase.of('apply'), []);
});

test('a dry run that cannot succeed inside a transaction is skipped, and says why', async () => {
  const s = await setup({ files: { 'db/002_things.sql': `${THINGS}create index concurrently things_i on public.things (id);\n` } });
  assert.equal(await s.apply(), 0, s.text());
  assert.match(s.text(), /dry run {6}skipped: the file uses CONCURRENTLY, which cannot run inside a transaction/);
  assert.deepEqual(s.supabase.of('dry-run'), []);
});

test('a database that already satisfies every post-condition is not touched: only the proof is recorded', async () => {
  const s = await setup({ api: { facts: FACTS.map((f) => ({ ...f, before: true })) } });
  assert.equal(await s.apply(), 0, s.text());
  assert.deepEqual(s.supabase.of('apply'), []);
  assert.deepEqual(s.supabase.of('dry-run'), []);
  assert.match(s.text(), /will run {5}nothing: the SQL is NOT run again; the proof is only recorded/);
  assert.match(s.asked[0], /^Record db\/002_things\.sql as proven\?/);
  assert.equal((await s.clearances()).get('db/002_things.sql').kind, 'applied');
});

test('some post-conditions already holding is flagged, and the dry run decides', async () => {
  const s = await setup({ api: { facts: [{ ...FACTS[0], before: true }, FACTS[1]] } });
  assert.equal(await s.apply(), 0, s.text());
  assert.match(s.text(), /! 1 of 2 post-conditions already hold before the apply/);
  assert.equal(s.supabase.of('apply').length, 1);
});

test('an apply the API refuses changes nothing: nothing holds, nothing is cleared, a re-run is safe', async () => {
  const s = await setup({ api: { applyStatus: 400 } });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ apply: HTTP 400: Failed to run sql query: ERROR: {2}42P07/);
  assert.match(s.text(), /✗ none of the post-conditions holds, so the migration did not take effect and nothing was cleared\. Running the command again is safe\./);
  assert.equal((await s.clearances()).size, 0);
});

test('an apply with no answer that took effect is proven from the database and cleared', async () => {
  const s = await setup({ api: { applyThrows: true, appliedAnyway: true } });
  assert.equal(await s.apply(), 0, s.text());
  assert.match(s.text(), /✗ apply: no answer from the Supabase API \(TypeError\); the migration may or may not have run/);
  assert.match(s.text(), /! the apply reported "no answer from the Supabase API/);
  assert.equal((await s.clearances()).get('db/002_things.sql').kind, 'applied');
});

test('an apply with no answer that did not take effect is not cleared', async () => {
  const s = await setup({ api: { applyThrows: true, appliedAnyway: false } });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /none of the post-conditions holds/);
  assert.equal((await s.clearances()).size, 0);
});

test('a refused token, an unreachable API and an unreadable credentials file stop before anything is sent', async () => {
  const denied = await setup({ api: { denyToken: true } });
  assert.equal(await denied.apply(), 1);
  assert.match(denied.text(), /✗ the Supabase API refused the token \(HTTP 401: Unauthorized\); check SUPABASE_ACCESS_TOKEN in the credentials file\. Nothing was changed\./);
  assert.deepEqual(denied.asked, []);

  const down = await setup({ api: { unreachable: true } });
  assert.equal(await down.apply(), 1);
  assert.match(down.text(), /✗ cannot reach the Supabase API \(no answer from the Supabase API \(TypeError\)\)\. Nothing was changed\./);

  const noFile = await setup();
  noFile.deps.readCredentials = async () => { throw new Error('/unused/creds.env: SUPABASE_ACCESS_TOKEN is missing or empty'); };
  assert.equal(await noFile.apply(), 1);
  assert.match(noFile.text(), /✗ cannot read the Supabase token \(SUPABASE_ACCESS_TOKEN\) from the credentials file: .*missing or empty/);
  assert.deepEqual(noFile.supabase.requests, []);
});

test('a migration that declares no post-conditions cannot be applied by ship', async () => {
  const s = await setup({ files: { 'db/002_things.sql': 'create table public.things (id uuid);\n' } });
  assert.equal(await s.apply(), 2);
  assert.match(s.text(), /✗ db\/002_things\.sql declares no post-conditions, so nothing could prove it worked\./);
  assert.match(s.text(), /ship migrations ack/);
  assert.deepEqual(s.supabase.requests, []);
});

test('post-conditions can sit in a .verify file next to the migration, and a bad declaration names its line', async () => {
  const beside = await setup({ files: { 'db/002_things.sql': 'create table public.things (id uuid);\n', 'db/002_things.verify': '# the table\nship:verify table public.things\n-- ship:verify no-access anon public.things\n' }, api: { facts: [FACTS[0], { ...FACTS[1], label: 'no-access anon public.things' }] } });
  assert.equal(await beside.apply(), 0, beside.text());
  assert.match(beside.text(), /post-conditions \(declared in db\/002_things\.sql and db\/002_things\.verify\):/);
  assert.equal((await beside.clearances()).get('db/002_things.sql').checks, 2);

  const bad = await setup({ files: { 'db/002_things.sql': '-- ship:verify table things\n-- ship:verify frobnicate x\n-- ship:verify sql 1 = 1; drop table x\n' } });
  assert.equal(await bad.apply(), 2);
  assert.match(bad.text(), /✗ db\/002_things\.sql line 1: not a valid table target: table things/);
  assert.match(bad.text(), /✗ db\/002_things\.sql line 2: unknown condition: frobnicate x/);
  assert.match(bad.text(), /✗ db\/002_things\.sql line 3: a sql condition is one expression/);
  assert.deepEqual(bad.supabase.requests, []);
});

test('a file that is already applied and proven is left alone, with no network', async () => {
  const s = await setup();
  assert.equal(await s.apply(), 0);
  s.supabase.requests.length = 0;
  s.asked.length = 0;
  assert.equal(await s.apply(), 0);
  assert.match(s.text(), /✓ db\/002_things\.sql: already applied and proven \(2 post-conditions, owner@laptop, /);
  assert.deepEqual(s.supabase.requests, []);
  assert.deepEqual(s.asked, []);
});

test('a bare ack is upgraded to proof, and proof is never overwritten by a later ack', async () => {
  const s = await setup();
  const { addAcks } = await import('../lib/state.mjs');
  await addAcks(s.deps.stateRoot, 't/r', ['db/002_things.sql']);
  assert.equal((await s.clearances()).get('db/002_things.sql').kind, 'ack');
  assert.equal(await s.apply(), 0, s.text());
  assert.equal((await s.clearances()).get('db/002_things.sql').kind, 'applied');
  await addAcks(s.deps.stateRoot, 't/r', ['db/002_things.sql']);
  assert.equal((await s.clearances()).get('db/002_things.sql').kind, 'applied');
});

test('refusals that change nothing: a file not on main, a repository without migrations.apply, no file name', async () => {
  const s = await setup();
  assert.equal(await s.apply('db/099_nope.sql'), 2);
  assert.match(s.text(), /✗ db\/099_nope\.sql: not a migration on t\/r main@[0-9a-f]{7}/);

  const plain = await setup({ config: CONFIG() });
  assert.equal(await plain.apply(), 2);
  assert.match(plain.text(), /✗ t\/r: ship\.config\.mjs has no migrations\.apply, so ship does not know which database db\/002_things\.sql belongs to; apply it yourself and clear it with ship migrations ack/);

  await assert.rejects(runMigrationsApply({ cwd: s.work, file: null, deps: s.deps }), UsageError);
  for (const x of [s, plain]) assert.deepEqual(x.supabase.requests, []);
});

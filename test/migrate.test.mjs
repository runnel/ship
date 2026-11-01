import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runMigrationsApply } from '../lib/migrate.mjs';
import { addAcks, readAcks, readClearances, recordAttempt, unsettledAttempt } from '../lib/state.mjs';
import { UsageError } from '../lib/shared.mjs';
import { fakeGh, git, makeOrigin, tempDir } from './helpers.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const PROJECT = 'abcdefghijklmnopqrst';
// The token is read by key when a migration is applied; it is not in credentials.map.
const CONFIG = (extra = '') => `export default {
  repo: 't/r',
  checks: [{ name: 'unit', paths: ['**'], steps: ['true'] }],
  migrations: { paths: ['db/*.sql']${extra} },
  credentials: { file: '/unused/creds.env', map: {} },
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
const LOCK = (deps) => join(deps.tmpRoot, 'locks', 'deploy-t__r');

// A repository whose main holds `files`, a stand-in Supabase API and the deps that join them.
// `answers` is what the person at the terminal types, in order; `onAsk(n)` runs when the n-th prompt is shown.
async function setup({ files = { 'db/001_old.sql': '', 'db/002_things.sql': THINGS }, config = CONFIG(APPLY), api = {}, answers = ['yes'], interactive = true, onAsk = null } = {}) {
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
    ask: async (prompt) => { asked.push(prompt); onAsk?.(asked.length); return queue.shift() ?? ''; },
    who: () => 'owner@laptop',
  };
  const apply = (file = '002_things.sql', opts = {}) => runMigrationsApply({ cwd: work, file, deps, ...opts });
  const plan = (file = '002_things.sql') => apply(file, { planOnly: true });
  return { root, work, supabase, deps, lines, asked, credentialRequests, apply, plan, text: () => lines.join('\n'), clearances: () => readClearances(deps.stateRoot, 't/r') };
}

const KINDS_OF_A_FULL_RUN = ['check', 'check', 'dry-run', 'check', 'check', 'apply', 'check', 'check'];

test('a passing apply: plan, dry run, typed yes, the file as merged, proof from the database, then cleared', async () => {
  const s = await setup();
  assert.equal(await s.apply(), 0, s.text());
  // read, dry-run, (prompt), read again under the lock, apply, read after
  assert.deepEqual(s.supabase.requests.map((r) => r.kind), KINDS_OF_A_FULL_RUN);
  assert.equal(s.supabase.of('apply')[0].sql, THINGS, 'the bytes applied are the ones on main');
  const dry = s.supabase.of('dry-run')[0].sql;
  const tag = dry.match(/do \$(\w+)\$/)[1];
  assert.match(dry, /^begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '120s';\ndo \$\w+\$ begin execute \$\w+b\$-- Adds the things table\./);
  assert.doesNotMatch(dry, /notify pgrst/, 'the dry run drops the PostgREST notify');
  assert.ok(dry.trimEnd().endsWith(`end $${tag}$;`));
  assert.ok(s.supabase.of('check').every((r) => r.sql.startsWith('begin read only;\ndo $')), 'every read is a read-only transaction');

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
  assert.equal(await unsettledAttempt(s.deps.stateRoot, 't/r', 'db/002_things.sql', record.sha256), null, 'the attempt is settled by the proof');
  assert.deepEqual(s.credentialRequests, [{ file: '/unused/creds.env', map: { SUPABASE_ACCESS_TOKEN: 'SUPABASE_ACCESS_TOKEN' } }]);
});

test('the deploy lock is held for the apply only, not while the owner reads the prompt', async () => {
  let heldAtPrompt;
  const s = await setup({ onAsk: () => { heldAtPrompt = existsSync(LOCK(s.deps)); } });
  let heldDuringApply = null;
  const inner = s.deps.fetch;
  s.deps.fetch = async (url, init) => {
    if (JSON.parse(init.body).query === THINGS) heldDuringApply = existsSync(LOCK(s.deps));
    return inner(url, init);
  };
  assert.equal(await s.apply(), 0, s.text());
  assert.equal(heldAtPrompt, false);
  assert.equal(heldDuringApply, true);
  assert.equal(existsSync(LOCK(s.deps)), false, 'released afterwards');
});

test('the token goes only in the Authorization header: not in the output, not in a recorded error', async () => {
  const s = await setup({ api: { applyStatus: 400, echoTokenInErrors: true }, answers: ['yes'] });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ apply refused: HTTP 400: Failed to run sql query: ERROR: {2}42P07: relation "x" already exists \(Bearer <token>\)/);
  assert.ok(!s.text().includes(s.supabase.token), 'no output line carries the token');
  assert.ok(s.supabase.requests.every((r) => r.headers.Authorization === `Bearer ${s.supabase.token}`));
  for (const dir of ['acks', 'attempts']) assert.ok(!(await readFile(join(s.deps.stateRoot, dir, 't__r'), 'utf8').catch(() => '')).includes(s.supabase.token));
});

test('a post-condition that fails after the apply: not cleared, and the failed one is named', async () => {
  // The rolled-back dry run saw the condition hold; the database after the real apply does not.
  const s = await setup({ api: { facts: [FACTS[0], { ...FACTS[1], after: false, afterDry: true }] } });
  assert.equal(await s.apply(), 1);
  const text = s.text();
  assert.match(text, /✓ applied db\/002_things\.sql/);
  assert.match(text, /✗ applied, but NOT cleared: these post-conditions do not hold:\n {4}✗ no-access anon,authenticated public\.things/);
  assert.doesNotMatch(text, /✗ table public\.things/, 'only the failed condition is named');
  assert.doesNotMatch(text, /✓ cleared for deploy/);
  assert.equal((await s.clearances()).size, 0);
  assert.equal((await readAcks(s.deps.stateRoot, 't/r')).size, 0, 'ship deploy still refuses');
  assert.ok(await unsettledAttempt(s.deps.stateRoot, 't/r', 'db/002_things.sql', (await sha(s))), 'an answered but unproven apply stays an open attempt');
});

const sha = async (s) => (await import('node:crypto')).createHash('sha256').update(THINGS).digest('hex');

test('without a terminal nothing is read, sent or recorded', async () => {
  const s = await setup({ interactive: false });
  assert.equal(await s.apply(), 2);
  assert.match(s.text(), /^✗ ship migrations apply changes the production database, so it only runs where the owner can read the plan and type the answer/);
  assert.match(s.text(), /ship migrations plan <file>/);
  assert.deepEqual(s.supabase.requests, []);
  assert.deepEqual(s.credentialRequests, []);
  assert.deepEqual(s.asked, []);
  assert.equal((await s.clearances()).size, 0);
});

test('anything but the typed word cancels before the SQL is sent', async () => {
  for (const answer of ['y', 'no', '', 'yes please', 'YES!']) {
    const s = await setup({ answers: [answer] });
    assert.equal(await s.apply(), 1, JSON.stringify(answer));
    assert.match(s.text(), /✗ cancelled: only "yes" goes on\. Nothing was changed\./);
    assert.deepEqual(s.supabase.of('apply'), [], JSON.stringify(answer));
    assert.equal((await s.clearances()).size, 0);
  }
  const spaced = await setup({ answers: [' YES '] });
  assert.equal(await spaced.apply(), 0, 'case and spaces around yes do not matter');
});

test('v shows all of the SQL and asks again', async () => {
  const long = `${THINGS}${Array.from({ length: 60 }, (_, i) => `-- filler ${i}`).join('\n')}\nselect 1;\n`;
  const s = await setup({ files: { 'db/002_things.sql': long }, answers: ['v', 'yes'] });
  assert.equal(await s.apply(), 0, s.text());
  assert.match(s.text(), /\| \(\d+ more line\(s\); type v at the prompt to see all of it\)/);
  assert.match(s.text(), /\| select 1;/, 'the tail appears after v');
  assert.equal(s.asked.length, 2);
});

test('plan needs no terminal, asks nothing, applies nothing and records nothing', async () => {
  const s = await setup({ interactive: false });
  assert.equal(await s.plan(), 0, s.text());
  assert.deepEqual(s.supabase.requests.map((r) => r.kind), ['check', 'check', 'dry-run']);
  assert.match(s.text(), /· plan only: nothing applied, nothing recorded\./);
  assert.deepEqual(s.asked, []);
  assert.equal((await s.clearances()).size, 0);
  assert.equal(existsSync(LOCK(s.deps)), false);
});

test('a failed dry run stops before the owner is asked; without a terminal only its first line is shown', async () => {
  const message = 'ERROR:  23505: duplicate key value violates unique constraint "x"\nDETAIL:  Key (email)=(someone@example.com) already exists.';
  const s = await setup({ api: { dryMessage: message } });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ dry run failed \(rolled back; nothing changed\): Failed to run sql query: ERROR: {2}23505: duplicate key[^\n]*\nDETAIL: {2}Key \(email\)=\(someone@example\.com\)/, 'in the owner\'s terminal the whole message is shown');
  assert.deepEqual(s.asked, []);
  assert.deepEqual(s.supabase.of('apply'), []);

  const quiet = await setup({ api: { dryMessage: message }, interactive: false });
  assert.equal(await quiet.plan(), 1);
  assert.match(quiet.text(), /✗ dry run failed \(rolled back; nothing changed\): Failed to run sql query: ERROR: {2}23505: duplicate key value violates unique constraint "x"$/m);
  assert.doesNotMatch(quiet.text(), /someone@example\.com/, 'row data in Postgres detail lines stays out of a session\'s transcript');
});

test('a file with its own COMMIT is refused by the dry run, with the reason', async () => {
  const s = await setup({ api: { dryMessage: 'ERROR:  0A000: EXECUTE of transaction commands is not implemented' } });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /The file has its own COMMIT, ROLLBACK or END; the dry run refuses those/);
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

test('conditions that already hold: the SQL is not run, the owner types "record", and the proof is only "verified"', async () => {
  const s = await setup({ api: { facts: FACTS.map((f) => ({ ...f, before: true })) }, answers: ['record'] });
  assert.equal(await s.apply(), 0, s.text());
  assert.deepEqual(s.supabase.of('apply'), []);
  assert.deepEqual(s.supabase.of('dry-run'), []);
  const text = s.text();
  assert.match(text, /^▸ migrations record /m);
  assert.match(text, /will run {5}nothing: the SQL is NOT run; the proof is only recorded/);
  assert.match(text, /! ship did not run this file and never saw these conditions fail\./);
  assert.match(text, /\| create table public\.things/, 'the SQL is shown');
  assert.match(s.asked[0], /^Record db\/002_things\.sql as found in place\? Type "record"/);
  assert.match(text, /✓ cleared for deploy: db\/002_things\.sql \(found in place, not run by ship;/);
  assert.equal((await s.clearances()).get('db/002_things.sql').kind, 'verified');

  const wrongWord = await setup({ api: { facts: FACTS.map((f) => ({ ...f, before: true })) }, answers: ['yes'] });
  assert.equal(await wrongWord.apply(), 1);
  assert.match(wrongWord.text(), /✗ cancelled: only "record" goes on\./);
  assert.equal((await wrongWord.clearances()).size, 0);
});

test('a lost answer is recoverable: the re-run finds the conditions holding and records a real "applied"', async () => {
  const s = await setup({ api: { applyThrows: 1, appliedAnyway: true } });
  assert.equal(await s.apply(), 0, s.text());
  assert.match(s.text(), /✗ apply: no answer from the Supabase API \(TypeError\); the migration may or may not have run/);
  assert.match(s.text(), /! the apply got no answer .*but every post-condition holds in the database now/);
  assert.equal((await s.clearances()).get('db/002_things.sql').kind, 'applied');

  // The answer was lost AND the proof could not be recorded in the same run (the database was
  // unreadable): the next run sees an open attempt and the conditions holding.
  const t = await setup({ api: { applyThrows: 1, appliedAnyway: true }, answers: ['yes', 'yes'] });
  const real = t.deps.fetch;
  let afterApply = false;
  t.deps.fetch = async (url, init) => {
    const q = JSON.parse(init.body).query;
    if (q === THINGS) afterApply = true;
    else if (afterApply && q.startsWith('begin read only')) throw new TypeError('fetch failed');
    return real(url, init);
  };
  assert.equal(await t.apply(), 1);
  assert.match(t.text(), /✗ no answer to the apply, and the post-conditions do not all hold \(some could not be read\)/);
  assert.equal((await t.clearances()).size, 0);
  t.deps.fetch = real;
  t.lines.length = 0;
  assert.equal(await t.apply(), 0, t.text());
  assert.match(t.text(), /^! this exact file was sent to the database before \(owner@laptop, .*\) and no result was ever recorded/m);
  assert.match(t.asked.at(-1), /^Record db\/002_things\.sql as applied\? Type "yes"/);
  assert.equal((await t.clearances()).get('db/002_things.sql').kind, 'applied', 'ship sent the file, so this is an applied, not a verified');
  assert.deepEqual(t.supabase.of('apply').length, 1, 'the SQL was not sent a second time');
});

test('an apply with no answer and nothing visible yet may still be running: the message says so and a re-run needs "apply again"', async () => {
  const s = await setup({ api: { applyThrows: 1, appliedAnyway: false }, answers: ['yes', 'yes', 'apply again'] });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ no answer to the apply, and the post-conditions do not all hold: the statement may still be running or may yet commit\. Do not run it again for now: look at pg_stat_activity first\./);
  assert.doesNotMatch(s.text(), /Running the command again is safe/, 'with no answer, a re-run is not known to be safe');
  assert.equal((await s.clearances()).size, 0);

  s.lines.length = 0;
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /! this exact file was sent to the database before .* no result was ever recorded: that request may still be running/);
  assert.match(s.asked.at(-1), /Type "apply again"/);
  assert.match(s.text(), /✗ cancelled: only "apply again" goes on\./);
  assert.equal(s.supabase.of('apply').length, 1);

  s.lines.length = 0;
  assert.equal(await s.apply(), 0, s.text());
  assert.equal(s.supabase.of('apply').length, 2, 'only after the owner typed "apply again"');
  assert.equal((await s.clearances()).get('db/002_things.sql').kind, 'applied');
});

test('an apply Postgres refused changes nothing: nothing holds, nothing is cleared, a re-run is safe', async () => {
  const s = await setup({ api: { applyStatus: 400 } });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ apply refused: HTTP 400: Failed to run sql query: ERROR: {2}42P07/);
  assert.match(s.text(), /✗ Postgres refused the file and the database is as it was before: nothing took effect and nothing was cleared\. Running the command again is safe\./);
  assert.equal((await s.clearances()).size, 0);
  assert.equal(await unsettledAttempt(s.deps.stateRoot, 't/r', 'db/002_things.sql', await sha(s)), null, 'a refusal settles the attempt');
});

test('a refusal followed by "everything holds" is not recorded: someone else changed the database, or the file commits part of itself', async () => {
  const s = await setup({ api: { applyStatus: 400, refusalCommits: true } });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ Postgres refused the file, yet every post-condition holds\. .* Not recorded; inspect the database\./);
  assert.doesNotMatch(s.text(), /✓ cleared for deploy/);
  assert.equal((await s.clearances()).size, 0);
});

test('the database changing between the plan and the answer cancels the run', async () => {
  const s = await setup({ onAsk: () => { s.supabase.state.applied = true; } });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ the database changed \(or could not be read\) between the plan and your answer/);
  assert.deepEqual(s.supabase.of('apply'), []);
  assert.equal((await s.clearances()).size, 0);
});

test('a refused token, an unreachable API, a half-readable one and an unreadable credentials file stop before anything is sent', async () => {
  const denied = await setup({ api: { denyToken: true } });
  assert.equal(await denied.apply(), 1);
  assert.match(denied.text(), /✗ the Supabase API refused the token \(HTTP 401: Unauthorized\); check SUPABASE_ACCESS_TOKEN in the credentials file\. Nothing was changed\./);
  assert.deepEqual(denied.asked, []);

  const down = await setup({ api: { unreachable: true } });
  assert.equal(await down.apply(), 1);
  assert.match(down.text(), /✗ could not read 2 of 2 post-conditions from the Supabase API \(no answer from the Supabase API \(TypeError\)\)\. Nothing was changed\./);

  const flaky = await setup();
  const real = flaky.deps.fetch;
  let reads = 0;
  flaky.deps.fetch = async (url, init) => {
    if (JSON.parse(init.body).query.startsWith('begin read only') && ++reads === 2) throw new TypeError('fetch failed');
    return real(url, init);
  };
  assert.equal(await flaky.apply(), 1);
  assert.match(flaky.text(), /✗ could not read 1 of 2 post-conditions from the Supabase API/);
  assert.deepEqual(flaky.supabase.of('apply'), [], 'one probe that did not answer is not "does not hold"');
  assert.deepEqual(flaky.supabase.of('dry-run'), []);

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
  const facts = [FACTS[0], { ...FACTS[1], label: 'no-access anon public.things' }];
  const beside = await setup({ files: { 'db/002_things.sql': 'create table public.things (id uuid);\n', 'db/002_things.verify': '# the table\nship:verify table public.things   -- notes after the form are fine\n-- ship:verify no-access anon public.things\n' }, api: { facts } });
  assert.equal(await beside.apply(), 0, beside.text());
  assert.match(beside.text(), /post-conditions \(declared in db\/002_things\.sql and db\/002_things\.verify\):/);
  assert.equal((await beside.clearances()).get('db/002_things.sql').checks, 2);

  const bad = await setup({ files: { 'db/002_things.sql': '-- ship:verify table things\n-- ship:verify frobnicate x\n-- ship:verify sql 1 = 1; drop table x\n-- ship:verify sql false), true) as ok, (select 1\n' } });
  assert.equal(await bad.apply(), 2);
  assert.match(bad.text(), /✗ db\/002_things\.sql line 1: not a valid table target: table things/);
  assert.match(bad.text(), /✗ db\/002_things\.sql line 2: unknown condition: frobnicate x/);
  assert.match(bad.text(), /✗ db\/002_things\.sql line 3: a sql condition is one expression/);
  assert.match(bad.text(), /✗ db\/002_things\.sql line 4: a sql condition needs balanced parentheses/);
  assert.deepEqual(bad.supabase.requests, []);
});

test('a file that is already proven is left alone, with no network; a changed file is flagged', async () => {
  const s = await setup();
  assert.equal(await s.apply(), 0);
  s.supabase.requests.length = 0;
  s.asked.length = 0;
  assert.equal(await s.apply(), 0);
  assert.match(s.text(), /✓ db\/002_things\.sql: already applied and proven \(2 post-conditions, owner@laptop, /);
  assert.deepEqual(s.supabase.requests, []);
  assert.deepEqual(s.asked, []);
  assert.doesNotMatch(s.text(), /has changed since/);

  // main later gets a different file under the same name
  const edited = await setup({ files: { 'db/002_things.sql': `${THINGS}-- edited later\n` } });
  const { addProof } = await import('../lib/state.mjs');
  await addProof(edited.deps.stateRoot, 't/r', { kind: 'applied', file: 'db/002_things.sql', by: 'owner@laptop', sha256: await sha(edited), mainSha: 'a'.repeat(40), checks: 2 });
  assert.equal(await edited.apply(), 0);
  assert.match(edited.text(), /! the file on main has changed since: it was sha256 [0-9a-f]{12}, it is [0-9a-f]{12} now\. Nothing was applied/);
});

test('a bare ack is upgraded to proof, and proof is never overwritten by a later ack', async () => {
  const s = await setup();
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

test('another run sending the same file while this prompt is open cancels this run: the "apply again" gate cannot be skipped', async () => {
  const s = await setup({ onAsk: async () => { await recordAttempt(s.deps.stateRoot, 't/r', { file: 'db/002_things.sql', sha256: await sha(s), by: 'owner@other-terminal' }); } });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ another run sent or settled this file while you were deciding/);
  assert.deepEqual(s.supabase.of('apply'), []);
  assert.equal((await s.clearances()).size, 0);
});

const TWO_BLOCKS = `-- ship:verify table public.things
begin;
create table public.things (id uuid primary key);
commit;
begin;
update public.things set id = id;
commit;
`;
const ONE_BLOCK = `-- ship:verify table public.things
begin;
create table public.things (id uuid primary key);
commit;
notify pgrst, 'reload schema';
`;
const THINGS_FACT = [{ label: 'table public.things', match: "to_regclass('public.things') is not null", before: false, after: true }];

test('a file with several transaction blocks is not called atomic: a refusal keeps the attempt open and never says "safe"', async () => {
  const s = await setup({ files: { 'db/002_things.sql': TWO_BLOCKS }, api: { facts: THINGS_FACT, applyStatus: 400 } });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /! this file is NOT one transaction \(its own BEGIN\/COMMIT/);
  assert.match(s.text(), /will run {5}the file's SQL, as one request$/m);
  assert.match(s.text(), /✗ Postgres refused the file, and it is not a single transaction, so part of it may have committed\./);
  assert.doesNotMatch(s.text(), /safe/);
  assert.ok(await unsettledAttempt(s.deps.stateRoot, 't/r', 'db/002_things.sql', TWO_BLOCKS && (await import('node:crypto')).createHash('sha256').update(TWO_BLOCKS).digest('hex')), 'the attempt stays open');
});

test('a file that is one begin…commit block is atomic: the refusal is a safe one', async () => {
  const s = await setup({ files: { 'db/002_things.sql': ONE_BLOCK }, api: { facts: THINGS_FACT, applyStatus: 400 } });
  assert.equal(await s.apply(), 1);
  assert.doesNotMatch(s.text(), /NOT one transaction/);
  assert.match(s.text(), /will run {5}the file's SQL, as one request \(one transaction\)/);
  assert.match(s.text(), /Running the command again is safe\./);
});

test('a file with effects that survive a rollback is not dry-run, and says why; a lone SET of a timeout is dropped from the dry run', async () => {
  const s = await setup({ files: { 'db/002_things.sql': `-- ship:verify table public.things\ncreate table public.things (id int);\nselect setval('public.things_id_seq', 1, false);\n` }, api: { facts: THINGS_FACT } });
  assert.equal(await s.apply(), 0, s.text());
  assert.match(s.text(), /dry run {6}skipped: the file uses setval \(a sequence value is not rolled back\)/);
  assert.match(s.text(), /! this file is NOT one transaction/, 'without a dry run a refusal cannot be called safe');
  assert.deepEqual(s.supabase.of('dry-run'), []);

  const dump = await setup({ files: { 'db/002_things.sql': `-- ship:verify table public.things\nSET statement_timeout = 0;\nSET lock_timeout = 0;\ncreate table public.things (id int);\n` }, api: { facts: THINGS_FACT } });
  assert.equal(await dump.apply(), 0, dump.text());
  const dry = dump.supabase.of('dry-run')[0].sql;
  assert.doesNotMatch(dry.split('execute')[1], /lock_timeout|statement_timeout/, 'the file cannot switch off the dry run\'s limits');
  assert.equal(dump.supabase.of('apply')[0].sql.includes('SET lock_timeout = 0;'), true, 'the apply is the file as it is');
});

test('a request that never left this machine settles its attempt and leaves nothing to warn about', async () => {
  const s = await setup({ api: { applyThrows: 1, applyThrowsCode: 'ECONNREFUSED' }, answers: ['yes', 'yes'] });
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ the request never left this machine \(no answer from the Supabase API \(ECONNREFUSED\)\): nothing was sent and nothing was changed\./);
  assert.equal(await unsettledAttempt(s.deps.stateRoot, 't/r', 'db/002_things.sql', await sha(s)), null);
  s.lines.length = 0;
  assert.equal(await s.apply(), 0, s.text());
  assert.doesNotMatch(s.text(), /sent to the database before/);
});

test('a refusal of a later send does not close an earlier send that may still be running', async () => {
  const s = await setup({ api: { applyThrows: 1 }, answers: ['yes', 'apply again'] });
  assert.equal(await s.apply(), 1); // first send: no answer, attempt open
  // second send (apply again): Postgres refuses it because the first one committed meanwhile
  s.supabase.state.applied = false;
  const inner = s.deps.fetch;
  s.deps.fetch = async (url, init) => {
    const q = JSON.parse(init.body).query;
    if (q === THINGS) { s.supabase.state.applied = true; return new Response(JSON.stringify({ message: 'Failed to run sql query: ERROR:  42P07: relation "things" already exists' }), { status: 400 }); }
    return inner(url, init);
  };
  s.lines.length = 0;
  assert.equal(await s.apply(), 1);
  assert.ok(await unsettledAttempt(s.deps.stateRoot, 't/r', 'db/002_things.sql', await sha(s)), 'the first attempt is still open');
});

test('recording a file found in place stops when the conditions no longer hold at that moment', async () => {
  const facts = FACTS.map((f) => ({ ...f, before: true, after: false }));
  const s = await setup({ api: { facts }, answers: ['record'] });
  const inner = s.deps.fetch;
  let reads = 0;
  s.deps.fetch = async (url, init) => {
    // two reads for the plan, two under the lock; the table disappears before the one that decides
    if (JSON.parse(init.body).query.startsWith('begin read only') && ++reads === 5) s.supabase.state.applied = true;
    return inner(url, init);
  };
  assert.equal(await s.apply(), 1);
  assert.match(s.text(), /✗ the conditions no longer hold, so nothing was recorded:\n {4}✗ table public\.things/);
  assert.equal((await s.clearances()).size, 0);
  assert.doesNotMatch(s.text(), /applied, but NOT cleared/);
});

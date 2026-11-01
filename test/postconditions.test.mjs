import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conditionExpression, dryRunSql, nonTransactional, parseConditions, parseDryRun, parseProbe, probeSql, stripTransaction } from '../lib/postconditions.mjs';

const one = (line, opts) => parseConditions(`-- ship:verify ${line}\n`, opts);
const sqlOf = (line) => conditionExpression(one(line).conditions[0]);

test('every form parses into a labelled condition; the label is the declaration', () => {
  const text = [
    '-- ship:verify table public.things',
    '  -- ship:verify   column public.things.owner_id  ',
    '-- ship:verify function public.record_scan(uuid, text)',
    '-- ship:verify rls public.things',
    '-- ship:verify no-access anon,authenticated public.things',
    '-- ship:verify no-execute anon public.record_scan(uuid,text)',
    '-- ship:verify access service_role select,insert public.things',
    '-- ship:verify execute service_role public.record_scan(uuid,text)',
    '-- ship:verify absent table public.old_things',
    '-- ship:verify sql (select count(*) from public.things) = 0',
  ].join('\n');
  const { conditions, errors } = parseConditions(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(conditions.map((c) => c.kind), ['table', 'column', 'function', 'rls', 'no-access', 'no-execute', 'access', 'execute', 'absent', 'sql']);
  assert.equal(conditions[1].label, 'column public.things.owner_id');
  assert.equal(conditions[9].label, 'sql (select count(*) from public.things) = 0');
});

test('only comment lines of a migration count; a .verify file may leave the dashes off', () => {
  const sql = 'select \'ship:verify table public.a\';\nship:verify table public.b\n-- ship:verify table public.c\n';
  assert.deepEqual(parseConditions(sql).conditions.map((c) => c.label), ['table public.c']);
  assert.deepEqual(parseConditions('# note\nship:verify table public.b\n-- ship:verify table public.c\n', { sidecar: true }).conditions.map((c) => c.label), ['table public.b', 'table public.c']);
});

test('what cannot be understood is an error with its line, never a silent skip', () => {
  const bad = (line) => one(line, { source: 'm.sql' }).errors;
  assert.deepEqual(bad(''), ['m.sql line 1: empty ship:verify line']);
  assert.match(bad('sql (1 = 1')[0], /balanced parentheses/);
  assert.match(bad('sql 1 = 1)')[0], /balanced parentheses/);
  assert.match(bad("sql 'open = 1")[0], /balanced parentheses and closed quotes/);
  assert.match(bad('sql false), true) as ok, (select 1')[0], /balanced parentheses/);
  assert.match(bad('table things')[0], /^m\.sql line 1: not a valid table target: table things$/);
  assert.match(bad('table Public.Things')[0], /not a valid table target/);
  assert.match(bad('table public.a public.b')[0], /^m\.sql line 1: expected table <target>/);
  assert.match(bad('no-access anon')[0], /expected no-access <roles> <schema\.relation>/);
  assert.match(bad('no-access anon;drop public.t')[0], /not a list of role names/);
  assert.match(bad('no-access anon public.t; drop table x')[0], /expected no-access/);
  assert.match(bad('access anon select,drop public.t')[0], /privileges must come from/);
  assert.match(bad("function public.f(text'); drop table x; --)")[0], /not a valid function target/);
  assert.match(bad('absent view public.v')[0], /not a valid view target/);
  assert.match(bad('sql true; select 1')[0], /one expression/);
  assert.match(bad('sql true -- tail')[0], /one expression/);
  assert.match(bad('sql $$x$$ = $$x$$')[0], /one expression/);
  assert.match(bad('sql')[0], /expected sql <boolean expression>/);
  assert.match(bad('frobnicate')[0], /unknown condition: frobnicate/);
});

test('conditions become boolean expressions; a missing object reads as "does not hold"', () => {
  assert.equal(sqlOf('table public.things'), "to_regclass('public.things') is not null");
  assert.match(sqlOf('column public.things.owner_id'), /from pg_attribute where attrelid = to_regclass\('public\.things'\) and attname = 'owner_id'/);
  assert.equal(sqlOf('function public.f(uuid, text)'), "to_regprocedure('public.f(uuid, text)') is not null");
  assert.match(sqlOf('rls public.things'), /relrowsecurity from pg_class where oid = to_regclass\('public\.things'\)/);
  const noAccess = sqlOf('no-access anon,authenticated public.things');
  assert.match(noAccess, /not \(has_table_privilege\('anon', to_regclass\('public\.things'\), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'\) or has_any_column_privilege\('anon'/);
  assert.match(noAccess, / and not \(has_table_privilege\('authenticated'/);
  assert.equal(sqlOf('no-execute anon public.f(uuid)'), "not has_function_privilege('anon', to_regprocedure('public.f(uuid)'), 'EXECUTE')");
  assert.equal(sqlOf('access service_role select,insert public.things'), "has_table_privilege('service_role', to_regclass('public.things'), 'SELECT') and has_table_privilege('service_role', to_regclass('public.things'), 'INSERT')");
  assert.equal(sqlOf('absent function public.f(uuid)'), "not (to_regprocedure('public.f(uuid)') is not null)");
  assert.equal(sqlOf('sql 1 = 1'), '1 = 1');
});

test('the dry run runs the file as a string inside a DO block in one transaction that always ends in the marker', () => {
  const conditions = parseConditions('-- ship:verify table public.a\n-- ship:verify rls public.a\n').conditions;
  const sql = dryRunSql('begin;\ncreate table public.a (id int)\nnotify pgrst, \'reload schema\';\ncommit;\n', conditions, 'dx1');
  assert.match(sql, /^begin;\nset local lock_timeout = '5s';\nset local statement_timeout = '120s';\ndo \$dx1\$ begin execute \$dx1b\$create table public\.a \(id int\)\n\$dx1b\$; raise exception 'DRY_RUN_OK %', \(jsonb_build_array\(jsonb_build_object\('label', 'table public\.a', 'ok', coalesce\(\(/);
  assert.ok(sql.endsWith('::text; end $dx1$;'));
  assert.equal(sql.match(/^begin;$/gm).length, 1, "the file's own begin is removed");
  assert.doesNotMatch(sql, /commit;|notify/);
  assert.match(dryRunSql('select 1', conditions, 'dx1', { lockTimeout: '1s', statementTimeout: '9s' }), /lock_timeout = '1s';\nset local statement_timeout = '9s';/);
});

test('whatever the file does with transactions stays inside the EXECUTE string, so it cannot end the dry run early', () => {
  const conditions = parseConditions('-- ship:verify table public.a\n').conditions;
  for (const stray of ['create table public.a (id int); commit;', 'create table public.a (id int);\nend;', '/* x */ commit;', 'commit work;', 'rollback;', 'abort;', 'end transaction;', 'commit; -- later']) {
    const sql = dryRunSql(stray, conditions, 'dx1');
    const outside = sql.slice(0, sql.indexOf('execute $dx1b$')) + sql.slice(sql.lastIndexOf('$dx1b$') + '$dx1b$'.length);
    assert.doesNotMatch(outside, /commit|rollback|abort|\bend (transaction|work)|\bend;/i, `${JSON.stringify(stray)} appears outside the string`);
  }
  assert.throws(() => dryRunSql('select \'$dx1b$\'', conditions, 'dx1'), /own quoting tag/);
  assert.equal(stripTransaction('begin;\nselect 1;\nCOMMIT;'), 'select 1;');
  assert.equal(stripTransaction('create function f() returns int language plpgsql as $$ begin return 1; end; $$;'), 'create function f() returns int language plpgsql as $$ begin return 1; end; $$;', 'a plpgsql block end is not a transaction line');
});

test('a probe reads one condition in a read-only transaction that always ends in the marker', () => {
  const c = one('table public.things').conditions[0];
  assert.equal(probeSql(c, 'p1'), "begin read only;\ndo $p1$ begin raise exception 'CHECK_OK %', (jsonb_build_array(jsonb_build_object('label', 'table public.things', 'ok', coalesce((to_regclass('public.things') is not null), false))))::text; end $p1$;");
  const answer = (marker) => ({ status: 400, body: { message: `Failed to run sql query: ERROR:  P0001: ${marker} [{"label":"table public.things","ok":true}]\nCONTEXT: x` } });
  assert.deepEqual(parseProbe(answer('CHECK_OK')), { passed: true, results: [{ label: 'table public.things', ok: true }] });
  assert.equal(parseProbe(answer('DRY_RUN_OK')).passed, false, 'a probe only trusts its own marker');
  assert.match(parseProbe({ status: 400, body: { message: 'ERROR:  25006: cannot execute nextval() in a read-only transaction' } }).detail, /read-only/);
});

test('only the first line of the answer can be the marker: an echo of our own SQL is not a pass', () => {
  const results = [{ label: 'table public.a', ok: true }];
  const ok = parseDryRun({ status: 400, body: { message: `ERROR:  P0001: DRY_RUN_OK ${JSON.stringify(results)}\nCONTEXT: PL/pgSQL function inline_code_block line 1 at RAISE` } });
  assert.deepEqual(ok, { passed: true, results });
  const echoed = parseDryRun({ status: 400, body: { message: 'ERROR:  42601: syntax error at or near "x"\nLINE 4: raise exception \'DRY_RUN_OK %\'' } });
  assert.equal(echoed.passed, false);
  assert.match(echoed.detail, /^ERROR: {2}42601/);
  assert.equal(parseDryRun({ status: 200, body: [] }).passed, false);
  assert.match(parseDryRun({ status: 400, body: { message: 'ERROR:  P0001: DRY_RUN_OK not json' } }).detail, /could not be read/);
  assert.equal(parseDryRun({ status: 400, body: { message: 'ERROR:  P0001: DRY_RUN_OK {"label":1}' } }).passed, false);
});

test('statements a transaction cannot hold are recognised', () => {
  assert.equal(nonTransactional('create index concurrently i on t (c);'), 'CONCURRENTLY');
  assert.equal(nonTransactional('vacuum analyze t;'), 'VACUUM');
  assert.equal(nonTransactional('create table t (c int);'), null);
});

test('a trailing note is ignored on every form but sql', () => {
  const { conditions, errors } = parseConditions('-- ship:verify table public.a    -- the table\n-- ship:verify function public.f(uuid, text) -- (arguments)\n-- ship:verify sql (select 1) = 1\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(conditions.map((c) => c.label), ['table public.a', 'function public.f(uuid, text)', 'sql (select 1) = 1']);
  assert.match(parseConditions('-- ship:verify sql 1 = 1 -- note\n').errors[0], /one expression/);
  assert.equal(parseConditions("-- ship:verify sql (select ')') = ')'\n").errors.length, 0, 'parentheses inside quotes do not count');
});

test('the example in the README parses', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const block = readme.match(/```sql\n((?:-- ship:verify[^\n]*\n)+)```/)?.[1];
  assert.ok(block, 'the README has a ship:verify example block');
  const { conditions, errors } = parseConditions(block);
  assert.deepEqual(errors, []);
  assert.deepEqual(new Set(conditions.map((c) => c.kind)), new Set(['table', 'column', 'function', 'rls', 'no-access', 'no-execute', 'access', 'execute', 'absent', 'sql']));
});

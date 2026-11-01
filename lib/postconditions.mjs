// Post-conditions: what a migration declares about the database it leaves behind. They are written
// as `-- ship:verify <condition>` comment lines in the migration file (or, one per line with the
// `--` optional, in a `<name>.verify` file next to it), so they are reviewed with the migration and
// read from the same commit. ship turns each into one read-only SELECT; it never runs SQL that the
// declaration supplies except in the `sql` form, which is a single boolean expression.
//
//   table S.N                    a table, view or other relation exists
//   column S.T.C                 the column exists
//   function S.N(argtypes)       the function exists
//   rls S.T                      row level security is enabled on the table
//   no-access ROLES S.R          none of the roles holds any privilege on the relation or its columns
//   no-execute ROLES S.N(args)   none of the roles may execute the function
//   access ROLES PRIVS S.R       every role holds every listed privilege (SELECT,INSERT,...)
//   execute ROLES S.N(args)      every role may execute the function
//   absent table|column|function <target as above>   it must no longer exist
//   sql <boolean expression>     one balanced expression, no `;`, comments or `$`
//
// A trailing `-- note` is ignored on every form except `sql`.
//
// ROLES is a comma-separated list. Names are lower-case and schema-qualified: a condition that
// depended on the search path would prove nothing.

const IDENT = '[a-z_][a-z0-9_]*';
const RELATION = new RegExp(`^(${IDENT})\\.(${IDENT})$`);
const COLUMN = new RegExp(`^(${IDENT})\\.(${IDENT})\\.(${IDENT})$`);
const FUNCTION = new RegExp(`^(${IDENT})\\.(${IDENT})\\(([a-z0-9_ ,.\\[\\]]*)\\)$`);
const ROLE = new RegExp(`^${IDENT}$`);
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];

const DIRECTIVE = /^\s*(--\s*)?ship:verify(?:\s+(.*?))?\s*$/;
export const SIDECAR_SUFFIX = '.verify';

const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
const roleList = (text) => {
  const roles = text.split(',');
  return roles.length > 0 && roles.every((r) => ROLE.test(r)) ? roles : null;
};

function parseTarget(kind, text) {
  if (kind === 'table' && RELATION.test(text)) return { kind, ref: text };
  if (kind === 'column' && COLUMN.test(text)) return { kind, ref: text };
  if (kind === 'function' && FUNCTION.test(text)) return { kind, ref: text };
  return null;
}

// Parentheses balance outside quoted text, and no quote is left open: an expression that closes the
// wrapper's own parenthesis early could add columns or conditions of its own.
function balanced(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && !(text[j] === c && text[j + 1] !== c)) j += text[j] === c ? 2 : 1;
      if (j >= text.length) return false;
      i = j;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth < 0) {
      return false;
    }
  }
  return depth === 0;
}

// One condition from the text after `ship:verify`, or { error }.
function parseCondition(text) {
  const words = text.split(/\s+/);
  const [kind, ...rest] = words;
  const bad = (why) => ({ error: `${why}: ${text}` });
  const want = (n, usage) => (rest.length === n ? null : bad(`expected ${usage}`));
  switch (kind) {
    // A function target holds spaces (`public.f(uuid, text)`), so it is the rest of the line.
    case 'table': case 'column': case 'function': {
      const e = kind === 'function' ? (rest.length > 0 ? null : bad('expected function <target>')) : want(1, `${kind} <target>`);
      if (e) return e;
      return parseTarget(kind, rest.join(' ')) ?? bad(`not a valid ${kind} target`);
    }
    case 'absent': {
      const e = rest.length >= 2 ? null : bad('expected absent table|column|function <target>');
      if (e) return e;
      const target = parseTarget(rest[0], rest.slice(1).join(' '));
      return target ? { kind: 'absent', target } : bad(`not a valid ${rest[0]} target`);
    }
    case 'rls': {
      const e = want(1, 'rls <schema.table>');
      if (e) return e;
      return RELATION.test(rest[0]) ? { kind, ref: rest[0] } : bad('not a schema-qualified table');
    }
    case 'no-access': {
      const e = want(2, 'no-access <roles> <schema.relation>');
      if (e) return e;
      const roles = roleList(rest[0]);
      if (!roles) return bad('not a list of role names');
      return RELATION.test(rest[1]) ? { kind, roles, ref: rest[1] } : bad('not a schema-qualified relation');
    }
    case 'no-execute': case 'execute': {
      if (rest.length < 2) return bad(`expected ${kind} <roles> <schema.function(args)>`);
      const roles = roleList(rest[0]);
      if (!roles) return bad('not a list of role names');
      const ref = rest.slice(1).join(' ');
      return FUNCTION.test(ref) ? { kind, roles, ref: ref.replace(/\s+/g, ' ') } : bad('not a schema-qualified function with its argument types');
    }
    case 'access': {
      const e = want(3, 'access <roles> <privileges> <schema.relation>');
      if (e) return e;
      const roles = roleList(rest[0]);
      if (!roles) return bad('not a list of role names');
      const privileges = rest[1].toUpperCase().split(',');
      if (!privileges.every((p) => TABLE_PRIVILEGES.includes(p))) return bad(`privileges must come from ${TABLE_PRIVILEGES.join(',')}`);
      return RELATION.test(rest[2]) ? { kind, roles, privileges, ref: rest[2] } : bad('not a schema-qualified relation');
    }
    case 'sql': {
      const expression = text.slice(text.indexOf('sql') + 3).trim();
      if (!expression) return bad('expected sql <boolean expression>');
      if (/[;$]|--|\/\*/.test(expression)) return bad('a sql condition is one expression: no ";", "$" or comments');
      if (!balanced(expression)) return bad('a sql condition needs balanced parentheses and closed quotes');
      return { kind, expression };
    }
    default:
      return bad('unknown condition');
  }
}

// { conditions: [{ ...condition, label }], errors: [message] } from the text of a migration (comment
// lines only) or of its `.verify` file (`sidecar`: the leading `--` is optional).
export function parseConditions(text, { sidecar = false, source = 'migration' } = {}) {
  const conditions = [];
  const errors = [];
  for (const [i, line] of String(text).split('\n').entries()) {
    const m = DIRECTIVE.exec(line);
    if (!m || (!sidecar && !m[1])) continue;
    let body = (m[2] ?? '').trim();
    if (!/^sql\b/.test(body)) body = body.replace(/\s+--.*$/, '');
    const parsed = body ? parseCondition(body) : { error: 'empty ship:verify line' };
    if (parsed.error) errors.push(`${source} line ${i + 1}: ${parsed.error}`);
    else conditions.push({ ...parsed, label: body.replace(/\s+/g, ' ') });
  }
  return { conditions, errors };
}

const functionOid = (sig) => `to_regprocedure(${lit(sig)})`;

function existsSql({ kind, ref }) {
  if (kind === 'table') return `to_regclass(${lit(ref)}) is not null`;
  if (kind === 'function') return `${functionOid(ref)} is not null`;
  const [schema, table, column] = ref.split('.');
  return `exists (select 1 from pg_attribute where attrelid = to_regclass(${lit(`${schema}.${table}`)}) and attname = ${lit(column)} and attnum > 0 and not attisdropped)`;
}

const tablePrivilege = (role, ref, privileges) => `has_table_privilege(${lit(role)}, to_regclass(${lit(ref)}), ${lit(privileges.join(','))})`;
const anyColumnPrivilege = (role, ref) => `has_any_column_privilege(${lit(role)}, to_regclass(${lit(ref)}), ${lit(COLUMN_PRIVILEGES.join(','))})`;
const executes = (role, ref) => `has_function_privilege(${lit(role)}, ${functionOid(ref)}, 'EXECUTE')`;

// The boolean SQL expression for a condition. Where the thing a privilege check names does not
// exist the expression is null, which the callers read as "does not hold".
export function conditionExpression(c) {
  switch (c.kind) {
    case 'table': case 'column': case 'function':
      return existsSql(c);
    case 'absent':
      return `not (${existsSql(c.target)})`;
    case 'rls':
      return `coalesce((select relrowsecurity from pg_class where oid = to_regclass(${lit(c.ref)})), false)`;
    case 'no-access':
      return c.roles.map((r) => `not (${tablePrivilege(r, c.ref, TABLE_PRIVILEGES)} or ${anyColumnPrivilege(r, c.ref)})`).join(' and ');
    case 'access':
      return c.roles.flatMap((r) => c.privileges.map((p) => tablePrivilege(r, c.ref, [p]))).join(' and ');
    case 'no-execute':
      return c.roles.map((r) => `not ${executes(r, c.ref)}`).join(' and ');
    case 'execute':
      return c.roles.map((r) => executes(r, c.ref)).join(' and ');
    case 'sql':
      return c.expression;
    default:
      throw new Error(`unknown condition kind ${c.kind}`);
  }
}

// The same conditions as one jsonb array [{ label, ok }, …], for evaluating them inside the dry run.
export const conditionsJson = (conditions) => `jsonb_build_array(${conditions.map((c) => `jsonb_build_object('label', ${lit(c.label)}, 'ok', coalesce((${conditionExpression(c)}), false))`).join(', ')})`;

// Statements a transaction cannot contain: a dry run that wraps the file in one would fail for a
// reason that has nothing to do with the file being wrong.
const NON_TRANSACTIONAL = [
  [/\bconcurrently\b/i, 'CONCURRENTLY'],
  [/^\s*vacuum\b/im, 'VACUUM'],
  [/\balter\s+system\b/i, 'ALTER SYSTEM'],
  [/\bcreate\s+(database|tablespace)\b/i, 'CREATE DATABASE/TABLESPACE'],
];
export function nonTransactional(sql) {
  return NON_TRANSACTIONAL.find(([re]) => re.test(sql))?.[1] ?? null;
}

// The file's own top-level begin;/commit; lines and the PostgREST notify are dropped: the dry run
// owns the transaction.
const TX_LINE = /^\s*(begin|commit)\s*;\s*$/i;
const NOTIFY_LINE = /^\s*notify\s+pgrst\b.*;\s*$/i;
export const stripTransaction = (sql) => sql.split('\n').filter((l) => !TX_LINE.test(l) && !NOTIFY_LINE.test(l)).join('\n');

export const DRY_RUN_MARKER = 'DRY_RUN_OK';
export const PROBE_MARKER = 'CHECK_OK';

const marked = (marker, tag, conditions) => `raise exception '${marker} %', (${conditionsJson(conditions)})::text`;

// The dry run: the file runs as a string inside a DO block, which is inside the transaction that
// `begin;` opens and the exception at the end of the block always abandons. Run that way, nothing
// in the file can end the transaction early: a COMMIT, ROLLBACK or END anywhere in it, however it is
// written, is refused by Postgres ("EXECUTE of transaction commands is not implemented") and the
// dry run fails closed. The file's lock waits and run time are capped so that a dry run on
// production cannot queue every other query behind it. `tag` names the dollar quotes; no condition
// can contain a `$`, and the file must not contain the tag.
export function dryRunSql(migration, conditions, tag, { lockTimeout = '5s', statementTimeout = '120s' } = {}) {
  const body = stripTransaction(migration);
  if (body.includes(`$${tag}`)) throw new Error('the file contains the dry run\'s own quoting tag; run it again');
  return [
    'begin;',
    `set local lock_timeout = '${lockTimeout}';`,
    `set local statement_timeout = '${statementTimeout}';`,
    `do $${tag}$ begin execute $${tag}b$${body}$${tag}b$; ${marked(DRY_RUN_MARKER, tag, conditions)}; end $${tag}$;`,
  ].join('\n');
}

// One condition read in a read-only transaction that is abandoned like the dry run's: a `sql`
// condition that tries to write fails instead of persisting anything.
export const probeSql = (condition, tag) => `begin read only;\ndo $${tag}$ begin ${marked(PROBE_MARKER, tag, [condition])}; end $${tag}$;`;

// { passed, results } from the answer to a dry run or a probe. Only the first line of the message
// counts: a syntax error quotes the SQL we sent, which contains the marker's name.
export function parseMarked({ status, body }, marker = DRY_RUN_MARKER) {
  if (status < 300) return { passed: false, detail: 'the request reported success, so its final marker did not fire; treated as not verified' };
  const message = typeof body?.message === 'string' ? body.message : JSON.stringify(body);
  const first = message.split('\n')[0] ?? '';
  const m = new RegExp(`ERROR:\\s+(?:P0001:\\s+)?${marker}\\b`).exec(first);
  if (!m) return { passed: false, detail: message };
  try {
    const results = JSON.parse(first.slice(m.index + m[0].length).trim());
    if (Array.isArray(results) && results.every((r) => r && typeof r.label === 'string')) return { passed: true, results };
  } catch { /* falls through */ }
  return { passed: false, detail: `the answer could not be read: ${first}` };
}
export const parseDryRun = (answer) => parseMarked(answer, DRY_RUN_MARKER);
export const parseProbe = (answer) => parseMarked(answer, PROBE_MARKER);

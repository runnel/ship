import { createHash, randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { resolveMigrationArgs, withRepo } from './admin.mjs';
import { deployDeps } from './repo.mjs';
import { showFile } from './git.mjs';
import { addApplied, readClearances } from './state.mjs';
import { UsageError, firstLine } from './shared.mjs';
import { migrationPrefix } from './migrations.mjs';
import { timeOr } from './report.mjs';
import { SIDECAR_SUFFIX, conditionQuery, dryRunSql, nonTransactional, parseConditions, parseDryRun } from './postconditions.mjs';
import { OutcomeUnknown, failureText, supabase } from './supabase.mjs';

const PREVIEW_LINES = 40;

// One line typed at the terminal. An end of input (Ctrl-D, Ctrl-C, a closed terminal) is an empty
// answer, which never applies anything.
async function askOnTty(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await new Promise((resolve) => {
      rl.on('close', () => resolve(''));
      rl.question(prompt, resolve);
    });
  } finally {
    rl.close();
  }
}

export function migrateDeps() {
  return {
    ...deployDeps(),
    // Both ends must be a terminal: a pipe on either side is a script answering for the owner.
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: askOnTty,
    who: () => `${userInfo().username}@${hostname().split('.')[0]}`,
  };
}

// Reads every condition from the database, one read-only statement each. An answer that is not a
// plain "true" is a failure with its reason; `status` and `unreachable` let the caller tell a
// refused token or a dead connection from conditions that do not hold.
async function checkAll(db, conditions) {
  const results = [];
  for (const c of conditions) {
    try {
      const res = await db.query(conditionQuery(c));
      if (res.status >= 300) results.push({ label: c.label, ok: false, status: res.status, error: failureText(res) });
      else results.push({ label: c.label, ok: res.body?.[0]?.ok === true });
    } catch (e) {
      if (!(e instanceof OutcomeUnknown)) throw e;
      results.push({ label: c.label, ok: false, unreachable: true, error: e.message });
    }
  }
  return results;
}

const holdsText = (r) => (r.ok ? 'holds' : r.error ? `could not be checked: ${r.error}` : 'does not hold');
const prefixOrder = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

function planLines({ r, path, sql, sha256, apply, conditions, now, mode, dry, earlier, sidecarPath, hasSidecar }) {
  const lines = sql.split('\n').length - (sql.endsWith('\n') ? 1 : 0);
  const out = [
    `▸ migrations apply ${r.repo} ${r.mainBranch}@${r.mainSha.slice(0, 7)}`,
    `  file         ${path}  (${lines} lines, ${Buffer.byteLength(sql)} bytes, sha256 ${sha256.slice(0, 12)}) as merged on ${r.mainBranch}`,
    `  target       Supabase project ${apply.project}${apply.label ? ` (${apply.label})` : ''}`,
    `  dry run      ${dry.skipped ? `skipped: ${dry.skipped}` : mode === 'record' ? 'not needed: the database already satisfies every post-condition' : 'passed in one transaction, rolled back; the post-conditions held at its end'}`,
    `  will run     ${mode === 'record' ? 'nothing: the SQL is NOT run again; the proof is only recorded' : 'the file\'s SQL, as one request (one transaction)'}`,
    `  then         read the database again, check the ${conditions.length} post-condition(s) below, and only if all hold clear the file for deploy`,
    `  post-conditions (declared in ${path}${hasSidecar ? ` and ${sidecarPath}` : ''}):`,
    ...now.map((x) => `    ${x.ok ? '✓' : '·'} ${x.label}   [now: ${holdsText(x)}]`),
  ];
  if (mode === 'apply' && now.some((x) => x.ok)) {
    out.push(`! ${now.filter((x) => x.ok).length} of ${now.length} post-conditions already hold before the apply: the migration may be partly applied already, or only add to objects that exist`);
  }
  if (earlier.length > 0) {
    out.push(`! earlier migrations are not cleared yet: ${earlier.slice(0, 5).join(', ')}${earlier.length > 5 ? ` and ${earlier.length - 5} more` : ''} — they run in number order; apply those first unless this one does not depend on them`);
  }
  return out;
}

const sqlBlock = (sql, limit) => {
  const all = sql.replace(/\n$/, '').split('\n');
  const shown = limit ? all.slice(0, limit) : all;
  return [...shown.map((l) => `  | ${l}`), ...(shown.length < all.length ? [`  | (${all.length - shown.length} more line(s); type v at the prompt to see all of it)`] : [])];
};

export async function runMigrationsApply({ cwd, file, dryRunOnly = false, deps = {} }) {
  const d = { ...migrateDeps(), ...deps };
  if (!file) throw new UsageError('missing migration file name');
  // Before anything is read or sent: a command that changes production waits for a person.
  if (!dryRunOnly && !d.isInteractive()) {
    d.out('✗ ship migrations apply changes the production database, so it only runs where the owner can read the plan and type "yes": in their own terminal. Nothing was read or changed.');
    d.out('  To check a migration without applying it: ship migrations apply <file> --dry-run');
    return 2;
  }
  return withRepo({ cwd, d, lock: dryRunOnly ? null : 'migrations apply', cloud: false, fn: (ctx) => applyOne({ ...ctx, cwd, file, dryRunOnly, d }) });
}

async function applyOne({ r, config, cwd, file, dryRunOnly, d }) {
  const found = await resolveMigrationArgs({ cwd, args: [file], r, config, d });
  if (!found.files) return found.code;
  const path = found.files[0];
  const apply = config.migrations.apply;
  if (!apply) {
    d.out(`✗ ${r.repo}: ship.config.mjs has no migrations.apply, so ship does not know which database ${path} belongs to; apply it yourself and clear it with ship migrations ack`);
    return 2;
  }
  if (!path.endsWith('.sql')) {
    d.out(`✗ ${path}: ship migrations apply runs .sql files only`);
    return 2;
  }

  // The bytes that are hashed, shown, dry-run and applied are the ones on main at this commit.
  const sql = await showFile(r.mirror, r.mainSha, path);
  const sidecarPath = `${path.replace(/\.[^./]+$/, '')}${SIDECAR_SUFFIX}`;
  const sidecar = await showFile(r.mirror, r.mainSha, sidecarPath);
  const own = parseConditions(sql, { source: path });
  const next = sidecar === null ? { conditions: [], errors: [] } : parseConditions(sidecar, { sidecar: true, source: sidecarPath });
  const errors = [...own.errors, ...next.errors];
  if (errors.length > 0) {
    for (const e of errors) d.out(`✗ ${e}`);
    d.out('  Fix the declaration on main (see "Applying migrations" in the ship README). Nothing was changed.');
    return 2;
  }
  const seen = new Set();
  const conditions = [...own.conditions, ...next.conditions].filter((c) => !seen.has(c.label) && seen.add(c.label));
  if (conditions.length === 0) {
    d.out(`✗ ${path} declares no post-conditions, so nothing could prove it worked. Add \`-- ship:verify …\` lines to the migration, or put them in ${sidecarPath}, and merge that. A file that goes after the deploy is cleared with ship migrations ack instead. Nothing was changed.`);
    return 2;
  }

  const clearances = await readClearances(d.stateRoot, r.repo);
  const prior = clearances.get(path);
  if (prior?.kind === 'applied') {
    d.out(`✓ ${path}: already applied and proven (${prior.checks} post-conditions, ${prior.by ?? '?'}, ${timeOr(prior.at)}); nothing to do`);
    return 0;
  }

  let token;
  try {
    token = (await d.readCredentials({ file: config.credentials.file, map: { SUPABASE_ACCESS_TOKEN: apply.tokenKey } })).SUPABASE_ACCESS_TOKEN;
  } catch (e) {
    d.out(`✗ cannot read the Supabase token (${apply.tokenKey}) from the credentials file: ${firstLine(e.message)}`);
    return 1;
  }
  let db;
  try {
    db = supabase({ project: apply.project, token, fetchImpl: d.fetch });
  } catch (e) {
    d.out(`✗ ${firstLine(e.message)}`);
    return 1;
  }

  // What the database says before anything is done. A file whose conditions all hold already is
  // not run again, which also makes a re-run after a lost answer safe.
  const now = await checkAll(db, conditions);
  const refused = now.find((x) => x.status === 401 || x.status === 403);
  if (refused) {
    d.out(`✗ the Supabase API refused the token (${refused.error}); check ${apply.tokenKey} in the credentials file. Nothing was changed.`);
    return 1;
  }
  if (now.every((x) => x.unreachable)) {
    d.out(`✗ cannot reach the Supabase API (${now[0].error}). Nothing was changed.`);
    return 1;
  }
  const mode = now.every((x) => x.ok) ? 'record' : 'apply';

  let dry = { skipped: null };
  if (mode === 'apply') {
    const reason = !apply.dryRun ? 'turned off in ship.config.mjs' : nonTransactional(sql) ? `the file uses ${nonTransactional(sql)}, which cannot run inside a transaction` : null;
    if (reason) {
      dry = { skipped: reason };
    } else {
      let text;
      try {
        text = dryRunSql(sql, conditions, `d${randomBytes(4).toString('hex')}`);
      } catch (e) {
        d.out(`✗ ${e.message}. Nothing was changed.`);
        return 1;
      }
      let answer;
      try {
        answer = await db.query(text);
      } catch (e) {
        if (!(e instanceof OutcomeUnknown)) throw e;
        d.out(`✗ the dry run got no clear answer (${e.message}); it is a transaction that always rolls back, so nothing was committed.`);
        return 1;
      }
      const parsed = parseDryRun(answer);
      if (!parsed.passed) {
        d.out(`✗ dry run failed (rolled back; nothing changed): ${parsed.detail}`);
        return 1;
      }
      const unmet = conditions.filter((c) => parsed.results.find((x) => x.label === c.label)?.ok !== true);
      if (unmet.length > 0) {
        d.out('✗ the dry run ran the migration, but these post-conditions do not hold after it (rolled back; nothing changed):');
        for (const c of unmet) d.out(`    ✗ ${c.label}`);
        d.out('  Either the migration does not do what it declares, or the declaration is wrong.');
        return 1;
      }
    }
  }

  const cleared = new Set(clearances.keys());
  const mine = migrationPrefix(path);
  const earlier = mine === null ? [] : found.all.filter((f) => f !== path && !cleared.has(f) && migrationPrefix(f) !== null && prefixOrder(migrationPrefix(f), mine) < 0);
  const sha256 = createHash('sha256').update(sql).digest('hex');
  for (const l of planLines({ r, path, sql, sha256, apply, conditions, now, mode, dry, earlier, sidecarPath, hasSidecar: sidecar !== null })) d.out(l);

  if (dryRunOnly) {
    d.out(mode === 'record'
      ? '· dry run only: nothing applied, nothing recorded. Applying would only record the proof.'
      : '· dry run only: nothing applied, nothing recorded. The owner runs ship migrations apply (without --dry-run) in their terminal.');
    return 0;
  }

  if (mode === 'apply') for (const l of sqlBlock(sql, PREVIEW_LINES)) d.out(l);
  const prompt = `${mode === 'record' ? 'Record' : 'Apply'} ${path} ${mode === 'record' ? 'as proven' : `to ${apply.label ?? apply.project}`}? Type "yes" to go on, "v" to see all of the SQL, anything else cancels: `;
  for (;;) {
    const answer = String(await d.ask(prompt)).trim().toLowerCase();
    if (answer === 'v') {
      for (const l of sqlBlock(sql, 0)) d.out(l);
    } else if (answer === 'yes') {
      break;
    } else {
      d.out('✗ cancelled: only "yes" goes on. Nothing was changed.');
      return 1;
    }
  }

  let problem = null;
  if (mode === 'apply') {
    try {
      const res = await db.query(sql);
      if (res.status >= 300) problem = failureText(res);
    } catch (e) {
      if (!(e instanceof OutcomeUnknown)) throw e;
      problem = `${e.message}; the migration may or may not have run`;
    }
    d.out(problem ? `✗ apply: ${problem}` : `✓ applied ${path}`);
  }

  // The proof is the database, read after the fact, not the answer to the apply.
  const after = await checkAll(db, conditions);
  const failed = after.filter((x) => !x.ok);
  if (failed.length > 0) {
    if (after.every((x) => x.unreachable)) {
      d.out('✗ could not read the database afterwards, so the result is unproven and the file is NOT cleared. Run the same command again: it reads the database first and will not apply the SQL twice if it took effect.');
    } else if (problem && failed.length === after.length) {
      d.out('✗ none of the post-conditions holds, so the migration did not take effect and nothing was cleared. Running the command again is safe.');
    } else {
      d.out(`✗ ${problem ? 'the apply failed and the database does not satisfy every post-condition' : 'applied, but NOT cleared'}: these post-conditions do not hold:`);
      for (const x of failed) d.out(`    ✗ ${x.label}${x.error ? ` (${x.error})` : ''}`);
      d.out(`  Inspect the database. After a fix, run ship migrations apply ${path} again (it reads the database first), or decide by hand and use ship migrations ack.`);
    }
    return 1;
  }
  if (problem) d.out(`! the apply reported "${problem}", but every post-condition holds in the database now`);

  const by = d.who();
  const recorded = await addApplied(d.stateRoot, r.repo, { file: path, by, sha256, mainSha: r.mainSha, checks: conditions.length });
  d.out(`✓ ${conditions.length} post-condition(s) hold in the database`);
  d.out(`✓ cleared for deploy: ${path}${recorded ? ` (applied and proven; ${by}, sha256 ${sha256.slice(0, 12)})` : ' (already recorded)'}`);
  return 0;
}

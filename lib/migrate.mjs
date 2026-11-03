import { createHash, randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveMigrationArgs, withRepo } from './admin.mjs';
import { deployDeps } from './repo.mjs';
import { showFile } from './git.mjs';
import { ownerInfo } from './lock.mjs';
import { onInterrupt } from './interrupt.mjs';
import { addProof, isProof, openAttempts, readClearances, recordAttempt, settleAttempt, unsettledAttempt } from './state.mjs';
import { UsageError, everyMinute, firstLine, holderText, lockWithCleanup, repoKeyOf } from './shared.mjs';
import { byNumber, migrationPrefix } from './migrations.mjs';
import { timeOr } from './report.mjs';
import { SIDECAR_SUFFIX, dryRunSql, dryRunUnsafe, isSingleTransaction, nonTransactional, parseConditions, parseDryRun, parseProbe, probeSql } from './postconditions.mjs';
import { OutcomeUnknown, failureText, supabase } from './supabase.mjs';

const PREVIEW_LINES = 40;
const tag = () => `d${randomBytes(4).toString('hex')}`;

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
    // Both ends must be a terminal: a pipe on either side is a script answering for the owner. A
    // pseudo-terminal that a script allocates for itself is a terminal too; see docs/migrations.md.
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: askOnTty,
    who: () => `${userInfo().username}@${hostname().split('.')[0]}`,
  };
}

// Reads every condition from the database, one request each, each in a read-only transaction that
// is always abandoned (so even a `sql` condition that tries to write cannot persist anything). An
// answer that is not a plain "true" is a failure with its reason; `status` and `unreachable` let
// the caller tell a refused token or a dead connection from conditions that do not hold.
async function probeAll(db, conditions) {
  const results = [];
  for (const c of conditions) {
    try {
      const res = await db.query(probeSql(c, tag()));
      const parsed = parseProbe(res);
      if (parsed.passed) results.push({ label: c.label, ok: parsed.results.find((x) => x.label === c.label)?.ok === true });
      else results.push({ label: c.label, ok: false, status: res.status, error: firstLine(res.status === 401 || res.status === 403 ? failureText(res) : parsed.detail) });
    } catch (e) {
      if (!(e instanceof OutcomeUnknown)) throw e;
      results.push({ label: c.label, ok: false, unreachable: true, error: e.message });
    }
  }
  return results;
}

const holdsText = (r) => (r.ok ? 'holds' : r.error ? `could not be checked: ${r.error}` : 'does not hold');
const timeText = (iso) => timeOr(iso);

function planLines({ r, path, sql, sha256, apply, conditions, now, mode, kind, dry, atomic, earlier, unsettled, sidecarPath, hasSidecar }) {
  const lines = sql.split('\n').length - (sql.endsWith('\n') ? 1 : 0);
  const out = [
    `▸ migrations ${mode === 'record' ? 'record' : 'apply'} ${r.repo} ${r.mainBranch}@${r.mainSha.slice(0, 7)}`,
    `  file         ${path}  (${lines} lines, ${Buffer.byteLength(sql)} bytes, sha256 ${sha256.slice(0, 12)}) as merged on ${r.mainBranch}`,
    `  target       Supabase project ${apply.project}${apply.label ? ` (${apply.label})` : ''}`,
    `  dry run      ${dry.skipped ? `skipped: ${dry.skipped}` : mode === 'record' ? 'not needed: the SQL will not be run' : 'passed in one transaction, rolled back; the post-conditions held at its end'}`,
    `  will run     ${mode === 'record' ? 'nothing: the SQL is NOT run; the proof is only recorded' : atomic ? 'the file\'s SQL, as one request (one transaction)' : 'the file\'s SQL, as one request'}`,
    `  then         ${mode === 'record' ? 'record' : 'read the database again, check'} the ${conditions.length} post-condition(s) below${mode === 'record' ? '' : ', and only if all hold clear the file for deploy'}`,
    `  post-conditions (declared in ${path}${hasSidecar ? ` and ${sidecarPath}` : ''}):`,
    ...now.map((x) => `    ${x.ok ? '✓' : '·'} ${x.label}   [now: ${holdsText(x)}]`),
  ];
  if (unsettled) {
    out.push(`! this exact file was sent to the database before (${unsettled.by}, ${timeText(unsettled.at)}) and no result was ever recorded: that request may still be running on the server, or it may have committed`);
  }
  if (mode === 'record' && kind === 'verified') {
    out.push('! ship did not run this file and never saw these conditions fail. They hold, which does not prove that this file made them hold; record it only if you know it was applied.');
  }
  if (mode === 'apply' && !atomic) {
    out.push('! this file is NOT one transaction (its own BEGIN/COMMIT, a statement that cannot run in a transaction, or no dry run): if it fails, part of it may have committed, and a failure is never reported as "nothing took effect"');
  }
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

// `planOnly` is `ship migrations plan`: everything up to and including the dry run, changing
// nothing and asking nothing, so it needs no terminal. Without it the command applies.
export async function runMigrationsApply({ cwd, file, planOnly = false, deps = {} }) {
  const d = { ...migrateDeps(), ...deps };
  if (!file) throw new UsageError('missing migration file name');
  // Before anything is read or sent: a command that changes production waits for a person.
  if (!planOnly && !d.isInteractive()) {
    d.out('✗ ship migrations apply changes the production database, so it only runs where the owner can read the plan and type the answer: in their own terminal. Nothing was read or changed.');
    d.out('  To check a migration without applying it: ship migrations plan <file>');
    return 2;
  }
  return withRepo({ cwd, d, lock: null, cloud: false, fn: (ctx) => applyOne({ ...ctx, cwd, file, planOnly, d }) });
}

async function applyOne({ r, config, cwd, file, planOnly, d }) {
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
    d.out('  Fix the declaration on main (see "Applying migrations" in docs/migrations.md of ship). Nothing was changed.');
    return 2;
  }
  const seen = new Set();
  const conditions = [...own.conditions, ...next.conditions].filter((c) => !seen.has(c.label) && seen.add(c.label));
  if (conditions.length === 0) {
    d.out(`✗ ${path} declares no post-conditions, so nothing could prove it worked. Add \`-- ship:verify …\` lines to the migration, or put them in ${sidecarPath}, and merge that. A file that goes after the deploy is cleared with ship migrations ack instead. Nothing was changed.`);
    return 2;
  }

  const sha256 = createHash('sha256').update(sql).digest('hex');
  const clearances = await readClearances(d.stateRoot, r.repo);
  const prior = clearances.get(path);
  if (isProof(prior)) {
    d.out(`✓ ${path}: already ${prior.kind === 'applied' ? 'applied and proven' : 'found in place and recorded'} (${prior.checks} post-conditions, ${prior.by ?? '?'}, ${timeOr(prior.at)}); nothing to do`);
    if (prior.sha256 && prior.sha256 !== sha256) d.out(`! the file on main has changed since: it was sha256 ${prior.sha256.slice(0, 12)}, it is ${sha256.slice(0, 12)} now. Nothing was applied; a changed migration needs a new number.`);
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
  const by = d.who();

  // What the database says before anything is done. Every condition must have been read: a
  // probe that failed to answer is not "does not hold", and a file is never applied on that.
  const now = await probeAll(db, conditions);
  const refused = now.find((x) => x.status === 401 || x.status === 403);
  if (refused) {
    d.out(`✗ the Supabase API refused the token (${refused.error}); check ${apply.tokenKey} in the credentials file. Nothing was changed.`);
    return 1;
  }
  if (now.some((x) => x.unreachable)) {
    d.out(`✗ could not read ${now.filter((x) => x.unreachable).length} of ${now.length} post-conditions from the Supabase API (${now.find((x) => x.unreachable).error}). Nothing was changed.`);
    return 1;
  }
  const unsettled = await unsettledAttempt(d.stateRoot, r.repo, path, sha256);
  const allHold = now.every((x) => x.ok);
  // Nothing is run when the conditions already hold. If ship itself sent this exact file earlier
  // and never got an answer, that is the lost-answer case and the proof is a real `applied`;
  // otherwise ship cannot say who made them hold, and it records `verified` instead.
  const mode = allHold ? 'record' : 'apply';
  const kind = unsettled ? 'applied' : 'verified';
  const word = mode === 'record' ? (unsettled ? 'yes' : 'record') : (unsettled ? 'apply again' : 'yes');

  let dry = { skipped: null };
  if (mode === 'apply') {
    const reason = !apply.dryRun ? 'turned off in ship.config.mjs'
      : nonTransactional(sql) ? `the file uses ${nonTransactional(sql)}, which cannot run inside a transaction`
        : dryRunUnsafe(sql) ? `the file uses ${dryRunUnsafe(sql)}` : null;
    if (reason) {
      dry = { skipped: reason };
    } else {
      let text;
      try {
        text = dryRunSql(sql, conditions, tag());
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
        // Without a terminal the text goes into a session's transcript, and Postgres errors can quote row data.
        d.out(`✗ dry run failed (rolled back; nothing changed): ${planOnly ? firstLine(parsed.detail) : parsed.detail}`);
        if (/transaction commands/.test(parsed.detail)) d.out('  The file has its own COMMIT, ROLLBACK or END; the dry run refuses those, because they would end its transaction. Remove them (a lone begin; / commit; line is dropped for you).');
        if (/SELECT .*INTO .*not implemented/i.test(parsed.detail)) d.out('  The file has SELECT … INTO, which the dry run cannot run as a string; write CREATE TABLE … AS SELECT instead.');
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

  // Only a file that is one transaction AND was dry-run through (so no stray END or COMMIT is in it)
  // can be said to have committed nothing when Postgres refuses it.
  const atomic = mode === 'apply' && dry.skipped === null && isSingleTransaction(sql);
  const cleared = new Set(clearances.keys());
  const mine = migrationPrefix(path);
  const earlier = mine === null ? [] : found.all.filter((f) => f !== path && !cleared.has(f) && migrationPrefix(f) !== null && byNumber(f, path) < 0);
  for (const l of planLines({ r, path, sql, sha256, apply, conditions, now, mode, kind, dry, atomic, earlier, unsettled, sidecarPath, hasSidecar: sidecar !== null })) d.out(l);

  if (planOnly) {
    d.out('· plan only: nothing applied, nothing recorded. The owner runs ship migrations apply in their terminal.');
    return 0;
  }

  for (const l of sqlBlock(sql, PREVIEW_LINES)) d.out(l);
  const prompt = `${mode === 'record' ? `Record ${path} as ${kind === 'applied' ? 'applied' : 'found in place'}` : `Apply ${path} to ${apply.label ?? apply.project}`}? Type "${word}" to go on, "v" to see all of the SQL, anything else cancels: `;
  for (;;) {
    const answer = String(await d.ask(prompt)).trim().toLowerCase();
    if (answer === 'v') {
      for (const l of sqlBlock(sql, 0)) d.out(l);
    } else if (answer === word) {
      break;
    } else {
      d.out(`✗ cancelled: only "${word}" goes on. Nothing was changed.`);
      return 1;
    }
  }

  // The deploy lock is taken only now, so a prompt left open overnight blocks nobody. Once it is
  // held the database is read again: what the owner confirmed must still be true.
  const release = await lockWithCleanup(join(d.tmpRoot, 'locks', `deploy-${repoKeyOf(r.repo)}`), await ownerInfo({ repo: r.repo, command: 'migrations apply' }), {
    pollMs: d.pollMs,
    onWait: everyMinute((h) => d.out(`… waiting for the deploy lock: ${holderText(h)}`)),
  });
  try {
    if (isProof((await readClearances(d.stateRoot, r.repo)).get(path))) {
      d.out(`✗ ${path} was recorded while you were deciding; nothing was changed.`);
      return 1;
    }
    const openNow = await unsettledAttempt(d.stateRoot, r.repo, path, sha256);
    if ((openNow?.id ?? null) !== (unsettled?.id ?? null)) {
      d.out('✗ another run sent or settled this file while you were deciding (see the attempt in the ledger); what you confirmed is no longer what would happen. Nothing was changed; run the command again.');
      return 1;
    }
    const again = await probeAll(db, conditions);
    if (again.some((x) => x.unreachable) || again.every((x) => x.ok) !== allHold || again.some((x, i) => x.ok !== now[i].ok)) {
      d.out('✗ the database changed (or could not be read) between the plan and your answer, so what you confirmed is no longer what would happen. Nothing was changed; run the command again.');
      return 1;
    }
    return await act({ d, r, db, path, sql, sha256, conditions, mode, kind, by, now, atomic });
  } finally {
    await release();
  }
}

async function act({ d, r, db, path, sql, sha256, conditions, mode, kind, by, now, atomic }) {
  const settle = (id, outcome) => settleAttempt(d.stateRoot, r.repo, { file: path, sha256, by, outcome, id });
  let sent = null; // null: nothing sent; else { ok } | { refused } | { notSent } | { unknown } (no answer)
  let attemptId = null;
  if (mode === 'apply') {
    attemptId = await recordAttempt(d.stateRoot, r.repo, { file: path, sha256, by });
    // An interrupt cannot stop the statement on the server: say so, then let the unwind go on.
    const off = onInterrupt(() => d.out(`! interrupted while the apply request was in flight: ${path} may still be running on the server. Do not run it again until you have looked (select pid, state, query_start, left(query, 80) from pg_stat_activity where state <> 'idle'); a re-run of the same file will warn.`));
    try {
      const res = await db.query(sql);
      sent = res.status >= 300 ? { refused: failureText(res) } : { ok: true };
    } catch (e) {
      if (!(e instanceof OutcomeUnknown)) throw e;
      sent = e.notSent ? { notSent: e.message } : { unknown: e.message };
    } finally {
      off();
    }
    // An attempt is settled by a refusal of a file that is one transaction, by a request that never
    // left this machine, or by a recorded proof. An answered but unproven request, and a refusal of a
    // file that is not one transaction, stay open: they are what to look at before sending it again.
    if (sent.notSent) await settle(attemptId, 'not-sent');
    else if (sent.refused && atomic) await settle(attemptId, 'refused');
    d.out(sent.ok ? `✓ applied ${path}`
      : sent.refused ? `✗ apply refused: ${sent.refused}`
        : sent.notSent ? `✗ the request never left this machine (${sent.notSent}): nothing was sent and nothing was changed. Run the command again when the connection works.`
          : `✗ apply: ${sent.unknown}; the migration may or may not have run`);
    if (sent.notSent) return 1;
  }

  // The proof is the database, read after the fact, not the answer to the apply.
  const after = await probeAll(db, conditions);
  const failed = after.filter((x) => !x.ok);
  const unreadable = after.some((x) => x.unreachable);
  const changed = after.some((x, i) => x.ok !== now[i].ok);
  if (mode === 'record' && failed.length > 0) {
    d.out('✗ the conditions no longer hold, so nothing was recorded:');
    for (const x of failed) d.out(`    ✗ ${x.label}${x.error ? ` (${x.error})` : ''}`);
    return 1;
  }
  if (sent?.refused && !atomic) {
    d.out('✗ Postgres refused the file, and it is not a single transaction, so part of it may have committed. Nothing was cleared. Look at the database before running it again; the next run will warn about this attempt and needs "apply again".');
    for (const x of failed) d.out(`    ✗ ${x.label}${x.error ? ` (${x.error})` : ''}`);
    return 1;
  }
  if (sent?.refused && !unreadable && !changed) {
    d.out('✗ Postgres refused the file and the database is as it was before: nothing took effect and nothing was cleared. Running the command again is safe.');
    return 1;
  }
  if (sent?.refused && failed.length === 0) {
    d.out('✗ Postgres refused the file, yet every post-condition holds. Either someone changed the database in the meantime or the file commits part of itself. Not recorded; inspect the database.');
    return 1;
  }
  if (failed.length > 0) {
    if (sent?.unknown) {
      d.out(`✗ no answer to the apply, and the post-conditions do not all hold${unreadable ? ' (some could not be read)' : ''}: the statement may still be running or may yet commit. Do not run it again for now: look at pg_stat_activity first. The next run of this command will warn about this attempt. Nothing was cleared.`);
    } else if (unreadable) {
      d.out('✗ could not read the database afterwards, so the result is unproven and the file is NOT cleared. Run the same command again: it reads the database first and will not run the SQL twice if it took effect.');
    } else {
      d.out(`✗ ${sent?.refused ? 'Postgres refused the file and the database is partly changed' : 'applied, but NOT cleared'}: these post-conditions do not hold:`);
      for (const x of failed) d.out(`    ✗ ${x.label}${x.error ? ` (${x.error})` : ''}`);
      d.out(`  Inspect the database. After a fix, run ship migrations apply ${path} again (it reads the database first), or decide by hand and use ship migrations ack.`);
    }
    return 1;
  }
  if (sent?.unknown) d.out(`! the apply got no answer (${sent.unknown}), but every post-condition holds in the database now`);

  const recorded = await addProof(d.stateRoot, r.repo, { kind: mode === 'record' ? kind : 'applied', file: path, by, sha256, mainSha: r.mainSha, checks: conditions.length });
  // A proof makes every open attempt at this content moot.
  for (const open of await openAttempts(d.stateRoot, r.repo, path, sha256)) await settle(open.id, 'proven');
  d.out(`✓ ${conditions.length} post-condition(s) hold in the database`);
  d.out(`✓ cleared for deploy: ${path}${recorded ? ` (${mode === 'record' && kind === 'verified' ? 'found in place, not run by ship' : 'applied and proven'}; ${by}, sha256 ${sha256.slice(0, 12)})` : ' (already recorded)'}`);
  return 0;
}

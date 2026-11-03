# Applying migrations

`ship migrations apply` and `plan`: applying a migration, proving it from the database, and clearing it for deploy. Back to the [README](../README.md).

`ship migrations ack` is the owner's word that a file may be deployed past; it checks nothing, so an
acked file can be missing from the database. `ship migrations apply <file>` replaces the word with a
proof, for a repository with `migrations.apply`. It reads the file as merged on main (the bytes that
are hashed, shown, dry-run and applied are those of one commit) and then:

1. refuses unless standard input and output are a terminal, before it reads or sends anything;
2. reads each declared post-condition from the database, one request each, in a read-only
   transaction that is always abandoned. Any condition that cannot be read stops the run: a probe
   that did not answer is not "does not hold";
3. if every post-condition already holds, the SQL is **not** run. Ship tells two cases apart. If it
   sent this exact file before and never recorded a result (a lost answer), the owner types `yes`
   and the proof is recorded as `applied`. Otherwise it cannot say who made the conditions hold, so
   it shows the SQL, warns, asks the owner to type `record`, and records `verified` instead;
4. otherwise runs the file and the conditions as a dry run (below); a file that fails, or whose
   post-conditions do not hold at its end, stops here. The dry run is skipped, and the plan says
   why, for a file with `CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM` or `CREATE DATABASE` (they cannot
   run in a transaction) and for one with effects that outlive a rollback: `setval`, a
   session-level advisory lock, `dblink`, `pg_terminate_backend`, or its own `lock_timeout` /
   `statement_timeout` (a lone `SET` of those is simply dropped from the dry run). `nextval` leaves
   a gap in a sequence, which is harmless;
5. prints the plan (commit, file, size and hash, project, post-conditions with their state now,
   earlier migrations not yet cleared, the SQL) and waits. The typed word goes on (`yes`; `apply
   again` when an earlier send of this file has no recorded result), `v` shows all of the SQL,
   anything else cancels;
6. takes the repository's deploy lock (only now, so an open prompt blocks nobody), reads the
   database and the attempts again and cancels if anything differs from the plan (a second terminal
   that sent the file meanwhile included), writes an *attempt* line with an id, and sends the file
   as one request;
7. reads the database again: the post-conditions, not the answer to the apply, decide. All hold: the
   file is cleared for deploy and the ledger line records `applied`, who (`user@host`), when, the
   file's sha256, main's commit and the number of post-conditions; the attempt is settled. One
   fails: the failed ones are named and nothing is cleared.

What the outcome of the request means:

- **Postgres refused it** (an HTTP error carrying the database's own error), for a file that is one
  transaction and was dry-run: nothing committed, the attempt is settled, and re-running is safe.
  If every condition holds anyway, ship does not record: someone else changed the database, or the
  file commits part of itself. A file that is **not** one transaction (several `begin;`/`commit;`
  blocks, `savepoint`, `CONCURRENTLY`, or no dry run) may have committed part of itself: the plan
  says so, a refusal keeps the attempt open and is never called safe.
- **Never sent** (no address, connection refused, a certificate that is not accepted): the attempt
  is settled and nothing is open.
- **No answer** (a timeout, a gateway error, Ctrl-C): the statement may still be running or may yet
  commit, so ship never says a re-run is safe. The attempt stays open; the next run warns about it,
  and applying that file again needs the typed answer `apply again`. If the conditions hold when
  the database is read, the file is recorded as `applied` (the attempt is the evidence).
- **Answered, but a condition fails**: committed and not cleared; the attempt stays open.

The dry run sends `begin;` and then runs the file as a string (`execute`) inside a `DO` block that
ends with an exception carrying the post-condition answers, so nothing can commit. A COMMIT,
ROLLBACK or END inside the file does not end the transaction: Postgres refuses it, the dry run
fails and says why. The file's own lone `begin;`/`commit;` lines and its `notify pgrst` are dropped.
The dry run takes the file's real locks while it runs, which is why `lock_timeout` (5 s) and
`statement_timeout` (120 s) are set for it.

`ship status` tells the clearances apart (`proof: N applied and proven by ship, M found in place and
recorded, K acked only`, and the newest of each); `ship deploy` treats every kind as cleared. A file
already proven is not touched again, and if the file on main has changed since, ship says so. Keep
`ack` for a file that goes after the deploy.

**Post-conditions** are declared in the migration as comment lines, or one per line in a
`<name>.verify` file beside it (the `--` is optional there). A file that declares none cannot be
applied by ship. Names are lower-case and schema-qualified. A trailing `-- note` is ignored on every
form but `sql`.

```sql
-- ship:verify table public.things
-- ship:verify column public.things.owner_id
-- ship:verify function public.record_scan(uuid, text)
-- ship:verify rls public.things
-- ship:verify no-access anon,authenticated public.things
-- ship:verify no-execute anon public.record_scan(uuid, text)
-- ship:verify access service_role select,insert public.things
-- ship:verify execute service_role public.record_scan(uuid, text)
-- ship:verify absent table public.old_things
-- ship:verify sql (select count(*) from public.things) = 0
```

`table` means a relation (a table or a view) exists; `rls` that row level security is enabled;
`no-access` that none of the roles holds any privilege on the relation or on any of its columns;
`absent` also takes `column` and `function`. Each form becomes one boolean; an object that does not
exist reads as "does not hold". A `sql` condition is a single balanced expression (no `;`, `$` or
comments) and runs read-only: a condition that tries to write fails instead of persisting.

`ship migrations plan` stops after step 4 and prints the plan: no terminal needed, nothing applied
or recorded, so a session can check a migration and its declarations before asking the owner to
apply it. Without a terminal only the first line of a Postgres error is printed, since later lines
can quote row data.

What the terminal check does and does not do: it stops a script that merely runs the command or
pipes an answer into it. It does **not** stop a process that allocates a pseudo-terminal of its own
(`script`, `expect`, a language's `pty` module) or one that is handed the owner's keystrokes; to
those it is only a speed bump. The boundary is the permission rule: allow `ship migrations plan` for
agents, never `ship migrations apply`. The ledger is a file in ship's state directory on this
machine, next to the acks (attempts are in a sibling file, and clear nothing), not a table in the
database.

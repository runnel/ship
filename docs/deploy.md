# Deploy (Cloudflare Workers)

`ship deploy` and its commands: configuration, the live commit, adopting, holds, rollbacks and exit codes. Back to the [README](../README.md).

`ship deploy` deploys what changed on the main branch since it went live — per deployable, in
dependency order, from a fresh worktree of the main branch, on your machine.

| Command | What it does | Allowlist for an agent |
|---|---|---|
| `ship deploy [<name>…] [--dry-run]` | Deploy every deployable (or the named ones) whose files changed since its live commit. `--dry-run` runs the gates, setup, checks, builds and `preDeploy` steps, uploads nothing, and exits 0 when all of that passed, and then its last line says that nothing was uploaded (with nothing pending, the usual "live" line prints instead). | yes |
| `ship deploy --redeploy <name>…` | Deploy the named deployables even when nothing changed (same code again). The names are required. | yes |
| `ship status` | Per deployable: live commit, pending commits, holds, an undeployed newest version; migrations not cleared. Read-only. | yes |
| `ship adopt --plan` | Read-only: per Worker, the main commit at the time its live code was uploaded, and the adopt commands for it. Skips Workers whose live commit is already known, in the repository and on main, and never guesses for a version made by `wrangler versions secret put`. | no |
| `ship adopt --at <sha> (<name>… \| --all)` | Record that each Worker's current version was built from `<sha>` (7–40 hex digits, a commit on main): a new Cloudflare deployment of that version at 100%, annotated `sha:<sha> adopt`. A split deployment is refused, and so is a `<sha>` that would hide pending commits of a Worker whose live commit is known. Also records every migration file present at `<sha>` as cleared. See [Adopting](#adopting). | no |
| `ship rollback <name>` | Show what a rollback would do and print the command for it. Read-only. | no |
| `ship rollback <name> --to <version> [--revert-secrets]` | Set a hold, promote an earlier version (its id: at least 6 hex digits, the first 8 are enough; any version among the last 200 whose commit is known) and probe it. `--revert-secrets` sends the deployment with `?force=true`, so the rollback also undoes secret changes made since that version; without it Cloudflare refuses (error 10220). See [Rollbacks](#rollbacks). | no |
| `ship unhold <name>` | Clear a hold. It works from the state directory alone (offline), so it cannot know the config's names: a name without a hold is reported as "no hold" (with the names that are held) and exits 0. | no |
| `ship migrations plan <file>` | Read the declared post-conditions from the database and run the file and them inside a transaction that is always rolled back; print the plan. Changes nothing, needs no terminal. A dry run holds the file's real locks on the database for its duration (capped at 5 s waiting, 120 s running). See [Applying migrations](migrations.md#applying-migrations). | yes |
| `ship migrations apply <file>` | Show the plan, wait for a typed answer, apply the file as merged on main, check its declared post-conditions in the database, and only then clear it for deploy, recording who applied it. Refuses without a terminal. See [Applying migrations](migrations.md#applying-migrations). | no |
| `ship migrations ack <file>…` | Mark migration files on main as cleared for deploy, without applying or checking anything (a file that goes after the deploy, or one applied some other way). A file may be named as a repository path, a path from the current directory, a path from another checkout, or a bare file name; see [Clearing migrations](#clearing-migrations). | no |

The commands that are not allowlisted are the owner's: the permission prompt is the confirmation.
ship asks interactively in one place only: `ship migrations apply` waits for a
typed answer, and refuses to run when standard input or output is not a terminal. Every usage error (an unknown flag, an extra or missing
argument, a malformed value such as `--at zz`, `--redeploy` without names, an unknown deployable) prints
`✗ ship <command>: <what is wrong>` on stderr and the command's usage line on stdout, and exits 2.
A refusal that needs the repository (a commit that is not on main, a version that does not exist)
says so in its own words and also exits 2.

## Configuration

```js
export default {
  repo: 'acme/app',
  checks: [
    { name: 'db', lane: 'light', onDeploy: true, paths: ['db/**'], steps: ['bash scripts/replay.sh'] },
  ],
  deploySetup: [{ run: 'npm ci', cwd: 'web' }],   // once per deploy, before the onDeploy checks
  deployables: [
    {
      name: 'web', worker: 'example-app', cwd: 'web', paths: ['web/**'], ignore: ['web/docs/**'],
      mode: 'versioned',                        // upload → preview probes → promote
      build: 'npm run build', env: { NODE_OPTIONS: '--max-old-space-size=4096' },
      envFiles: [{ from: '/abs/path/to/.env.production', to: 'web/.env.production' }],
      bundleCheck: { file: 'dist/worker.js', pattern: 'https://[a-z0-9]+\\.example\\.com', allow: ['https://api.example.com'] },
      probes: [{ path: '/health', status: 200 }, { path: '/admin', status: 401 }],
      liveHost: 'https://app.example.com', warmup: ['/'],
      liveMarker: { path: '/', file: 'dist/BUILD_ID' },
    },
    {
      name: 'cron', worker: 'example-cron', cwd: 'workers/cron', paths: ['workers/cron/**'],
      mode: 'direct',                           // wrangler deploy: cron triggers, routes, Durable Objects
      wrangler: 'web/node_modules/.bin/wrangler',
      probes: [{ path: '/', status: 403 }], liveHost: 'https://example-cron.example.workers.dev',
      after: ['web'],
    },
  ],
  migrations: { paths: ['db/migrations/*.sql'],
                apply: { adapter: 'supabase', project: 'abcdefghijklmnopqrst', label: 'production' } }, // optional
  requires: [{ repo: 'acme/api', deployable: 'api' }], // must be live at its main branch first
  credentials: { file: '/abs/path/to/credentials.env',
                 map: { CLOUDFLARE_API_TOKEN: 'CF_TOKEN', CLOUDFLARE_ACCOUNT_ID: 'CF_ACCOUNT' } },
};
```

Deployable keys (defaults in brackets): `name`, `worker` (the Cloudflare script name; the `name` in
the wrangler config must be the same, or the deploy is refused before it builds), `mode`
(`versioned` | `direct`), `paths`, `cwd` [`.`], `ignore` [none], `install`, `build`, `env`,
`envFiles` (copied in after `install` and before `build`, removed after it), `bundleCheck` (at least
one match, every match allowed), `wrangler` [`<cwd>/node_modules/.bin/wrangler`, relative to the
repository root — must be the repo's locked copy], `wranglerConfig` [wrangler.json, wrangler.jsonc or
wrangler.toml in `cwd`], `preDeploy`, `probes` (required for `versioned`; each `{ path, status,
method, followRedirects }`, method `GET` [default], `HEAD` or `POST`, redirects not followed unless
`followRedirects`), `liveHost` (`https://host`, required whenever there are `probes`, checked
whenever present), `warmup`, `liveMarker` (versioned only; `file` is read right after the build and
must not be empty), `after`, `timeoutMin` [30], `uploadTimeoutMin` [10]. A `direct` deployable without `probes` gets no live
probes, only the check that its new version is the current one. A deployable's relative imports must
stay inside its `paths` and must not reach a file its `ignore` or the repo's `docsOnly` lists (a
change there would never make it pending): `ship check` and `ship deploy` both enforce it, so a
change to an imported file is never missed.

`migrations.apply` is optional and turns on `ship migrations apply`: `adapter` (`supabase`, the only
one), `project` (the project reference), `label` [none; shown in the plan and the prompt],
`tokenKey` [`SUPABASE_ACCESS_TOKEN`, the key to read from `credentials.file`] and `dryRun` [true].
The token is read from `credentials.file` only when a migration is planned or applied, by that one
key. A config that also lists it in `credentials.map` (which would hand it to every deploy step) is
refused. `ship.config.mjs` is read from main, so a
pull request cannot point the command at another database.

`credentials.file` is parsed (`KEY=value` lines), never sourced. `map` names the environment
variables wrangler reads (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are required) and the
file keys they come from; only those reach wrangler, and no build or check step of ship sees them.
A `[build] command` in a wrangler config runs inside `wrangler deploy` (or `versions upload`), so it
does see them. `requires` loads the other repository's `ship.config.mjs` from its main branch and
evaluates it in ship's own process: list only repositories you trust.

A config of the wrong shape (a `probes` or `preDeploy` that is not an array, a `checks` entry that
is not an object, a malformed `liveHost`) is refused with a message naming the key, not a crash.
Unknown keys are refused at every level of the file, not only at the top: in a check and its
`{ run, env }` steps, a deployable, a probe, a `deploySetup` or `preDeploy` step (`run`, `env`,
`cwd`), an `envFiles` entry (`from`, `to`), `bundleCheck` (`file`, `pattern`, `allow`), `liveMarker`
(`path`, `file`), `migrations` (`paths`, `apply`; and inside `apply`: `adapter`, `project`, `label`, `tokenKey`, `dryRun`), a `requires` entry (`repo`, `deployable`) and `credentials`
(`file`, `map`). `liveHost` is checked whenever it is present, also on a deployable without `probes`.

## The live commit

Every version and deployment ship makes carries the message `sha:<40 hex> …`, sha first
(Cloudflare cuts messages at 1,000 characters; `wrangler deploy` keeps 50 on the deployment). The
live commit is read from the current deployment: its own message, else the code of its version (a
deployment stamp of that version, the version's message, or — for a version Cloudflare made when a
secret was changed with `wrangler secret put` — the version before it). A split deployment, a
version made outside ship (including `wrangler versions secret put`, which copies the newest
version whether or not it is deployed) or history beyond the last 50 deployments / 200 versions is
**live unknown**: that deployable (and what comes after it) is not deployed until `ship adopt`.

## Adopting

`ship adopt --plan` suggests, per Worker, the main commit at the time its live code was uploaded
(adopting it makes every later commit that touches the deployable pending). `ship adopt --at <sha>`
stamps the current version as built from `<sha>`. A `<sha>` later than the code that is really live
hides the commits in between from `ship deploy`; for a Worker whose live commit is already known
that is refused (exit 1, the commits named, the migrations not recorded), while the same commit or an
older one is fine.

## What `ship deploy` does

1. Takes the repo's deploy lock (a second deploy joins it or waits, see [One deploy at a
   time](#one-deploy-at-a-time-and-a-fresh-main)), fetches the main branch, opens a fresh worktree
   at its tip and loads `ship.config.mjs` from it.
2. Per deployable: holds, import containment, the live commit (must be an ancestor of main), and
   whether any of its files changed since (minus `ignore` and `docsOnly`). Nothing pending: done.
   A pending deployable whose live commit is known gets `· ships 3 commit(s): #41 #43 + 1 without a
   PR number` at the end of its plan line (a number is read from a trailing `(#n)` in the commit
   subject). A first deploy, and a `--redeploy` of code with no new commits, show none. The lines are
   printed before the migration gate, setup, checks and builds, so a deploy says what it will ship
   before it runs anything.
3. Migration files on main that are not cleared → stop. `requires` not live → stop.
4. `deploySetup`, which waits for the heavy lane: when the slot arrives the deploy reads main
   again and may move to it (below), and prints `▸ building main@<sha> · ships …`, the final list
   of what it builds. Then every `onDeploy` check group; red → stop.
5. Each pending deployable, dependencies first. Both modes refuse, before building, a wrangler
   config whose `name` is not the deployable's `worker`. `versioned`: refuses when a setting only
   `wrangler deploy` applies differs (crons, routes, workers.dev and preview URLs, Durable Object
   migrations, observability, logpush, tail consumers); builds; `wrangler versions upload`; probes
   the preview URL; checks that live has not moved and that the newest version is ours; promotes.
   `direct`: builds; checks that live has not moved; `wrangler deploy`. Both: the current version
   must be ours, live probes (a probe that gets no answer reports the error and its cause, such as
   `fetch failed (ECONNREFUSED)`), then (versioned, with a `liveMarker`) a check that the live host
   serves this build — a warning only. Right after the promote Cloudflare's deployment list can
   still show the version that was live before, or none; while it does, ship reads it again for up
   to 30 s. Any other version is somebody else's deploy and sets a hold at once, and so does a
   deployment that splits traffic between versions (even with ours among them) and a version that
   is still not ours when the 30 s are over. The first deploy of a versioned deployable
   is the owner's: the Worker must exist and its preview URLs must be on.
6. A failing live probe sets a hold and, when it can, rolls back to the previous version (see
   [Rollbacks](#rollbacks)). A deployable that fails or is held stops the deployables that come
   `after` it; the others go on. Naming a deployable whose `after` dependency has pending changes
   skips it too, unless the dependency is named as well.

## One deploy at a time, and a fresh main

Sessions that merge a pull request each run `ship deploy`, and each build takes the machine's
heavy slot. So deploys of one repository collapse into one:

- **A late caller joins.** A `ship deploy` that finds another one of the same repository that has
  not yet fixed what it ships (it is waiting for the deploy lock, or for its slot) does not wait
  for the lock to deploy what is left. It prints `↪ …: a deploy started at 17:21 (pid 4711) has not
  begun building; this one joins it, with the same result`, then the other deploy's output, line
  for line, and exits with its status. It joins only a deploy that was asked for the same
  deployables and the same `--redeploy`; a `--dry-run` neither joins nor is joined. If the deploy it
  joined ends before it began building (it stopped at a migration, found nothing pending, was
  interrupted), the caller says so and deploys for itself.
- **Once the deploy has its slot, main is read again.** What a deploy ships is decided when it gets
  the heavy lane for its setup: waiting for that lane can take a long time, and main goes on
  meanwhile. From that moment no one joins it; a `ship deploy` that arrives later waits for the
  lock and deploys what is still pending, as before. The deploy then fetches main. If it moved
  and the new head is safe, the deploy moves to it: it prints `↻ main moved while the deploy
  waited: 9607018 → 3f2a1b9 (5 new commit(s))`, makes its plan again (the plan lines of the
  later head follow, the earlier ones stay above) and builds the later head, setup and deploy-time
  checks included. The `sha:` annotation names the commit that was built. A move is **not** made,
  and the deploy goes on with the head it planned, saying why, when:
  - the new commits bring a migration file that is not cleared (a deploy never goes past one:
    the owner clears it and the next `ship deploy` carries it);
  - main is not a descendant of the planned head (it was rewritten), or the later head's tree or
    config cannot be opened;
  - a deployable that would run on the planned head would be held, blocked or skipped on the later
    one (an import outside its paths, say), or a deployable name is unknown there;
  - the later head's config `requires` something the planned one did not, and that is not live.
  When the deploy keeps its head although main moved, or cannot read main (the read and the
  judging are given 90 s each, because they run while the deploy holds the heavy lane), it does not
  answer for the callers that joined it: they deploy for themselves, which gives each of them its
  own verdict. The same goes for a joined deploy that is interrupted or vanishes.
  A `requires` the planned head already passed is not asked again. A hold written while the deploy
  waited stops that deployable whether or not main moved. The heavy lane is taken again for each
  build, so main is not read a second time: pull requests merged after the deploy has its slot go
  with the next deploy. A repository without a `deploySetup` has no slot to wait for before the
  first build, so its deploy reads main again right after it has planned, and does not wait for
  anything before that.

## Deploys that ship land starts

[`ship land`](checks-and-merge.md#land) deploys for the pull requests it merges. It starts a deploy
of the repository's main when a merge it waits for is not live and one of these holds: the land line
has been quiet for `debounceSec` (no land waits or checks, and main has not moved), or a merge has
waited `deployAfterMin` ([`land` config](configuration.md#land)). It never starts one while a deploy
of the repository runs (its own, or any that holds the deploy lock), and never again for a tip that a
deploy has already ended for: not when it ended 0 (it is shipped), not when it failed (the owner
decides). The exceptions are a deploy that stopped at the migration gate and one that refused at a `requires` floor (`requiresWaiting`), below; a refusal at a floor the land judged met is not retried for `liveCacheMs`. Lands that
decide at the same moment take a lock, so only one starts it.

The deploy is **detached**: its own session and process group, nothing ties it to the land, so a
closed terminal or an interrupted land does not reach it (an interrupt in the promote step would
leave a hold). It runs in `$SHIP_TMP`, not in the checkout the land was started from, which may be
removed meanwhile. It is ship that runs there, with the land's time limits for `gh` calls and
fetches: one that hits its limit fails that deploy like any other failure, so the lands whose merge
it carried exit 3 and no land deploys that tip again. Its steps get the minimal environment as
always. The land prints where its output is:
`~/.ship/logs/<owner>__<repo>-land-deploy-<sha>-<stamp>-<id>.out`.

Its record is in `$SHIP_TMP/land/<owner>__<repo>/deploys/`: `<tip>-<id>.start.json` when it starts
(the runner's process) and `<tip>-<id>.end.json` when it ends (the exit code and the log). Records
are kept a day, which is why `liveWaitHours` is at most 24. A start whose runner is gone without an
end is dropped, and its tip can be deployed again. A deploy whose last `✗` line is the migration
gate's refusal (a migration merged after the land decided, not cleared) is recorded as waiting for
the migration, not as a failure: the lands wait at the migration gate, and the tip is deployed
again once it is cleared. If the runner cannot be spawned, the land says so once and tries again at
its next tick.

**Collapsing with other deploys.** A land's deploy joins the rules of
[One deploy at a time](#one-deploy-at-a-time-and-a-fresh-main), with one addition: it joins another
deploy, or is joined by one, only when both carry the same `requires` floors, since a deploy that
waited for a floor must not take the verdict of one that did not.

**The `requires` floor.** `ship deploy` called directly keeps "live at its main" for each `requires`
entry. Only a land passes a floor: the required repository's main when the pull request merged
(see [Land](checks-and-merge.md#land)). A deploy a land starts is held to the newest floor of every
merge it carries, and waits (`… waiting for <repo> <deployable> to be live at or past <sha>`) while
one is not met. A floor is met when the deployable's files as of the floor are live, even if the
live commit is older than the floor, when nothing it changed since is pending.

**The deploy judges what it ships.** The detached deploy ships main as it is when it freezes what it
ships (it fetches main again once it holds the heavy lane, see above), which can be later than the
tip the land decided on. So the runner, and only the runner, gives the deploy a `floorsAt(sha)`
function: the combined floors for a commit, that is the newest recorded floor (one file per merge in
`$SHIP_TMP/land/<owner>__<repo>/floors/`) of every merge the commit carries, per required repository,
the same pick the land makes before it starts the deploy. The deploy's `requires` gate asks it for
the commit it planned, and when main moves while it waits, for the commit it would move to, with
every requirement asked again. An unmet floor stops the deploy as an unmet `requires` does today
(`✗ requires …`, nothing shipped; when main moved it keeps the head it planned and says so), and a
land does not count it a failure: the end record says `requiresWaiting` (as `migrationsWaiting` does for a migration refusal), and the lands wait and decide again at the next tick, when the unmet combined floor holds the deploy back until it is met. `ship deploy` called directly passes no such
function and judges as before.

## Clearing migrations

`ship deploy` stops while main has migration files (those matching `migrations.paths`) that are
not cleared; `ship migrations ack <file>…` clears them. A migration that is not merged yet cannot be
cleared. Each argument is tried in this order, and the first rule that finds exactly one file wins:

1. a repository path (`db/migrations/0042_add_users.sql`; a leading `./` is dropped);
2. a path from the current directory, relative or absolute, inside this checkout;
3. an absolute path into another checkout or worktree of the same repository: the repository path
   it ends with is used;
4. a bare file name (`0042_add_users.sql`).

A rule that finds several files makes the argument ambiguous: ship does not try the next rule, and
prints the candidate paths so that you can give one. A miss prints the repository, branch and commit
it looked at and the globs it searched, and says that a migration that is not merged yet cannot be
cleared. Either way ship exits 2 and records nothing, not even the arguments before the failing one.

## Holds

A hold stops `ship deploy` from touching a deployable, and everything that comes `after` it, until
the owner runs `ship unhold <name>`. Something sets one when it cannot say the Worker is in a good
state: a failing live probe (the hold comes first, whether or not a rollback follows), `ship
rollback --to`, an interrupt after the promote, a current version that is not ours after the promote
(and its 30 s settle window), an error after the promote, and `wrangler deploy` failing after our
code went live. `ship status` lists them.

`ship deploy` also writes a hold just before it promotes and removes it once the live probes have
passed, so a ship that is killed outright in between (`kill -9`, out of memory, power loss) leaves
"deploy of <sha> in progress … the result was never verified" behind instead of a version that the
next run would take for verified. Look at the Worker, then `ship unhold <name>`. A deploy that fails
before anything changed on the Worker leaves no hold, and if the hold cannot be written the deploy
does not promote.

## Rollbacks

When the live probes fail after a promote, ship sets the hold first, so that nothing else deploys
over the Worker. It then rolls back, in both modes, only when all of this is true; the rollback is a
new deployment of the version that was live before:

- that version is known: the deployable's live commit was known before this deploy (with none,
  there is nothing to go back to);
- no Durable Object migration differs between that commit and this one (Cloudflare refuses a
  rollback past one);
- the version that is live, read again just before the rollback, is still ours alone: ship never
  promotes over somebody else's deploy (a deployment that splits traffic between versions is one,
  even with ours among them), and does not roll back when it cannot read which version is live;
- Cloudflare accepts the deployment. A refusal leaves our version live; for error 10220 (a secret
  changed since that version was live) the owner decides between
  `ship rollback <name> --to <version> --revert-secrets` and a fix forward.

In every other case the deploy ends stuck: the hold is all there is, and the output says why nothing
was rolled back. After a rollback ship probes again, reports the result and names any settings a
rollback does not restore (crons, routes, ...); the hold stays set either way, until `ship unhold`.

A rollback request that gets no answer (a network error, a timeout, a 5xx) may still have been
applied, so ship reads the deployment again, with the same settle window as after a promote: while
the deployment list still shows the version that was live before the request (ours), or none, ship
reads it again for up to 30 s. If the previous version is live at 100 %, the rollback counts as
done and is reported as rolled back, with a note that its answer was lost. If ours is still live
when the 30 s are over, another version is, the deployment splits traffic between versions (either
ends the wait at once; a split is not the rollback, even with the previous version among them), or
the deployment cannot be read, the deploy ends stuck and the output says which.

`ship rollback <name> --to <version>` sets the hold first too. A refusal from Cloudflare changed
nothing, and the hold goes back to what it was. When the request gets no answer, ship reads which
version is live, through the same 30 s settle window (it says so, and re-reads while the list
still names the version it named before the request, the split it showed, or none): the target at
100 % means the rollback took effect, and it is reported as done and probed like any other. Anything
else is reported as an unknown outcome that names the version that is live (or says that the current
deployment splits traffic between versions, even with the target among them, or that it could not
be read), and the hold stays: look with `ship status`.

## When a versioned deploy refuses

A versioned deploy uploads a version and promotes it; it never applies the settings that only
`wrangler deploy` applies, and it refuses when they differ instead of leaving them silently stale:
`triggers.crons`, `workers_dev` and `preview_urls` against the Worker's actual state, and `routes`,
Durable Object migrations, `logpush`, tail consumers and `observability` against the live commit's
config. The owner applies such a change once, outside ship, and then `ship deploy` carries on. For
the state keys: `wrangler triggers deploy` in the deployable's directory. For the config keys:
`wrangler deploy --message "sha:<full main sha> <name> owner"` from a clean checkout of main, after
running the repository's `deploySetup` and the deployable's `install` and `build` there as ship would
(wrangler deploys what has been built, with the `envFiles` in place for the build). The `sha:` stamp
keeps the live commit known, so the next `ship deploy` sees what is still pending.

## Exit codes and state

`ship deploy` exits 0 when every selected deployable is live at main (with `--dry-run`: when
everything it ran passed), 1 when something failed, is held, blocked or skipped, 2 on a usage
error, 130 when interrupted. `ship status` exits 0 whatever it reports (1 when it cannot read the
repository or Cloudflare, 2 on a usage error). Holds live in `~/.ship/holds/`, the migration ack
ledger in `~/.ship/acks/`, logs in `~/.ship/logs/`; locks, lanes and worktrees in `$SHIP_TMP`.

# ship

A local CI gate for solo developers who work on one machine: `ship check` checks a pull request
merged with the current main branch in a fresh worktree and posts a GitHub commit status
`local-ci`, which branch protection can require. Your checks run on your own hardware; GitHub
Actions is left for nightly clean runs. The same gate can ship Cloudflare Workers from the main
branch: see [Deploy](#deploy-cloudflare-workers).

## Install

```bash
git clone https://github.com/runnel/ship ~/Code/ship
cd ~/Code/ship && npm link          # puts `ship` on PATH
```

Requires Node >= 24, git and an authenticated `gh`.

ship keeps its own bare clone of the repository under `~/.ship/mirrors` and clones
`https://github.com/<repo>.git` over HTTPS, whatever your local remote says. For a private
repository git needs credentials for that: run `gh auth setup-git` once.

## Configure a repository

Add `ship.config.mjs` at the repository root. The config is always read from the main branch,
so a pull request cannot weaken its own gate. The one exception is the pull request that adopts
ship, when main has no config yet: it is checked with its own, and ship says so. The other thing
taken from the pull request's own config is a deployable's `paths` in the import containment check
(so a pull request that widens them can pass when main already violates them); that file is
evaluated in a child process with the same minimal environment as the check steps.

The default export may be an object, or a function `({ root }) => config`. The config is evaluated
from a temporary copy, so it cannot `import` files of the repository or its packages; read what
you need through `root`, the path of the tree under check.

```js
export default {
  repo: 'acme/app',
  mainBranch: 'main',
  docsOnly: ['*.md', 'docs/**'],        // a diff entirely inside these passes instantly
  checks: [
    {
      name: 'app',
      lane: 'heavy',                    // 'heavy' and 'light' lanes each run one check at a time
      paths: ['src/**', 'package*.json'],
      cwd: '.',
      install: 'npm ci',
      env: {},                          // added to a minimal environment (never your shell's)
      timeoutMin: 30,                   // per step
      steps: ['npm test', { run: 'npm run build', env: { PUBLIC_API_URL: 'https://example.org' } }],
    },
  ],
};
```

A changed file that matches no group (and is not docs-only) runs every group, as does any change
under `.github/` or to `ship.config.mjs`. Globs are anchored at the repository root: `*.md` is a
root-level file only. A moved file counts as a deletion plus an addition, so both paths are
classified.

Steps run with a minimal environment: `HOME`, `PATH`, `SHELL`, `USER`, `TMPDIR` and `LANG` from
your shell (`LC_ALL` is forced to a real locale), `CI=true`, `SHIP_CHANGED_FILES` (the changed
paths, one per line) and the `env` of the check and the step. Nothing else your shell has exported
reaches a step. Because `HOME` is passed, tools can still read your dotfiles, `~/.npmrc` for
instance.

Then require the status on main. This call **replaces the branch's whole protection**: read the
current settings first (`gh api repos/acme/app/branches/main/protection`) and carry them over.

```bash
gh api -X PUT repos/acme/app/branches/main/protection --input - <<'EOF'
{ "required_status_checks": { "strict": false, "checks": [{ "context": "local-ci" }] },
  "enforce_admins": false, "required_pull_request_reviews": null, "restrictions": null }
EOF
```

## Use

```bash
ship check            # the PR of the current branch
ship check --pr 42
```

Deploying Workers (`ship deploy`, `ship status`, ...) is described under [Deploy](#deploy-cloudflare-workers).

`ship check` checks the pull request head that was pushed, merged with main: push first, local
commits are not checked. Pull requests that are not open, that come from a fork, or that target a
branch other than the default one are refused (exit 2, no status). Exit codes: 0 success, 1
failure or error, 2 refused or a usage error, 130 interrupted.

Right after a push, `gh pr view` can still answer with the previous head. ship compares its answer
with the branch tip it has just fetched; when they differ it prints `… waiting for GitHub` and asks
again every 2 s for up to 60 s. If GitHub never agrees, ship exits 1 with a `local-ci not run` line
and posts no status: run it again in a minute.

Every pull request is checked against a main without the other open ones, so two that add a
migration with the same number both pass. When `migrations` is configured and the pull request
adds a numbered migration (a file under `migrations.paths` that main does not have, named
`<digits>_…`), ship compares its number with the files added by every other open pull request,
whatever its base branch (up to 100 of them), and prints a
`! migration prefix … is also added by open PR #…` line for each match. This never changes the
verdict: a passing check stays a pass, and its status description ends with
` · migration <prefix> also in #<n>` (the lowest number when there are several). If the open pull
requests cannot be listed, a `! could not compare` line says so and the check goes on. Whichever of
the two merges second renumbers.

Output is one line per step; on failure the last lines of the failing step and the full log path
under `~/.ship/logs/`. A step that outlives its `timeoutMin` is killed together with everything it
started. Background processes a step leaves running (a build worker, a dev server) stay available to
the later steps and are stopped when the check ends, with a line saying so. A daemon that detaches
itself (`setsid`, `pg_ctl start`) escapes that: stop it from a `trap` in the script that starts it. Two checks of the same commit started at the same time run once. Ctrl-C stops the running
step, marks the status as errored (never as success) and cleans up. Times in messages use the
system time zone; `SHIP_TZ=UTC` (any IANA name) overrides it.

Short-lived state (locks, lanes, worktrees) lives in a per-user directory created with mode 0700:
on macOS always `/private/tmp/ship-<uid>`, whatever `$TMPDIR` says (so every session of yours shares
one set of lanes and locks), elsewhere `ship-<uid>` under the system temp directory. Set `SHIP_TMP`
to move it; that splits sessions that do not share the variable.

## Leak guard (for this repository)

`ship leak --staged | --msg <file> | --pre-push [remote] | --all | --history [--generic-only]` scans for
shapes that must not be published, including commit author and committer identities. For the
commits GitHub creates itself (a squash or merge commit from the web UI or `gh pr merge`), GitHub
fills the author line from the account. When the committer is `GitHub <noreply@github.com>` and the
author address is a `users.noreply.github.com` one, that author line (name and noreply address) is
not matched against the denylist; the rest of the commit, and the generic rules on that line, apply
as usual. Both identity lines are self-asserted, so this is a narrow exemption, not proof of
origin. Besides messages and patches it reads, whole and as stored, the files in which a merge
commit differs from every parent, and it reads annotated tags and any blob or tree that a ref or a
tag names. Replace refs and grafts are ignored, and so is the config that would change what
`git log` prints (quoted file names, diff prefixes, textconv, `diff.relative`, `log.showRoot`, output
encoding). `--all` and `--history` leave `refs/stash` alone: a push sends it only when named. It
fails closed: a git error, a binary file it cannot scan, a commit message stored in an encoding
other than UTF-8, or a `git log` that does not split into exactly the commits `git rev-list` names
is a finding, not a pass. Enable with
`git config core.hooksPath .githooks` and create `~/.config/ship/denylist`. Pull requests are
judged by main's copy of the guard.

## Deploy (Cloudflare Workers)

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
| `ship migrations ack <file>…` | Mark migration files on main as cleared for deploy. A file may be named as a repository path, a path from the current directory, a path from another checkout, or a bare file name; see [Clearing migrations](#clearing-migrations). | no |

The commands that are not allowlisted are the owner's: the permission prompt is the confirmation.
ship itself never asks interactively. Every usage error (an unknown flag, an extra or missing
argument, a malformed value such as `--at zz`, `--redeploy` without names, an unknown deployable) prints
`✗ ship <command>: <what is wrong>` on stderr and the command's usage line on stdout, and exits 2.
A refusal that needs the repository (a commit that is not on main, a version that does not exist)
says so in its own words and also exits 2.

### Configuration

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
  migrations: { paths: ['db/migrations/*.sql'] },
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
(`path`, `file`), `migrations` (`paths`), a `requires` entry (`repo`, `deployable`) and `credentials`
(`file`, `map`). `liveHost` is checked whenever it is present, also on a deployable without `probes`.

### The live commit

Every version and deployment ship makes carries the message `sha:<40 hex> …`, sha first
(Cloudflare cuts messages at 1,000 characters; `wrangler deploy` keeps 50 on the deployment). The
live commit is read from the current deployment: its own message, else the code of its version (a
deployment stamp of that version, the version's message, or — for a version Cloudflare made when a
secret was changed with `wrangler secret put` — the version before it). A split deployment, a
version made outside ship (including `wrangler versions secret put`, which copies the newest
version whether or not it is deployed) or history beyond the last 50 deployments / 200 versions is
**live unknown**: that deployable (and what comes after it) is not deployed until `ship adopt`.

### Adopting

`ship adopt --plan` suggests, per Worker, the main commit at the time its live code was uploaded
(adopting it makes every later commit that touches the deployable pending). `ship adopt --at <sha>`
stamps the current version as built from `<sha>`. A `<sha>` later than the code that is really live
hides the commits in between from `ship deploy`; for a Worker whose live commit is already known
that is refused (exit 1, the commits named, the migrations not recorded), while the same commit or an
older one is fine.

### What `ship deploy` does

1. Takes the repo's deploy lock (a second deploy waits), fetches the main branch, opens a fresh
   worktree at its tip and loads `ship.config.mjs` from it.
2. Per deployable: holds, import containment, the live commit (must be an ancestor of main), and
   whether any of its files changed since (minus `ignore` and `docsOnly`). Nothing pending: done.
   A pending deployable whose live commit is known gets `· ships 3 commit(s): #41 #43 + 1 without a
   PR number` at the end of its plan line (a number is read from a trailing `(#n)` in the commit
   subject). A first deploy, and a `--redeploy` of code with no new commits, show none. The lines are
   printed before the migration gate, setup, checks and builds, so a deploy says what it will ship
   before it runs anything.
3. Migration files on main that are not cleared → stop. `requires` not live → stop.
4. `deploySetup`, then every `onDeploy` check group; red → stop.
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
   version that is still not ours when the 30 s are over. The first deploy of a versioned deployable
   is the owner's: the Worker must exist and its preview URLs must be on.
6. A failing live probe sets a hold and, when it can, rolls back to the previous version (see
   [Rollbacks](#rollbacks)). A deployable that fails or is held stops the deployables that come
   `after` it; the others go on. Naming a deployable whose `after` dependency has pending changes
   skips it too, unless the dependency is named as well.

### Clearing migrations

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

### Holds

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

### Rollbacks

When the live probes fail after a promote, ship sets the hold first, so that nothing else deploys
over the Worker. It then rolls back, in both modes, only when all of this is true; the rollback is a
new deployment of the version that was live before:

- that version is known: the deployable's live commit was known before this deploy (with none,
  there is nothing to go back to);
- no Durable Object migration differs between that commit and this one (Cloudflare refuses a
  rollback past one);
- the version that is live, read again just before the rollback, is still ours: ship never promotes
  over somebody else's deploy, and does not roll back when it cannot read which version is live;
- Cloudflare accepts the deployment. A refusal leaves our version live; for error 10220 (a secret
  changed since that version was live) the owner decides between
  `ship rollback <name> --to <version> --revert-secrets` and a fix forward.

In every other case the deploy ends stuck: the hold is all there is, and the output says why nothing
was rolled back. After a rollback ship probes again, reports the result and names any settings a
rollback does not restore (crons, routes, ...); the hold stays set either way, until `ship unhold`.

A rollback request that gets no answer (a network error, a timeout, a 5xx) may still have been
applied, so ship reads the deployment again, with the same settle window as after a promote: while
the deployment list still shows the version that was live before the request (ours), or none, ship
reads it again for up to 30 s. If the previous version is live, the rollback counts as done and is
reported as rolled back, with a note that its answer was lost. If ours is still live when the 30 s
are over, another version is (which ends the wait at once), or the deployment cannot be read, the
deploy ends stuck and the output says which.

`ship rollback <name> --to <version>` sets the hold first too. A refusal from Cloudflare changed
nothing, and the hold goes back to what it was. When the request gets no answer, ship reads which
version is live, through the same 30 s settle window (it says so, and re-reads while the list
still names the version it named before the request, or none): the target means the rollback took
effect, and it is reported as done and probed like any other. Anything else is reported as an unknown outcome
that names the version that is live (or says that it could not be read), and the hold stays: look
with `ship status`.

### When a versioned deploy refuses

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

### Exit codes and state

`ship deploy` exits 0 when every selected deployable is live at main (with `--dry-run`: when
everything it ran passed), 1 when something failed, is held, blocked or skipped, 2 on a usage
error, 130 when interrupted. `ship status` exits 0 whatever it reports (1 when it cannot read the
repository or Cloudflare, 2 on a usage error). Holds live in `~/.ship/holds/`, the migration ack
ledger in `~/.ship/acks/`, logs in `~/.ship/logs/`; locks, lanes and worktrees in `$SHIP_TMP`.

## Licence

MIT

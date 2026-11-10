# Checks and merge

How `ship check` runs a pull request, how the lanes and `ship queue` work, and when `ship merge` merges. Back to the [README](../README.md).

## Use

```bash
ship check            # the PR of the current branch
ship check --pr 42
ship check --pr 42 --github   # run it on GitHub now (see Overflow to GitHub Actions)
ship check --pr 42 --cloudflare   # run it on Cloudflare now (see Overflow to Cloudflare Workers Builds)
ship merge --pr 42    # merge a PR that passed, unless main changed under its check
ship land --pr 42     # check and merge through the repository's serial line (see Land)
ship queue            # who holds each lane, who waits, and for how long
```

Deploying Workers (`ship deploy`, `ship status`, ...) is described under [Deploy](deploy.md).

`ship check` checks the pull request head that was pushed, merged with main: push first, local
commits are not checked. Pull requests that are not open, that come from a fork, or that target a
branch other than the default one are refused (exit 2, no status). Exit codes: 0 success, 1
failure or error, 2 refused, stopped (see below) or a usage error, 130 interrupted.

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
step, marks the status as errored (never as success) and cleans up. A check that uses the heavy
lane prints `! on battery power` right after the groups line when `pmset` (macOS only) says the Mac
is on battery, because heavy checks time out more often there; it warns and goes on. Times in messages use the
system time zone; `SHIP_TZ=UTC` (any IANA name) overrides it.

A lane is first come, first served. A check or deploy step that wants a lane files a ticket in
`$SHIP_TMP/lanes` and starts only when its ticket is first, so it cannot lose to a waiter that
happens to poll at a luckier moment. The heavy lane has three classes: work that `ship deploy` does (its setup,
deploy-time checks and builds) goes first, then land checks (`ship land`), then `ship check` runs; whoever holds the lane is never interrupted. The
waiting line says the place: `… waiting for the heavy lane (3rd in line): acme/app PR #12 since 17:21`
(who holds the lane now), repeated whenever the place changes and at least once a minute. A waiter
that is killed does not hold the others up: the next one removes the ticket of a process that is
gone, and Ctrl-C takes the waiter's own ticket back. The tickets only decide who tries; the lane
itself is still one lock, so two heavy builds never run at once.

A check that cannot be used any more stops instead of taking, or keeping, a lane. From the moment
it queues for a lane, and then once a minute while it waits and runs, it asks GitHub and its mirror
whether (1) the pull request is still open and still aimed at the default branch, (2) its head is
still the one being checked (a different head must be seen twice, a few seconds apart, because
`gh` can answer with an older one for a while after a push), and (3) main still contains the main
the check began against and has gained no file that matches `recheckOnMainChange`: the cases in
which `ship merge` would refuse the result anyway. (The look uses the `recheckOnMainChange` the
check began with; `ship merge` reads the one on main at the time.) It also looks once more when it
wins the lane. If any of these is no longer so, it prints
`✗ stopped checking PR #…: <reason> (no verdict posted)` and exits 2: a waiting check gives its
place in line back, a running one has its step and everything the step started stopped, the steps
after it do not start, and the lane and the worktree are released. Nothing is posted: the
`pending` status it already left stays on a head, or against a main, that nobody will merge on
this result. A main that moved in any other way does not stop a check. A look that cannot be made
or takes more than 30 s (GitHub unreachable, a hung fetch) says nothing, and the check goes on.
Stopping only ends work in progress: a check that has finished posts its verdict as before.

`ship queue` shows the lanes on one screen, read only. For each lane it shows the holder (the pull
request or command, how long it has held the lane, the usual run time, and how long ago its log
was last written) and the waiters in line order with how long each has waited and when it should
start. `ship queue` labels each waiter `deploy work, ahead of checks`, `land check, ahead of other
checks` or `check`. The usual time is the median of the latest 20 runs of that kind in that repository, and the
90th percentile is the top of the range; both come from `~/.ship/logs/`. A deploy's log spans all
of its turns at the lane, so a deploy's figure is for the whole deploy. With fewer than 3 runs
there is no estimate. The estimate is the holder's time left plus the usual time of each waiter
ahead, and assumes that no deploy work is put in front of them (a `+` marks a holder that is
already past its usual time). A holder is marked `possibly stuck` once it has held the lane for
more than three times the usual time, more than 1.5 times the 90th percentile, and at least five
minutes. A holder whose process is gone is said to be; the next in line takes the lane over.

Short-lived state (locks, lanes, worktrees) lives in a per-user directory created with mode 0700:
on macOS always `/private/tmp/ship-<uid>`, whatever `$TMPDIR` says (so every session of yours shares
one set of lanes and locks), elsewhere `ship-<uid>` under the system temp directory. Set `SHIP_TMP`
to move it; that splits sessions that do not share the variable.

## Merge

A passing check says the pull request was fine against the main of that moment. When main moves
afterwards, the verdict is usually still good, but not always: a generated file that carries a hash
of all migrations, for instance, goes stale when another pull request adds one. `ship merge --pr
<number>` merges only when that cannot have happened. It reads the `local-ci` status of the pull
request's current head (it must be `success`; a head that was pushed after the check has none),
takes the main commit the check ran against from the `vs main@<sha>` in its description, fetches
main and compares the two. It refuses (exit 2) when that commit is no longer on main (main was
rewritten) or the check ran against another branch. If main gained a file that matches
`recheckOnMainChange` since then, it refuses and names the files:

```
✗ main gained db/migrations/0042_x.sql since the check (vs main@52d4c19); run ship check --pr 42 again
```

```js
recheckOnMainChange: ['db/migrations/**'],   // in ship.config.mjs; default: none
```

The globs are read from the main branch's config, like the checks, and are relative to the
repository root: an entry with a leading `./` or `/` or a trailing `/` could never match, so the
config is refused (write `dir/**`). Otherwise it squash-merges with
`gh pr merge --squash --delete-branch` (`--keep-branch` leaves the branch, which a pull request
stacked on it needs) and prints the merge commit. The merge is pinned to the checked head
(`--match-head-commit`), so a push made in between is refused by GitHub rather than merged
unchecked. A docs-only verdict ran nothing that main could have made stale and is never held back.
Two `ship merge` runs for one repository on one machine take turns, so the second fetches the main
the first one made. If `gh pr merge` fails or gets no answer within two minutes, ship reads the pull
request again: when it is merged after all (gh can fail after the merge, deleting the branch) the
line says `merged … but gh reported: …`; when it is not, or its state cannot be read, the line says
which. ship neither posts a status nor passes `--admin`: branch protection decides exactly as it
does for `gh pr merge`. Main can still move on GitHub between ship's fetch and the merge itself
(`ship merge` has no queue of its own; [Land](#land) is the serial line).

Exit codes: 0 merged (also when gh reported an error after the merge landed); 1 failed: GitHub
refused the merge, the merge got no answer, or any other error (no network, a config on main that
does not load); 2 refused by ship, or a usage error.

## Land

`ship land` checks and merges one pull request through a serial line, one per repository, so that
each pull request is checked against a main that already holds the ones landed before it. This
version stops at the merge: it does not deploy.

```bash
ship land             # the PR of the current branch
ship land --pr 42
ship land --pr 42 --keep-branch   # leave the branch, which a pull request stacked on it needs
```

The same refusals as `ship check` apply (not open, from a fork, aimed at another branch than the
default one: exit 2, no status).

**The line.** Lands of one repository on one machine are served in the order they arrive. The slot
is held from the check until the mirror shows the merge on main, so the next land checks against a
main that has it. A waiter whose process is gone is skipped and its ticket removed by the next one
that looks. `ship queue` shows the holder and the waiters of each land line next to the lanes, and
a waiting land says its place: `… waiting in the land line of acme/app (2nd in line): …`.

**The head lock.** Before it joins the line, a land takes the per-head lock that `ship check`
takes. An optional `ship check` of the same head that is running is waited for, outside the line
(`… an optional ship check of … is running`), and then the land joins. A second land of the same PR
and head is refused (exit 2, `is already landing`). A land of another PR that happens to have the
same head waits for the first one.

**The land check.** In the slot the land checks the head merged with the main of that moment. The
check is the one `ship check` runs, with the same `local-ci` description and no suffix, with three
differences: in the heavy lane it goes ahead of optional checks, it never runs on GitHub or
Cloudflare (in a serial line this machine is faster), and on macOS `caffeinate -i` keeps the Mac
awake while it runs. Only its pull request can stop it: a main that moved is the land's to judge
before the merge.

**Reuse.** A green `ship check` is not run again when ship's own result for exactly this head and
this main is a success, and GitHub still shows that same success on the head, posted by a user and
not a bot. The description is compared as GitHub stores it, so GitHub's 140-character cut does not
defeat the reuse. The line says `(reused: this head was checked against this main)`. Anything
else is checked again.

**Staying valid.** Once a minute, while it waits for the head lock or the slot and while it checks,
the land asks whether the pull request is still open, still aimed at the default branch and still
at the head it started with (a different head must be seen twice). If not, it stops with exit 2,
nothing merged. A main that moved does not stop a land; it is dealt with below.

**Before the merge.** The merge happens under the repository's merge lock, which `ship merge` takes
too, so the two never overlap. Under it, ship fetches main again:

- If main is no longer the commit that was checked, the land checks again against the new main
  (`! main moved outside the queue`). After two re-checks it gives up: exit 2, land again.
- The pull request is read again: it must be open, aimed at the default branch (one that is not
  is treated as moved on, exit 2) and at the checked head.
- The `local-ci` on that head is read again and compared in full: a success, not from a bot, for
  this head and this main. Otherwise exit 4 with the reason.
- Then `gh pr merge --squash --delete-branch --match-head-commit` (`--keep-branch` keeps the
  branch).

**The merge outcome.** When `gh pr merge` fails or gets no answer within 60 s, the pull request is
read again for up to two minutes. Merged at the checked head: the land goes on (`! gh reported …,
but PR #… is merged`). Merged by someone else at another head: exit 2. Closed, retargeted or pushed
to: exit 2. Still open: exit 4, landing again is safe. Not readable: exit 5, the outcome is unknown
(`gh pr view <n>`).

**After the merge.** The land waits for GitHub to name the merge commit and for the mirror's main
to contain it (up to two minutes each), then gives the slot up. A pull request that touches no
deployable and adds no migration is done: exit 0. Otherwise this version prints
`this version of ship land does not deploy yet — run ship deploy` and exits 3.

**Time limits.** Nothing a land waits for may freeze the line: each `gh` call gets 60 s, each
`git fetch` 120 s, and the mirror lock and the merge lock 5 minutes. Before the merge each of these
ends the land with exit 4, and landing again is safe. A step that fails after the merge ends it with 3.

**Interrupts.** Ctrl-C while queued posts no status and gives the place up. While checking it
behaves as `ship check` does: the status becomes `error`, the step and the worktree are cleaned
up. After the merge nothing is undone: the merge stays. Exit 130 in every case.

Exit codes:

| Exit | Meaning |
|---|---|
| 0 | landed; this version: merged and nothing to deploy |
| 1 | a check step failed (the output ends with the step's last lines and the log path) |
| 2 | refused, nothing merged: not open, from a fork, base not main, a conflict with main, a new head was pushed, the same PR and head already landing, main kept moving, a PR merged by someone else, or GitHub still shows an older head after 60 s |
| 3 | merged, not live: this version, when the PR touches a deployable or adds a migration (run `ship deploy`), or GitHub or the mirror does not show the merge commit in time (`ship status`), or ship failed after the merge |
| 4 | not merged: an error in ship, the config, GitHub or a time limit, before the merge; landing again is safe |
| 5 | the merge outcome is unknown: `gh pr merge` failed and the pull request could not be read |
| 130 | interrupted |

**The ledger.** Every land appends one JSON line to `~/.ship/land/<owner>__<repo>.jsonl` (the
logs are pruned after 14 days, this is not): the pull request (`pr`: the number, given or, for a land
started with a branch name, read from GitHub once the pull request was found, else `null`; `branch`: the ref
when it is not a number, so such a line carries both), the `head`, when it joined the line, got the slot and merged (`joinedAt`,
`slotAt`, `mergedAt`), `endedAt` and the exit `code`. Refusals, early errors and interrupts
(130) write a line too, with the times that were reached; a land whose repository cannot be read
from the clone writes to `~/.ship/land/unknown.jsonl`. Nothing rotates the file; a line that
cannot be written costs only that line.

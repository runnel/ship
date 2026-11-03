# Checks and merge

How `ship check` runs a pull request, how the lanes and `ship queue` work, and when `ship merge` merges. Back to the [README](../README.md).

## Use

```bash
ship check            # the PR of the current branch
ship check --pr 42
ship check --pr 42 --github   # run it on GitHub now (see Overflow to GitHub Actions)
ship check --pr 42 --cloudflare   # run it on Cloudflare now (see Overflow to Cloudflare Workers Builds)
ship merge --pr 42    # merge a PR that passed, unless main changed under its check
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
happens to poll at a luckier moment. Work that `ship deploy` does (its setup, deploy-time checks and
builds) goes ahead of waiting pull request checks; whoever holds the lane is never interrupted. The
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
start. The usual time is the median of the latest 20 runs of that kind in that repository, and the
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
(there is no merge queue).

Exit codes: 0 merged (also when gh reported an error after the merge landed); 1 failed: GitHub
refused the merge, the merge got no answer, or any other error (no network, a config on main that
does not load); 2 refused by ship, or a usage error.

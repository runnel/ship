# Overflow

Sending a check to GitHub Actions or Cloudflare Workers Builds when the heavy lane's line is long. Back to the [README](../README.md).

## Overflow to GitHub Actions

A repository whose config has `overflow` can send a check to GitHub Actions when the heavy lane's
line is long, instead of waiting here. It is a way around a queue, not a second gate: the same groups
run with the same code, and `ship check` on this machine stays the only thing that posts `local-ci`. A
repository that also has [`overflow.cloudflare`](#overflow-to-cloudflare-workers-builds) tries that first;
the rules below apply when it does not take the check.

```js
overflow: {
  workflow: 'ship-check.yml',  // in .github/workflows on main; start from examples/ship-check.yml
  includedMinutes: 3000,       // what the account's plan includes per month
  reservePerDay: 60,           // kept free per day left in the month, for everything else on Actions
  reserveFloor: 300,           // kept free on top of that
  minAhead: 4,                 // waiters ahead of a check before it goes (default 4)
  maxRunning: 2,               // runs at once, on this machine (default 2)
  runMinutes: 20,              // what a run counts as until the usage report shows it; set it to what a run takes (default 20)
  timeoutMin: 40,              // ship gives a run up after this long (default 40)
  groups: ['app', 'workers'],  // only checks made of these groups go (default: any)
},
```

**When a check goes.** Only a check in the heavy lane, never a deploy, and only when main's own config
says so. It goes when `minAhead` waiters are ahead of it and a place is free. The line is looked at
when the check arrives and once a minute while it waits, so a place that comes free does not stay
empty. `ship check --github` goes without looking at the line, to measure a run; every other rule
holds. A check goes at most once.

**The reserve.** The minutes are shared with everything else the account runs on Actions, and if they
run out, that stops too. So a run starts only if
`includedMinutes - used - runMinutes x (recent runs + this one) >= reserveFloor + reservePerDay x days left`.
`used` comes from the account's usage report for the current UTC month. Recent runs are those decided
on this machine in the last 24 hours, counted again on top of the report because it may not show them
yet (`~/.ship/overflow/runs.jsonl`). Two checks at once take turns at this, so they cannot both spend
the last room. If the report cannot be read or has no Actions row, or that
file cannot be read, the check stays here. The reason is printed as a `· stays on this machine` line.
ship never reads or changes a budget. To stop all overflow at once: `gh workflow disable ship-check.yml`.

**What runs.** ship starts the workflow from `main`, never from the pull request's branch, so a pull
request cannot change what judges it. The workflow merges main into the head and fails unless that
gives the tree ship got from the same merge here, then runs `ship run-groups`, which takes the groups
from `ship.config.mjs` on main. Its token can only read. Copy `examples/ship-check.yml`; it may need
more for your groups (a database, say).

**The verdict.** Only green is taken from GitHub: when the run that ship started, from that workflow on
main, ends in success, ship posts `local-ci` with `· on GitHub` in the description and a link to the
run. Anything else (a red run, a cancelled one, one that is not started after 5 minutes or has no result
after `timeoutMin`, GitHub not answering, a failed start) sends the check back to its old place in
line, with a `! … back in line on this machine` line, and this machine gives the verdict. A red on
GitHub may be GitHub's, so it never reads as a red check. Ctrl-C cancels the run, and so does a pull
request that moves on while it runs, like any check whose result can no longer be used. `ship queue`
lists the running ones as `on GitHub:` with a link to the run.

`ship merge` refuses a `local-ci` posted by a bot: a workflow's token can post a status, and only
`ship check` may.

## Overflow to Cloudflare Workers Builds

A repository whose config has `overflow.cloudflare` can also send a check to Cloudflare Workers Builds when
the heavy lane's line is long. It is tried before GitHub Actions and is otherwise the same kind of thing:
a way around a queue, not a second gate. The same groups run with the same code, and `ship check` on this
machine stays the only thing that posts `local-ci`. ship needs no Cloudflare credential for it: it only
pushes with `git` and reads with `gh`.

```js
overflow: {
  // ...the GitHub keys above, which stay required
  cloudflare: {
    repo: 'acme/app-runner',                  // a private runner repository, not this one; its branch is force-pushed
    branch: 'run',
    checkName: 'Workers Builds: app-runner',  // the check run the build leaves: Workers Builds: <worker name>
    minAhead: 2,                              // waiters ahead of a check before it goes (default 2)
    maxRunning: 4,                            // builds at once, on this machine (default 2)
    timeoutMin: 25,                           // ship gives a build up after this long (default 25)
    groups: ['app', 'migrations'],            // only checks made of these groups go (default: any)
    setup: 'scripts/remote-setup.sh',         // optional: main's copy of this file runs first, for what the groups need
    env: { app: { SOME_VAR: '{root}/scripts/x.cjs' } },  // optional: added to a group's steps; {root} is the checkout in the build
  },
},
```

**Setting it up.**

1. Create a private repository for the runner (`acme/app-runner`) and turn Actions off in it.
2. Create a Worker in Cloudflare and connect it to that repository: production branch `run`, build command
   `bash .ship-run/run.sh`, deploy command `true`, build variables `SKIP_DEPENDENCY_INSTALL=1` and
   `NODE_VERSION=24` (the image installs the Node that variable names; ship needs 24 or newer, and the
   build refuses an older one; a `setup` script may bring its own instead). The Worker never serves
   anything. The check run is named `Workers Builds: <worker name>`.
3. Give the Cloudflare GitHub App that one repository only.
4. **Narrow the build token by hand.** The build step can read `CLOUDFLARE_API_TOKEN`, and so can the code
   under check. Replace the token Cloudflare makes with one that has Account Settings, Workers Scripts,
   Memberships and User Details, all read: that is accepted. Three of them without Workers Scripts is
   refused when the connection is set up, with a misleading "user who has left your organization".
5. Add `cloudflare` to `overflow` in the config on main. To turn it off, remove it there; a build that has
   been pushed runs on.

**When a check goes.** Only a check in the heavy lane, never a deploy, and only when main's own config says
so. Cloudflare is tried first: a check goes when `minAhead` waiters are ahead of it, `groups` takes every
group of the check, and a place is free. The places are its own (`cloudflare-0` ...: `maxRunning` of them),
so they never take GitHub's. Otherwise the GitHub rules apply exactly as before, with its reserve untouched.
The line is looked at when the check arrives and once a minute while it waits. `ship check --cloudflare`
goes without looking at the line (`--github` and `--cloudflare` together are refused); every other rule
holds. A check goes at most once, to one of the two: after anything but green from either it is back in
line here. There is no counter or budget for Cloudflare: ship cannot read its usage.

**What runs.** ship makes a commit and force-pushes it to `branch`. Its tree is the merged tree ship has
just made (the head merged with main), with a `.ship-run/` directory laid over it, written by this machine
from main: `run.sh` (a constant that comes with ship), `config.mjs` (`ship.config.mjs` as it is on main),
`groups`, `changed-files`, `ship-sha`, `env.json`, `nonce` (a random value nobody reads: checking the same
tree again still changes a file, which Workers Builds' watch paths could otherwise take as nothing to build)
and `setup.sh` (the `setup` file as it is on main, when configured). Anything the pull request has under
`.ship-run/` is dropped, so a pull request cannot change what judges it. The parent of the commit is the
branch's last tip, fetched first so that a push sends only what is new (the mirror keeps the last commit it
pushed under `refs/ship/cloudflare/tip/<branch>`, so that git does not prune the chain and the next fetch
does not bring it again); the repository's own history is never pushed. Two checks at once push two
commits, and both are built.

Workers Builds clones that one commit and runs `bash .ship-run/run.sh`, from the checkout root. The script
first checks that the checkout is the commit the build was started for (`WORKERS_CI_COMMIT_SHA`, which
must be set): a build that a later push superseded may clone that push, and must not give its result to a
commit it did not check. It sets `LC_ALL=C.UTF-8` where there is no `en_US.UTF-8` locale. If there is a
`setup.sh` it runs it in a subshell under `set -euo pipefail`, with `SHIP_GROUPS` set; only its `PATH` comes
out (to install a Node version, say), and only if it ran to its end: a script that fails, uses a variable
it never set, or calls `exit` (even `exit 0`) fails the build with exit 2, and nothing else it sets, such as
`groups`, a trap or a function named `node`, reaches the rest. The `node` on `PATH` after that must be 24 or
newer and outside the checkout, or the build fails with exit 2. Then it downloads ship at `ship-sha`, runs
`ship run-groups --config … --files … --env …` and prints the tail of the log if that fails. The machine
has no `sudo` and no history: steps that need either must fit that, or get what they need from `setup`. The
`.ship-run/` files are part of the commit, so `git status` is clean while the groups run. A secret in `env`
is a secret in the runner repository: keep them out.

**The verdict.** Only green is taken from Cloudflare: a check run on the commit ship pushed, made by the
GitHub App `cloudflare-workers-and-pages`, named `checkName`, completed with `success`. Another app's check
run, another name, another commit, `neutral` or one that is still going: none of them counts, and a
completed run of the build that is not a success on that commit makes it red even beside a success. Only a
completed run is read: while the build is queued or running there may be no check run or one that is
`in_progress`, and ship keeps waiting, up to `timeoutMin` (a build is stopped by Cloudflare after 20
minutes; the rest is for the queue). Green posts `local-ci` with `· on Cloudflare` in the description and a link to the check
run, from this machine, with your login. Anything else (a red build, no result in time, a push that failed, `gh`
not answering) sends the check back to its old place in line with a `! … back in line on this machine` line,
and this machine gives the verdict: a red may be Cloudflare's, so it never reads as a red check. Ctrl-C and a
pull request that moves on end the wait, but the build cannot be cancelled without a Cloudflare credential,
which ship does not have: it runs on and its result is ignored. `ship queue` lists the running ones as
`on Cloudflare:` with a link to the commit. `ship merge` reads the status like any other.

**What it costs and exposes.** The code of every pull request that goes is copied to the runner repository
and to Cloudflare's machines. The GitHub token the clone has can read the runner repository and cannot write
it. Builds beyond what the Cloudflare plan includes are billed automatically, with nothing to stop them.

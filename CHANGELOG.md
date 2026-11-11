# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Changed

- A land reads an object `ship.config.mjs` for its floors straight from the mirror; only a function config is evaluated in a checkout.

### Fixed

- `ship queue | head` and other early-closing readers no longer end ship with an unhandled `EPIPE`; the command runs to its own end.
- A land that waits out `liveWaitHours` names the hold on a deployable it touches in its last line.
- A land records its floors under the head before the merge, so a deploy in the moments before GitHub names the merge commit is held to them too.

## 0.2 - 2026-11-11

### Added

- `ship land --pr N`, a merge queue per repository ([Land](docs/checks-and-merge.md#land)). It checks the pull request against the main it merges onto, one at a time, merges it, starts the deploy when one is due (120 s after the line goes quiet, or within an hour) and ends when the change is live. Exit codes: 0 live, 1 a check failed, 2 refused, 3 merged but not live, 4 error before the merge, 5 merge outcome unknown.
- The deploy a land starts runs detached from the session that started it, and finishes even if that session is closed ([Deploys that ship land starts](docs/deploy.md#deploys-that-ship-land-starts)).
- `requires` floors for lands: a deploy waits until what it requires is live at least where it was when each merge it carries was made.
- One ledger line per land in `~/.ship/land/<owner>__<repo>.jsonl`, for measuring waits.
- The optional `land` config block: `deployAfterMin`, `debounceSec`, `liveWaitHours` ([Configure a repository](docs/configuration.md#land)).

### Changed

- The heavy lane serves deploy work first, then land checks, then other checks. `ship queue` labels each waiter and shows the land lines.
- With `ship land`, `ship check` is optional early feedback; the land is the gate.

### Fixed

- `ship check` exits 1 with `✗ local-ci not started: …` when GitHub does not take the first status, instead of an unhandled error.
- `ship check` re-checks a head whose stored result file is torn.
- A Cloudflare Workers Builds check whose build has not started after 5 minutes goes back in line instead of waiting out `timeoutMin`.
- A timed-out `git fetch` kills its whole process tree. Git calls on a mirror no longer depend on the current directory, and `SHIP_HOME`/`SHIP_TMP` are made absolute.

## 0.1 - 2026-11-03

### Added

- The gate: `ship check` checks a pull request merged with current main in a fresh worktree, with the config read from main, and posts the commit status `local-ci`. A diff entirely in `docsOnly` passes at once.
- Lanes and queue: a heavy and a light lane, first come first served, with `ship queue` to read them. A check whose result can no longer be used (the pull request closed or pushed to, or main gained a file that voids it) stops without a verdict.
- `ship merge` squash-merges a pull request only on a successful `local-ci` for its current head that no bot posted, and refuses when main gained a file matching `recheckOnMainChange`.
- Overflow: when the heavy lane's line is long, a check can run on Cloudflare Workers Builds or GitHub Actions; only green is taken from there, anything else is checked here.
- Deploys: `ship deploy`, `ship status`, `ship adopt`, `ship rollback` and `ship unhold` ship Cloudflare Workers from main, with probes, holds, and one deploy at a time per repository.
- Migrations: `ship migrations plan`, `apply` and `ack` clear migration files for deploy; `apply` proves declared post-conditions from the database before it clears a file.
- The leak guard: `ship leak` scans commits, messages and pushes for shapes that must not be published; it runs from `.githooks`.

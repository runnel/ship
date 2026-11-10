# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- `ship land` checks and merges a pull request through a serial line per repository ([Land](docs/checks-and-merge.md#land)), then waits until the merge is live, starting a detached deploy when one is due ([Deploys that ship land starts](docs/deploy.md#deploys-that-ship-land-starts)). It ends 0 when the pull request is live, 3 when it merged but cannot become live. Every land writes a line to `~/.ship/land/<owner>__<repo>.jsonl`.
- The optional `land` config block (`deployAfterMin`, `debounceSec`, `liveWaitHours`) ([Configure a repository](docs/configuration.md#land)).

### Changed

- The heavy lane has a land priority class between deploy work and checks, for the coming `ship land`; `ship queue` labels each waiter `deploy work, ahead of checks`, `land check, ahead of other checks` or `check`.
- Ship-internal helpers (check, merge and deploy reads) are exported for the coming `ship land`; no behaviour change.
- A timed-out `git fetch` now kills the whole process tree, including git's remote helper. Time limits are opt-in, and only `ship land` will set them, so today's commands are unaffected.

### Fixed

- When GitHub does not take the first `queued` status, `ship check` prints `✗ local-ci not started: …` and exits 1, instead of an unhandled `Command failed: gh api …` error.
- `ship check` re-checks a head whose stored result file is torn or malformed, instead of failing.
- A check on Cloudflare Workers Builds whose build has not started after 5 minutes goes back in line, instead of waiting out `timeoutMin` for a build that may have been skipped: a skipped build leaves no check run to read.

## 0.1 - 2026-11-03

### Added

- The gate: `ship check` checks a pull request merged with current main in a fresh worktree, with the config read from main, and posts the commit status `local-ci`. A diff entirely in `docsOnly` passes at once.
- Lanes and queue: a heavy and a light lane, first come first served, with `ship queue` to read them. A check whose result can no longer be used (the pull request closed or pushed to, or main gained a file that voids it) stops without a verdict.
- `ship merge` squash-merges a pull request only on a successful `local-ci` for its current head that no bot posted, and refuses when main gained a file matching `recheckOnMainChange`.
- Overflow: when the heavy lane's line is long, a check can run on Cloudflare Workers Builds or GitHub Actions; only green is taken from there, anything else is checked here.
- Deploys: `ship deploy`, `ship status`, `ship adopt`, `ship rollback` and `ship unhold` ship Cloudflare Workers from main, with probes, holds, and one deploy at a time per repository.
- Migrations: `ship migrations plan`, `apply` and `ack` clear migration files for deploy; `apply` proves declared post-conditions from the database before it clears a file.
- The leak guard: `ship leak` scans commits, messages and pushes for shapes that must not be published; it runs from `.githooks`.

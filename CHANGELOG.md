# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Fixed

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

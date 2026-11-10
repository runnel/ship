# ship

A local CI gate for solo developers: `ship check` runs your checks on your own machine and posts the GitHub commit status `local-ci` for a pull request.

## Why

Pull request CI is billed by the minute, and a laptop is fast and already paid for. But a green status posted on your word alone proves little.

ship runs the checks itself, in a fresh worktree, on the pull request merged with current main, and only then posts `local-ci`, which branch protection can require. The config is read from main, so a pull request cannot weaken its own gate, and `ship merge` refuses a `local-ci` that a bot posted.

Compare [`basecamp/gh-signoff`](https://github.com/basecamp/gh-signoff): that tool records your sign-off, ship runs the check.

## Who it is for

One developer, or a few working from one machine, running many pull requests. Not for a team that needs shared runners or several operating systems in the matrix. ship is young and run daily by its author.

## What it looks like

```
$ ship check
▸ acme/app PR #42 add-export @ 3f2a1b9 (vs main@52d4c19)
▸ groups: app (heavy lane)
… waiting for the heavy lane (2nd in line): acme/app PR #40 since 14/11, 17:21
✓ app: npm ci (14s)
✓ app: npm test (1m32s)
✓ local-ci success: app · vs main@52d4c19 · 3m47s
```

When a repository configures [overflow](docs/overflow.md) and the heavy lane's line is long, a check can run on GitHub Actions or Cloudflare Workers Builds instead of waiting:

```
▸ running on GitHub instead (812 of 3000 minutes used, 1500 kept free)
```

## Install

```bash
git clone https://github.com/runnel/ship ~/Code/ship
cd ~/Code/ship && npm link          # puts `ship` on PATH
```

Requires Node >= 24, git and an authenticated `gh`.

ship keeps its own bare clone of the repository under `~/.ship/mirrors` and clones
`https://github.com/<repo>.git` over HTTPS, whatever your local remote says. For a private
repository git needs credentials for that: run `gh auth setup-git` once.

## Minimal config

Add `ship.config.mjs` at the repository root. ship reads it from the main branch, so the pull request that adds it is checked with its own copy.

```js
export default {
  repo: 'acme/app',
  docsOnly: ['*.md', 'docs/**'],        // a diff entirely inside these passes instantly
  checks: [
    {
      name: 'app',
      lane: 'heavy',                    // one heavy check at a time on this machine
      paths: ['src/**', 'package*.json'],
      install: 'npm ci',
      steps: ['npm test'],
    },
  ],
};
```

Then require the status on main. This call **replaces the branch's whole protection**: read the
current settings first (`gh api repos/acme/app/branches/main/protection`) and carry them over.

```bash
gh api -X PUT repos/acme/app/branches/main/protection --input - <<'EOF'
{ "required_status_checks": { "strict": false, "checks": [{ "context": "local-ci" }] },
  "enforce_admins": false, "required_pull_request_reviews": null, "restrictions": null }
EOF
```

All options are in [Configure a repository](docs/configuration.md).

## Everyday commands

```bash
ship check            # the PR of the current branch (push first)
ship check --pr 42
ship merge --pr 42    # merge a PR that passed, unless main changed under its check
ship land --pr 42     # check, merge (and soon deploy) through the serial line
ship queue            # who holds each lane, who waits, and for how long
```

A check can overflow to GitHub Actions or Cloudflare Workers Builds when the line for the heavy lane is long ([Overflow](docs/overflow.md)). `ship deploy` deploys Cloudflare Workers from main and `ship status` shows what is live ([Deploy](docs/deploy.md), [Applying migrations](docs/migrations.md)).

## Documentation

- [Configure a repository](docs/configuration.md): the config file, what a step sees, branch protection.
- [Checks and merge](docs/checks-and-merge.md): how `ship check` runs, lanes and `ship queue`, `ship merge`.
- [Overflow](docs/overflow.md): GitHub Actions and Cloudflare Workers Builds.
- [Deploy](docs/deploy.md): `ship deploy`, `ship status`, adopting, holds, rollbacks.
- [Applying migrations](docs/migrations.md): `ship migrations apply` and `plan`.
- [Contributing](CONTRIBUTING.md): the tests and the leak guard, for working on ship itself.
- [Changelog](CHANGELOG.md).

## Licence

MIT

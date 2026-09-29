# ship

A local CI gate for solo developers who work on one machine: `ship check` checks a pull request
merged with the current main branch in a fresh worktree and posts a GitHub commit status
`local-ci`, which branch protection can require. Your checks run on your own hardware; GitHub
Actions is left for nightly clean runs.

## Install

```bash
git clone https://github.com/runnel/ship ~/Code/ship
cd ~/Code/ship && npm link          # puts `ship` on PATH
```

Requires Node >= 24, git and an authenticated `gh`.

## Configure a repository

Add `ship.config.mjs` at the repository root. The config is always read from the main branch,
so a pull request cannot weaken its own gate. The default export may be an object, or a function
`({ root }) => config` that can read files from the tree under check.

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
root-level file only.

Then require the status on main:

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

Output is one line per step; on failure the last lines of the failing step and the full log path
under `~/.ship/logs/`. Two checks of the same commit started at the same time run once. Pull
requests from forks are refused. Ctrl-C stops the running step, marks the status as errored and
cleans up.

## Leak guard (for this repository)

`ship leak --staged | --msg <file> | --pre-push | --all | --history [--generic-only]` scans for
shapes that must not be published, including commit author and committer identities. Enable with
`git config core.hooksPath .githooks` and create `~/.config/ship/denylist`.

## Licence

MIT

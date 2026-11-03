# Configure a repository

Configuring a repository in full: the config file, what a step sees, and the branch protection that requires `local-ci`. Back to the [README](../README.md).

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
  recheckOnMainChange: [],              // globs; see "Merge" in checks-and-merge.md (default: none)
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

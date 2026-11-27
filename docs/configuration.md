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

## Land

The optional `land` block tunes `ship land` ([Land](checks-and-merge.md#land)). Every key is optional;
the values below are the defaults. It is read from main, like the rest of the config.

```js
land: { deployAfterMin: 60, debounceSec: 120, liveWaitHours: 12 },
```

- `debounceSec`: the deploy a land starts waits until the land line of the repository has been empty
  and main has not moved for this many seconds.
- `deployAfterMin`: the longest a merge that is not live waits for that quiet before a land starts the
  deploy anyway. At most 1440 (a day), and a finite number.
- `liveWaitHours`: how long a land waits for its merge to be live before it ends with exit 3. At most
  24, because the records of the deploys a land started are kept a day.

Each must be a positive number; an unknown key in the block is a config error.

## Notify

A land that has merged and then waits for a migration nobody has cleared holds back the deploy of
everything merged after it. `ship land` usually runs in the background, where nobody reads its
output, so the optional `notify` block tells the owner some other way.

```js
notify: { command: ['node', '/path/to/post.mjs', 'post', 'D0123456789', '-'], desktop: true, timeoutSec: 30 },
```

- `command`: an argv array, run without a shell and with ship's plain child environment. It gets the
  message on stdin; exit 0 means it was sent. Optional.
- `desktop`: when there is no `command`, or it fails, show a macOS notification instead. Default
  `true`.
- `timeoutSec`: how long the command may take (default 30, at most 300).

What is sent:

- Once per migration file and hold, by the first land that sees it uncleared at main's tip: the
  repository, the file and the pull request that added it, the command that clears it (`ship
  migrations apply …`, or `ship migrations ack …` without `migrations.apply`), and the merged pull
  requests that wait behind it. A marker in `~/.ship/notified/<owner>__<repo>/` keeps every other
  land from sending it again.
- Once the file is cleared and nothing waits for a deploy any more (every deployable is live at its
  last change on main): a short second message from the land that ends live and sees that. This
  removes the marker. A marker whose file is no longer a migration at main's tip (its pull request
  was reverted), or that is older than a day, is dropped without a message, so a later hold of the
  same file is told again.

A notification that cannot be sent is said in the land's own output; the land goes on. Without the
block ship sends nothing. Notification only: nothing about applying or clearing changes.

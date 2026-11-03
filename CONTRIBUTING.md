# Contributing

Working on ship itself: how to run the tests and the leak guard. To use ship, start at the [README](README.md).

The rules for every change, and for agents working here, are in [AGENTS.md](AGENTS.md): the repository is public, so no real project, client, person or company names, ids or secrets go into a file or a commit message.

## Tests

`npm test` runs everything. It needs Node >= 24 and installs nothing: ship has no runtime dependencies. One file runs with `node --test test/merge.test.mjs`. Tests never reach the network; the deploy tests run against `test/fake-cloud.mjs`. Changes go through pull requests, and GitHub CI runs the tests.

## Leak guard (for this repository)

`ship leak --staged | --msg <file> | --pre-push [remote] | --all | --history [--generic-only]` scans for
shapes that must not be published, including commit author and committer identities. For the
commits GitHub creates itself (a squash or merge commit from the web UI or `gh pr merge`), GitHub
fills the author line from the account. When the committer is `GitHub <noreply@github.com>` and the
author address is a `users.noreply.github.com` one, that author line (name and noreply address) is
not matched against the denylist; the rest of the commit, and the generic rules on that line, apply
as usual. Both identity lines are self-asserted, so this is a narrow exemption, not proof of
origin. Besides messages and patches it reads, whole and as stored, the files in which a merge
commit differs from every parent, and it reads annotated tags and any blob or tree that a ref or a
tag names. Replace refs and grafts are ignored, and so is the config that would change what
`git log` prints (quoted file names, diff prefixes, textconv, `diff.relative`, `log.showRoot`, output
encoding). `--all` and `--history` leave `refs/stash` alone: a push sends it only when named. It
fails closed: a git error, a binary file it cannot scan, a commit message stored in an encoding
other than UTF-8, or a `git log` that does not split into exactly the commits `git rev-list` names
is a finding, not a pass. Enable with
`git config core.hooksPath .githooks` and create `~/.config/ship/denylist`. Pull requests are
judged by main's copy of the guard.

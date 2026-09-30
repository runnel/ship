# Working on ship

This repository is **public**. Before anything else:

- Never put a real project, client, person or company name, an absolute user path, an e-mail
  address, a service id (Supabase ref, Cloudflare account id, named `*.workers.dev` subdomain) or
  a secret in a file or a commit message. Use `example-app`, `example.workers.dev`,
  `acme/app`. The only e-mail addresses that may appear are `noreply@anthropic.com`,
  `noreply@github.com` (GitHub's own committer address), `*@users.noreply.github.com`,
  `git@github.com` (an SSH remote) and `example.com|org|net` addresses.
- Commits must be authored with the GitHub noreply address (`git config user.email`); the
  pre-commit hook refuses anything else.
- Incident history, measurements and war stories about a particular project belong in that
  project's own docs, not here. Comments here explain behaviour, not where it was learned.
- Test fixtures that need a forbidden shape build it from pieces (`'/Us' + 'ers/'`).
- The leak guard runs on commit, commit message and push (`git config core.hooksPath .githooks`)
  and needs `~/.config/ship/denylist` (one term per line; never committed).
- Changes go through pull requests; GitHub CI (free for public repos) runs the tests.
- Pull requests are judged by main's copy of the leak guard, not their own (the self-check and CI
  extract `lib` and `bin` from main). So a `BINARY_ALLOW` entry must land in its own pull request
  before the binary it allows, and a false positive that is already in history can only be cleared
  by the owner bypassing the branch protection.
- Zero runtime dependencies. Node >= 24. `npm test` runs everything.
- Deploy tests run against `test/fake-cloud.mjs`; tests never reach the network.

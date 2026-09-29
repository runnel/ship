// ship checks itself. No docs-only shortcut: the leak guard must read every change.
//
// A pull request must not weaken its own gate (README, "Configure a repository"), so the leak step
// runs the guard that is on main, extracted to a temporary directory, against the tree under check.
const GUARD_FROM_MAIN = [
  'set -o pipefail',
  'guard=$(mktemp -d)',
  'git archive refs/heads/main lib bin | tar -x -C "$guard"',
  'node "$guard/bin/ship.mjs" leak --all; status=$?',
  'rm -rf "$guard"',
  'exit $status',
].join('; ');

export default {
  repo: 'runnel/ship',
  checks: [
    { name: 'test', lane: 'light', paths: ['**'], steps: ['node --test "test/**/*.test.mjs"', GUARD_FROM_MAIN] },
  ],
};

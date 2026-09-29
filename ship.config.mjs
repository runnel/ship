// ship checks itself. No docs-only shortcut: the leak guard must read every change.
export default {
  repo: 'runnel/ship',
  checks: [
    { name: 'test', lane: 'light', paths: ['**'], steps: ['node --test "test/**/*.test.mjs"', 'node bin/ship.mjs leak --all'] },
  ],
};

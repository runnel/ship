import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck } from '../lib/check.mjs';
import { setupCheck as setup, CONFIG, git, tempDir } from './helpers.mjs';

test('a green check of the PR merged with main', async () => {
  const s = await setup();
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0);
  const st = await s.statuses();
  assert.equal(st[0].state, 'pending');
  assert.equal(st.at(-1).state, 'success');
  assert.match(st.at(-1).description, /^unit · vs main@[0-9a-f]{7} · \d+s$/);
});

test('a docs-only diff passes without running steps', async () => {
  const s = await setup({ featFiles: { 'README.md': 'r\n' }, steps: ['exit 9'] });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0);
  assert.match((await s.statuses()).at(-1).description, /^docs-only · vs main@/);
});

test('a failing step posts failure and prints the tail', async () => {
  const s = await setup({ steps: ['echo boom; exit 3'] });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  const last = (await s.statuses()).at(-1);
  assert.equal(last.state, 'failure');
  assert.match(last.description, /^unit: echo boom; exit 3 failed · vs main@/);
  assert.ok(s.lines.some((l) => l.includes('boom')));
});

test('a merge conflict with main posts failure', async () => {
  const s = await setup({ featFiles: { 'a.txt': 'feature\n' }, mainFiles: { 'a.txt': 'main\n' } });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  assert.match((await s.statuses()).at(-1).description, /^merge conflict with main@/);
});

test('fork PRs and PRs into another base are refused without a status', async () => {
  const fork = await setup({ prOverrides: { isCrossRepository: true } });
  assert.equal(await runCheck({ cwd: fork.work, deps: fork.deps }), 2);
  assert.equal((await fork.statuses()).length, 0);
  const other = await setup({ prOverrides: { baseRefName: 'release' } });
  assert.equal(await runCheck({ cwd: other.work, deps: other.deps }), 2);
  assert.equal((await other.statuses()).length, 0);
});

test('a detached HEAD asks for --pr', async () => {
  const s = await setup();
  await git(['checkout', '--quiet', '--detach'], s.work);
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 2);
  assert.ok(s.lines.some((l) => l.includes('--pr')));
});

test('two checks of the same SHA at once run it only once', { timeout: 60_000 }, async () => {
  // Gated, not timed: the step runs until the second check has announced that it is waiting.
  const marker = join(await tempDir(), 'second-is-waiting');
  const s = await setup({ steps: [`for i in $(seq 1 400); do test -f ${marker} && exit 0; sleep 0.05; done; exit 1`] });
  const deps = { ...s.deps, out: (l) => { s.lines.push(l); if (l.includes('already running')) writeFileSync(marker, ''); } };
  const codes = await Promise.all([runCheck({ cwd: s.work, deps }), runCheck({ cwd: s.work, deps })]);
  assert.deepEqual(codes, [0, 0]);
  assert.equal((await s.statuses()).filter((x) => x.state === 'success').length, 1);
});

test('a later check of the same commits runs again (a red result may have been flaky)', async () => {
  const s = await setup({ steps: ['exit 3'] });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  assert.equal((await s.statuses()).filter((x) => x.state === 'failure').length, 2);
});

test('a step that outlives its timeout fails the check', async () => {
  const s = await setup({ steps: ['sleep 30'], checkExtra: { timeoutMin: 0.005 } });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  assert.match((await s.statuses()).at(-1).description, /^unit: sleep 30 failed/);
});

test('per-step env reaches only that step', async () => {
  const s = await setup({ steps: ['test -z "$ONLY_B"', { run: 'test "$ONLY_B" = yes', env: { ONLY_B: 'yes' } }] });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0);
});

test('the config comes from main, not from the PR', async () => {
  // The PR rewrites the config to a no-op; the check must still run main's failing step.
  const s = await setup({
    steps: ['exit 4'],
    featFiles: { 'src/x.ts': 'x\n', 'ship.config.mjs': CONFIG(['true']) },
  });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
});

test('a repository whose main has no config yet is checked with the PR\'s own, and says so', async () => {
  const s = await setup({ mainConfig: false, steps: ['exit 5'], featFiles: { 'src/x.ts': 'x\n', 'ship.config.mjs': CONFIG(['exit 5']) } });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  assert.match((await s.statuses()).at(-1).description, /^unit: exit 5 failed/);
  assert.ok(s.lines.some((l) => l.includes('has no ship.config.mjs') && l.includes('PR')), s.lines.join('\n'));
});

test('a repository with no config anywhere is an error, not a pass', async () => {
  const s = await setup({ mainConfig: false });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  const last = (await s.statuses()).at(-1);
  assert.equal(last.state, 'error');
  assert.match(last.description, /no ship\.config\.mjs/);
});

test('a status description never carries a local path', async () => {
  // The config function quotes the worktree path it is given, as many real error messages do.
  const s = await setup({ configText: "export default ({ root }) => { throw new Error('cannot read ' + root); };\n" });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  const last = (await s.statuses()).at(-1);
  assert.equal(last.state, 'error');
  assert.ok(last.description.startsWith('config: cannot read $SHIP_TMP/w/'), last.description);
  assert.ok(!last.description.includes(s.deps.tmpRoot), last.description);
});

test('a temp root that is a symlink is refused before anything is written', async () => {
  const s = await setup();
  await mkdir(join(s.root, 'elsewhere'));
  await symlink(join(s.root, 'elsewhere'), join(s.root, 'linked-tmp'));
  await assert.rejects(() => runCheck({ cwd: s.work, deps: { ...s.deps, tmpRoot: join(s.root, 'linked-tmp') } }), /not a plain directory/);
  assert.equal((await s.statuses()).length, 0);
});

test('steps see a minimal environment: no secrets from the caller, but CI and the changed files', async () => {
  const saved = process.env.SHIP_TEST_SECRET;
  process.env.SHIP_TEST_SECRET = 'hunter2';
  try {
    const s = await setup({ steps: ['test -z "$SHIP_TEST_SECRET"', 'test "$CI" = true', 'echo "$SHIP_CHANGED_FILES" | grep -qx src/x.ts'] });
    assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0);
  } finally {
    if (saved === undefined) delete process.env.SHIP_TEST_SECRET;
    else process.env.SHIP_TEST_SECRET = saved;
  }
});

test('a PR that is not open is refused without a status', async () => {
  const s = await setup({ prOverrides: { state: 'MERGED' } });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 2);
  assert.equal((await s.statuses()).length, 0);
  assert.ok(s.lines.some((l) => l.includes('merged')), s.lines.join('\n'));
});

test('after a green and after a red check no worktree or lock directory is left behind', async () => {
  for (const steps of [['true'], ['exit 3']]) {
    const s = await setup({ steps });
    await runCheck({ cwd: s.work, deps: s.deps });
    assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'w')), []);
    assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'lanes')), []);
    assert.deepEqual(await readdir(join(s.deps.tmpRoot, 'locks')), []);
    const checks = await readdir(join(s.deps.tmpRoot, 'checks'));
    assert.ok(checks.length > 0 && checks.every((n) => n.endsWith('.json')), checks.join(','));
  }
});

test('a config that fails to import does not post the system temp path', async () => {
  const s = await setup({ configText: "import './nope.mjs';\nexport default {};\n" });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  const last = (await s.statuses()).at(-1);
  assert.equal(last.state, 'error');
  assert.ok(last.description.startsWith('config: Cannot find module'), last.description);
  assert.ok(!last.description.includes(tmpdir()), last.description);
  assert.ok(last.description.includes('$TMPDIR/'), last.description);
});

test('a deployable importing a file outside its paths fails the check', async () => {
  const configText = `export default { repo: 't/r', docsOnly: ['*.md'], checks: [{ name: 'unit', paths: ['src/**', 'lib/**'], steps: ['true'] }],
    deployables: [{ name: 'w', worker: 'example-w', cwd: 'src', paths: ['src/**'], mode: 'direct' }],
    credentials: { file: '/unused', map: { CLOUDFLARE_API_TOKEN: 'T', CLOUDFLARE_ACCOUNT_ID: 'A' } } };\n`;
  const s = await setup({ configText, featFiles: { 'src/x.ts': "import '../lib/y';\n", 'lib/y.ts': '' } });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  assert.match((await s.statuses()).at(-1).description, /deployable w imports lib\/y.ts/);
});

// One direct deployable `w` in src/; `paths` and `extra` (more deployable keys) vary.
const importConfig = (paths, { extra = '', docsOnly = "['*.md']" } = {}) => `export default { repo: 't/r', docsOnly: ${docsOnly},
  checks: [{ name: 'unit', paths: ['src/**', 'lib/**', 'docs/**'], steps: ['true'] }],
  deployables: [{ name: 'w', worker: 'example-w', cwd: 'src', paths: ${JSON.stringify(paths)}, mode: 'direct'${extra} }],
  credentials: { file: '/unused', map: { CLOUDFLARE_API_TOKEN: 'T', CLOUDFLARE_ACCOUNT_ID: 'A' } } };\n`;
const MAIN_VIOLATES = { 'src/x.ts': "import '../lib/y';\n", 'lib/y.ts': '' };
const lastStatus = async (s) => (await s.statuses()).at(-1);

test('the import check also treats an ignored or docs-only import as outside', async () => {
  const ignored = await setup({ configText: importConfig(['src/**'], { extra: ", ignore: ['src/gen/**']" }), featFiles: { 'src/x.ts': "import './gen/z';\n", 'src/gen/z.ts': '' } });
  assert.equal(await runCheck({ cwd: ignored.work, deps: ignored.deps }), 1);
  assert.match((await lastStatus(ignored)).description, /deployable w imports src\/gen\/z.ts \(from src\/x.ts\)/);
  const docs = await setup({ configText: importConfig(['src/**', 'docs/**'], { docsOnly: "['docs/**']" }), featFiles: { 'src/x.ts': "import '../docs/y';\n", 'docs/y.ts': '' } });
  assert.equal(await runCheck({ cwd: docs.work, deps: docs.deps }), 1);
  assert.match((await lastStatus(docs)).description, /deployable w imports docs\/y.ts \(from src\/x.ts\)/);
});

test('an ignored test that imports its own helper passes the import check', async () => {
  const s = await setup({ configText: importConfig(['src/**'], { extra: ", ignore: ['src/test/**']" }), featFiles: { 'src/test/a.test.ts': "import './helpers';\n", 'src/test/helpers.ts': '' } });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0, s.lines.join('\n'));
});

test('a violation that is already on main does not fail the pull request that widens the paths', async () => {
  const s = await setup({ configText: importConfig(['src/**']), mainFiles: MAIN_VIOLATES, featFiles: { 'ship.config.mjs': importConfig(['src/**', 'lib/**']) } });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0, s.lines.join('\n'));
  assert.equal((await lastStatus(s)).state, 'success');
});

test('a pull request that leaves the paths alone still fails on the violation on main', async () => {
  const s = await setup({ configText: importConfig(['src/**']), mainFiles: MAIN_VIOLATES, featFiles: { 'docs/notes.txt': 'n\n' } });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  assert.match((await lastStatus(s)).description, /deployable w imports lib\/y.ts \(from src\/x.ts\)/);
});

test('widening the paths for one import does not excuse a new violation', async () => {
  const s = await setup({ configText: importConfig(['src/**']), mainFiles: MAIN_VIOLATES,
    featFiles: { 'ship.config.mjs': importConfig(['src/**', 'lib/y.ts']), 'src/z.ts': "import '../lib/w';\n", 'lib/w.ts': '' } });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  assert.match((await lastStatus(s)).description, /deployable w imports lib\/w.ts \(from src\/z.ts\)/);
  assert.doesNotMatch((await lastStatus(s)).description, /lib\/y.ts/);
});

test('a config in the pull request that cannot be loaded leaves main\'s verdict as it is', async () => {
  const s = await setup({ configText: importConfig(['src/**']), mainFiles: MAIN_VIOLATES, featFiles: { 'ship.config.mjs': 'export default {\n' } });
  assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 1);
  assert.match((await lastStatus(s)).description, /deployable w imports lib\/y.ts/);
});

test('the pull request\'s own config runs outside ship\'s process and without its environment', async () => {
  process.env.SHIP_TEST_CALLER_SECRET = 'must-not-leak';
  try {
    // It widens the paths only when it cannot see the caller's variable, and marks the process it runs in.
    const widening = importConfig(['src/**', 'lib/**']).replace('export default', "globalThis.__shipPullRequestConfigRan = true;\nconst paths = process.env.SHIP_TEST_CALLER_SECRET ? ['src/**'] : ['src/**', 'lib/**'];\nexport default")
      .replace('paths: ["src/**","lib/**"]', 'paths');
    const s = await setup({ configText: importConfig(['src/**']), mainFiles: MAIN_VIOLATES, featFiles: { 'ship.config.mjs': widening } });
    assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0, s.lines.join('\n'));
    assert.equal(globalThis.__shipPullRequestConfigRan, undefined);
  } finally {
    delete process.env.SHIP_TEST_CALLER_SECRET;
  }
});

test('a pull request config that ignores SIGTERM cannot hang the check: it is killed and main\'s verdict stands', { timeout: 60_000 }, async () => {
  // A busy loop with a SIGTERM handler installed: the signal is never acted on, only SIGKILL ends it.
  const hostile = "process.on('SIGTERM', () => {});\nfor (;;) {}\nexport default {};\n";
  const s = await setup({ configText: importConfig(['src/**']), mainFiles: MAIN_VIOLATES, featFiles: { 'ship.config.mjs': hostile } });
  const started = Date.now();
  assert.equal(await runCheck({ cwd: s.work, deps: { ...s.deps, treeConfigTimeoutMs: 1500 } }), 1);
  assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
  assert.match((await lastStatus(s)).description, /deployable w imports lib\/y.ts/);
});

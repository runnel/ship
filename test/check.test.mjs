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

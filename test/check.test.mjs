import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runCheck } from '../lib/check.mjs';
import { makeOrigin, commitFiles, git, fakeGh } from './helpers.mjs';

const CONFIG = (steps, extra = {}) =>
  `export default { repo: 't/r', docsOnly: ['*.md'], checks: [${JSON.stringify({ name: 'unit', paths: ['src/**'], steps, ...extra })}] };\n`;

// origin: main has the config + a.txt; branch feat adds featFiles; main then moves with mainFiles.
async function setup({
  steps = ['test -f src/x.ts', 'test -f b.txt'], checkExtra = {},
  featFiles = { 'src/x.ts': 'x\n' }, mainFiles = { 'b.txt': 'b\n' }, prOverrides = {},
} = {}) {
  const { origin, work, root } = await makeOrigin({ 'ship.config.mjs': CONFIG(steps, checkExtra), 'a.txt': 'a\n' });
  await git(['checkout', '--quiet', '-b', 'feat'], work);
  const head = await commitFiles(work, featFiles, 'feat');
  await git(['push', '--quiet', 'origin', 'feat'], work);
  await git(['checkout', '--quiet', 'main'], work);
  await commitFiles(work, mainFiles, 'main moves');
  await git(['push', '--quiet', 'origin', 'main'], work);
  await git(['checkout', '--quiet', 'feat'], work);
  await git(['remote', 'set-url', 'origin', 'https://github.com/t/r.git'], work);
  const pr = { number: 7, headRefOid: head, headRefName: 'feat', baseRefName: 'main', isCrossRepository: false, state: 'OPEN', ...prOverrides };
  const fake = await fakeGh(root, { pr });
  const lines = [];
  const deps = {
    gh: fake.gh, remoteUrl: () => origin,
    mirrorRoot: join(root, 'mirrors'), tmpRoot: join(root, 'tmp'), logRoot: join(root, 'logs'),
    out: (s) => lines.push(s), pollMs: 10,
  };
  const statuses = async () =>
    (await fake.calls())
      .filter((a) => a[0] === 'api')
      .map((a) => Object.fromEntries(a.filter((x) => /^(state|description)=/.test(x)).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)])));
  return { work, deps, statuses, lines };
}

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

test('two checks of the same SHA at once run it only once', async () => {
  const s = await setup({ steps: ['sleep 0.3'] });
  const codes = await Promise.all([runCheck({ cwd: s.work, deps: s.deps }), runCheck({ cwd: s.work, deps: s.deps })]);
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

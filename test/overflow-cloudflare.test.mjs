import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCheck } from '../lib/check.mjs';
import { ownerInfo, tryLock } from '../lib/lock.mjs';
import { firstGate } from '../lib/overflow.mjs';
import { BUILD_APP, buildVerdict, cloudflareGate, overlayFiles } from '../lib/overflow-cloudflare.mjs';
import { checkRuns } from '../lib/github.mjs';
import { fakeGh, git, killQuietly, longLine, setupCheck, spawnCheckLeader, tempDir, waitUntil } from './helpers.mjs';

const LOTS_LEFT = { usageItems: [{ product: 'actions', unitType: 'Minutes', sku: 'Actions Linux', quantity: 100, repositoryName: 'r' }] };
// GitHub's own rules never let a check go here unless a test says so (minAhead 99).
const GITHUB = { workflow: 'ship-check.yml', includedMinutes: 3000, reservePerDay: 60, reserveFloor: 300, minAhead: 99, maxRunning: 1 };
const CLOUDFLARE = { repo: 'acme/app-runner', branch: 'run', checkName: 'Workers Builds: app-runner', minAhead: 1, maxRunning: 1, timeoutMin: 25 };

const configText = (steps, overflow, check = {}) => `export default { repo: 't/r', docsOnly: ['*.md'], checks: [${JSON.stringify({ name: 'unit', lane: 'heavy', paths: ['src/**'], steps, ...check })}], overflow: ${JSON.stringify(overflow)} };\n`;

// `cloudflare`: what to change in the Cloudflare part of the config (null: none at all); `overflow`: in the
// GitHub part; `builds`: what the build leaves on a commit of the runner repository (see fakeGh);
// `featFiles` may be a function of the config text on main. The runner repository is a bare one beside the
// origin.
async function setup({ steps = ['true'], cloudflare = {}, overflow = {}, check = {}, builds = {}, github = { usage: LOTS_LEFT }, featFiles, ...rest } = {}) {
  const text = configText(steps, { ...GITHUB, ...overflow, ...(cloudflare === null ? {} : { cloudflare: { ...CLOUDFLARE, ...cloudflare } }) }, check);
  const s = await setupCheck({
    configText: text, ghOptions: { cloudflare: builds, github },
    ...(featFiles ? { featFiles: typeof featFiles === 'function' ? featFiles(text) : featFiles } : {}), ...rest,
  });
  s.runner = join(s.root, 'runner.git');
  await git(['init', '--bare', '--quiet', '--initial-branch=main', s.runner]);
  s.deps.remoteUrl = (repo) => (repo === CLOUDFLARE.repo ? s.runner : s.origin);
  s.configText = text;
  return s;
}

const says = (s, re) => s.lines.some((l) => re.test(l));
const dispatches = async (s) => (await s.calls()).filter((c) => c[0] === 'api' && c[3]?.endsWith('/dispatches'));
const billingReads = async (s) => (await s.calls()).filter((c) => c[0] === 'api' && c[1]?.includes('/billing/'));
const cancels = async (s) => (await s.calls()).filter((c) => c[0] === 'api' && c[3]?.endsWith('/cancel'));
// The commits on the runner branch, newest first, as [{ sha, parents }].
const pushes = async (s) => {
  const text = await git(['--git-dir', s.runner, 'rev-list', '--parents', 'refs/heads/run']).catch(() => '');
  return text.trim().split('\n').filter(Boolean).map((l) => { const [sha, ...parents] = l.split(' '); return { sha, parents }; });
};
const inRunner = (s, path, ref = 'refs/heads/run') => git(['--git-dir', s.runner, 'show', `${ref}:${path}`]);
const treeOf = async (s, ref) => (await git(['--git-dir', s.runner, 'ls-tree', '-r', ref])).split('\n').filter((l) => l && !l.includes('\t.ship-run/')).join('\n');
const ledgerExists = (s) => stat(join(s.deps.overflowRoot, 'runs.jsonl')).then(() => true, () => false);
// Held by this live process, a place that was not given back cannot be taken.
const assertPlaceFree = async (s, kind = 'cloudflare', n = 0) => {
  const free = await tryLock(join(s.deps.tmpRoot, 'lanes', `${kind}-${n}`), await ownerInfo());
  assert.ok(free, 'the place is free again');
  await free();
};
const noRedStatus = (st) => assert.equal(st.filter((x) => x.state === 'failure' || x.state === 'error').length, 0, 'an infrastructure failure must not read as red');

// --- when a check goes ---------------------------------------------------------------------------

test('a long line: Cloudflare takes the check first, ship posts the green, nothing runs here, GitHub is not asked', { timeout: 60_000 }, async () => {
  const s = await setup({ steps: ['exit 9'], overflow: { minAhead: 1 } }); // GitHub would take it too, and the step would be red here
  const line = await longLine(s);
  try {
    assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0);
  } finally {
    await line.free();
  }
  assert.equal((await pushes(s)).length, 1);
  assert.equal((await dispatches(s)).length, 0);
  assert.equal((await billingReads(s)).length, 0, 'there are no Cloudflare minutes to read, and GitHub\'s are not spent');
  assert.equal(await ledgerExists(s), false, 'a Cloudflare run is not in the GitHub ledger');
  const st = await s.statuses();
  assert.ok(st.some((x) => x.state === 'pending' && /on Cloudflare/.test(x.description)));
  const last = st.at(-1);
  assert.equal(last.state, 'success');
  assert.match(last.description, /^unit · vs main@[0-9a-f]{7} · \d+\S* · on Cloudflare$/, 'ship merge reads the main out of it');
  assert.equal(last.target_url, 'https://example.com/builds/77', 'the page of the check run that gave the verdict');
  assert.ok(says(s, /running on Cloudflare Workers Builds instead/));
  await assertPlaceFree(s);
});

test('Cloudflare is full: GitHub takes the check, and says why Cloudflare did not', { timeout: 60_000 }, async () => {
  const s = await setup({ overflow: { minAhead: 1 } });
  const line = await longLine(s);
  const taken = await tryLock(join(s.deps.tmpRoot, 'lanes', 'cloudflare-0'), await ownerInfo({ repo: 'o/x', pr: 3 }));
  try {
    assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0);
  } finally {
    await taken();
    await line.free();
  }
  assert.equal((await pushes(s)).length, 0);
  assert.equal((await dispatches(s)).length, 1);
  assert.equal(s.lines.filter((l) => /^· Cloudflare: 1 run\(s\) going already/.test(l)).length, 1, 'said once, however often it is asked');
  assert.match((await s.statuses()).at(-1).description, /on GitHub$/);
});

test('Cloudflare does not take a group of this check: GitHub does', { timeout: 60_000 }, async () => {
  const s = await setup({ overflow: { minAhead: 1 }, cloudflare: { groups: [] } });
  const line = await longLine(s);
  try {
    assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0);
  } finally {
    await line.free();
  }
  assert.equal((await pushes(s)).length, 0);
  assert.equal((await dispatches(s)).length, 1);
});

test('a line too short for Cloudflare but long enough for GitHub goes to GitHub; too short for both, it waits here', { timeout: 60_000 }, async () => {
  const s = await setup({ overflow: { minAhead: 1 }, cloudflare: { minAhead: 2 } });
  const line = await longLine(s);
  try {
    assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0);
  } finally {
    await line.free();
  }
  assert.equal((await pushes(s)).length, 0, 'one ahead is not two');
  assert.equal((await dispatches(s)).length, 1);

  const waits = await setup({ cloudflare: { minAhead: 2 } });
  const queue = await longLine(waits);
  const check = runCheck({ cwd: waits.work, deps: waits.deps });
  await waitUntil(() => says(waits, /2nd in line/), 'the check is in line');
  await queue.free();
  assert.equal(await check, 0);
  assert.equal((await pushes(waits)).length, 0);
  assert.doesNotMatch((await waits.statuses()).at(-1).description, /on (Cloudflare|GitHub)/);
});

test('--cloudflare goes without a line, and a full Cloudflare still holds it back', { timeout: 60_000 }, async () => {
  const go = await setup({ steps: ['exit 9'], cloudflare: { minAhead: 5 } });
  assert.equal(await runCheck({ cwd: go.work, cloudflare: true, deps: go.deps }), 0);
  assert.equal((await pushes(go)).length, 1);
  const full = await setup({ cloudflare: { minAhead: 5 } });
  const taken = await tryLock(join(full.deps.tmpRoot, 'lanes', 'cloudflare-0'), await ownerInfo({ repo: 'o/x', pr: 3 }));
  assert.equal(await runCheck({ cwd: full.work, cloudflare: true, deps: full.deps }), 0);
  await taken();
  assert.equal((await pushes(full)).length, 0);
  assert.ok(says(full, /Cloudflare: 1 run\(s\) going already/));
});

test('--cloudflare says what keeps a check away: a light lane, no Cloudflare in the config, a group it does not take', { timeout: 60_000 }, async () => {
  const light = await setup({ check: { lane: 'light' } });
  assert.equal(await runCheck({ cwd: light.work, cloudflare: true, deps: light.deps }), 0);
  assert.equal((await pushes(light)).length, 0);
  assert.ok(says(light, /--cloudflare: this check cannot run on Cloudflare/));
  const none = await setup({ cloudflare: null });
  assert.equal(await runCheck({ cwd: none.work, cloudflare: true, deps: none.deps }), 0);
  assert.ok(says(none, /--cloudflare: this check cannot run on Cloudflare/));
  const only = await setup({ cloudflare: { groups: [] } });
  assert.equal(await runCheck({ cwd: only.work, cloudflare: true, deps: only.deps }), 0);
  assert.ok(says(only, /--cloudflare: this check cannot run on Cloudflare/));
});

test('a pull request cannot turn Cloudflare on for itself: only main\'s config counts', { timeout: 60_000 }, async () => {
  const text = configText(['true'], { ...GITHUB, cloudflare: CLOUDFLARE });
  const s = await setupCheck({ mainConfig: false, featFiles: { 'src/x.ts': 'x\n', 'ship.config.mjs': text }, ghOptions: { cloudflare: {}, github: { usage: LOTS_LEFT } } });
  s.runner = join(s.root, 'runner.git');
  await git(['init', '--bare', '--quiet', '--initial-branch=main', s.runner]);
  s.deps.remoteUrl = (repo) => (repo === CLOUDFLARE.repo ? s.runner : s.origin);
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0);
  assert.equal((await pushes(s)).length, 0);
});

// --- what the build is given ---------------------------------------------------------------------------

const SETUP_ON_MAIN = 'main setup\n';
const withPrOverlay = (text) => ({
  'src/x.ts': 'x\n',
  'scripts/remote-setup.sh': 'PR setup\n',
  'ship.config.mjs': `${text}// the pull request changed this\n`,
  '.ship-run/run.sh': 'PR run\n',
  '.ship-run/setup.sh': 'PR setup.sh\n',
  '.ship-run/extra': 'x\n',
});

test('the build gets main\'s config, setup and the constant script, never the pull request\'s; the rest is the merged tree', { timeout: 60_000 }, async () => {
  const ok = await setup({
    cloudflare: { setup: 'scripts/remote-setup.sh', env: { unit: { SOME_VAR: '{root}/scripts/x.cjs' } } },
    baseFiles: { 'scripts/remote-setup.sh': SETUP_ON_MAIN },
    featFiles: withPrOverlay,
  });
  assert.equal(await runCheck({ cwd: ok.work, cloudflare: true, deps: ok.deps }), 0, ok.lines.join('\n'));
  const [tip] = await pushes(ok);
  assert.deepEqual(tip.parents, [], 'the branch did not exist: no parent');
  assert.equal(await inRunner(ok, '.ship-run/config.mjs'), ok.configText, 'main\'s config, not the one the pull request changed');
  assert.equal(await inRunner(ok, '.ship-run/setup.sh'), SETUP_ON_MAIN, 'main\'s script, not the pull request\'s');
  assert.equal(await inRunner(ok, '.ship-run/run.sh'), await readFile(new URL('../lib/cloudflare-run.sh', import.meta.url), 'utf8'), 'the constant of ship, not the pull request\'s');
  await assert.rejects(inRunner(ok, '.ship-run/extra'), undefined, 'nothing else of the pull request\'s in the directory');
  assert.equal(await inRunner(ok, '.ship-run/groups'), 'unit\n');
  assert.equal(await inRunner(ok, '.ship-run/changed-files'), ['.ship-run/extra', '.ship-run/run.sh', '.ship-run/setup.sh', 'scripts/remote-setup.sh', 'ship.config.mjs', 'src/x.ts'].map((f) => `${f}\n`).join(''));
  assert.equal(await inRunner(ok, '.ship-run/ship-sha'), `${'c'.repeat(40)}\n`);
  assert.match(await inRunner(ok, '.ship-run/nonce'), /^[0-9a-f]{24}\n$/);
  assert.deepEqual(JSON.parse(await inRunner(ok, '.ship-run/env.json')), { unit: { SOME_VAR: '{root}/scripts/x.cjs' } }, '{root} is the build\'s to expand');
  // Around the directory the tree is the one ship got from merging the head with main.
  assert.equal(await inRunner(ok, 'scripts/remote-setup.sh'), 'PR setup\n');
  assert.equal(await inRunner(ok, 'ship.config.mjs'), `${ok.configText}// the pull request changed this\n`);
  const merged = (await git(['merge-tree', '--write-tree', 'feat', 'main'], ok.work)).trim();
  const around = (await git(['ls-tree', '-r', merged], ok.work)).split('\n').filter((l) => l && !l.includes('\t.ship-run/')).join('\n');
  assert.equal(await treeOf(ok, 'refs/heads/run'), around);
  // Only ship's commits are on the runner branch: none of the repository's own history is pushed.
  assert.equal((await git(['--git-dir', ok.runner, 'log', '--format=%an <%ae>', 'refs/heads/run'])).trim(), 'ship <ship@localhost>');
  assert.match((await git(['--git-dir', ok.runner, 'log', '-1', '--format=%s', 'refs/heads/run'])).trim(), /^ship check t\/r PR #7 @ [0-9a-f]{7} \(vs main@[0-9a-f]{7}\)$/);
});

test('the next check builds on the branch\'s tip, and the branch holds only ship\'s commits', { timeout: 60_000 }, async () => {
  const s = await setup();
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0);
  const [first] = await pushes(s);
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0);
  const both = await pushes(s);
  assert.equal(both.length, 2, 'the first check\'s commit is still there');
  assert.deepEqual(both[0].parents, [first.sha], 'the parent is the tip it found');
  assert.deepEqual(both[1], first);
  assert.equal(both.length, Number((await git(['--git-dir', s.runner, 'rev-list', '--count', 'refs/heads/run'])).trim()));
  const mirrorRefs = await git(['--git-dir', join(s.deps.mirrorRoot, 't__r.git'), 'for-each-ref', '--format=%(refname)', 'refs/ship']);
  assert.equal(mirrorRefs.trim(), 'refs/ship/cloudflare/tip/run', 'the private ref the tip was fetched into does not stay; the one that keeps the chain does');
});

test('checking the same tree again still changes a file: every overlay has a nonce of its own', { timeout: 60_000 }, async () => {
  const s = await setup();
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0);
  const [first] = await pushes(s);
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0);
  const [second] = await pushes(s);
  assert.notEqual(second.sha, first.sha);
  const nonce = (sha) => inRunner(s, '.ship-run/nonce', sha);
  assert.notEqual(await nonce(second.sha), await nonce(first.sha));
  const changed = (await git(['--git-dir', s.runner, 'diff', '--name-only', first.sha, second.sha])).trim().split('\n');
  assert.deepEqual(changed, ['.ship-run/nonce'], 'the tree around it was the same, and that is the one file a watch path sees');
});

test('the mirror keeps the runner branch\'s last commit under a ref of its own, so that its chain is not pruned or fetched again', { timeout: 60_000 }, async () => {
  const s = await setup();
  const mirror = join(s.deps.mirrorRoot, 't__r.git');
  const kept = () => git(['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', 'refs/ship/cloudflare/tip/run']).then((t) => t.trim(), () => null);
  assert.equal(await kept(), null);
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0);
  const [first] = await pushes(s);
  assert.equal(await kept(), first.sha);
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0);
  const [second] = await pushes(s);
  assert.equal(await kept(), second.sha, 'moved on with the branch');
  assert.equal((await git(['--git-dir', mirror, 'merge-base', '--is-ancestor', first.sha, second.sha]).then(() => 'yes', () => 'no')), 'yes');
  assert.equal((await git(['--git-dir', mirror, 'for-each-ref', '--format=%(refname)', 'refs/ship'])).trim(), 'refs/ship/cloudflare/tip/run', 'the refs of single calls are gone');
});

test('a ref the mirror cannot keep does not fail the check', { timeout: 60_000 }, async () => {
  const s = await setup();
  const mirror = join(s.deps.mirrorRoot, 't__r.git');
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0); // makes the mirror
  const [first] = await pushes(s);
  // A ref below the one that would be kept: git cannot have both.
  await git(['--git-dir', mirror, 'update-ref', '-d', 'refs/ship/cloudflare/tip/run']);
  await git(['--git-dir', mirror, 'update-ref', 'refs/ship/cloudflare/tip/run/blocker', first.sha]);
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0);
  assert.match((await s.statuses()).at(-1).description, /on Cloudflare$/);
  assert.equal((await pushes(s)).length, 2);
});

test('a setup script main does not have: nothing is pushed, the check waits here', { timeout: 60_000 }, async () => {
  const s = await setup({ cloudflare: { setup: 'scripts/missing.sh' } });
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0);
  assert.equal((await pushes(s)).length, 0);
  assert.ok(says(s, /the setup script scripts\/missing\.sh is not on main — back in line/));
  noRedStatus(await s.statuses());
});

test('overlayFiles: only the groups that run get variables; no setup, no setup.sh', () => {
  const base = { run: 'r', config: 'c', groups: ['a', 'b'], files: ['x', 'y z'], shipSha: 'f'.repeat(40), env: { a: { A: '1' }, c: { C: '3' } }, setup: null, nonce: 'abc123' };
  const files = overlayFiles(base);
  assert.deepEqual(Object.keys(files).sort(), ['changed-files', 'config.mjs', 'env.json', 'groups', 'nonce', 'run.sh', 'ship-sha']);
  assert.equal(files.nonce, 'abc123\n');
  assert.equal(files.groups, 'a,b\n');
  assert.equal(files['changed-files'], 'x\ny z\n');
  assert.deepEqual(JSON.parse(files['env.json']), { a: { A: '1' } });
  assert.equal(overlayFiles({ ...base, setup: 'echo hi\n' })['setup.sh'], 'echo hi\n');
  assert.equal(overlayFiles({ ...base, files: [] })['changed-files'], '');
});

// --- when Cloudflare does not say green ----------------------------------------------------------------

// Only a completed, successful run of the Workers Builds app, named as configured, on the commit that was
// pushed, is green. Everything else sends the check back to its old place in line, with no red verdict.
const backHere = (name, builds, { why, cloudflare = {}, blindMs } = {}) =>
  test(`${name}: the check goes back in line and this machine gives the verdict`, { timeout: 60_000 }, async () => {
    const s = await setup({ overflow: { minAhead: 1 }, cloudflare, builds }); // GitHub would take it, if it were asked
    const line = await longLine(s);
    const check = runCheck({ cwd: s.work, deps: { ...s.deps, ...(blindMs ? { cloudflareBlindMs: blindMs } : {}) } });
    await waitUntil(() => says(s, /back in line on this machine/), 'it comes back');
    await new Promise((r) => setTimeout(r, 200)); // the line is still long: it must not go a second time, to either
    assert.equal((await pushes(s)).length, 1, 'one try per check');
    assert.equal((await dispatches(s)).length, 0, 'and not to GitHub after Cloudflare');
    await assertPlaceFree(s);
    await line.free();
    assert.equal(await check, 0);
    const st = await s.statuses();
    noRedStatus(st);
    assert.equal(st.at(-1).state, 'success');
    assert.doesNotMatch(st.at(-1).description, /on (Cloudflare|GitHub)/);
    assert.equal(st.at(-1).target_url, undefined);
    assert.ok(says(s, why), s.lines.join('\n'));
    assert.equal(await ledgerExists(s), false);
  });

const SHORT = { timeoutMin: 0.001 };
backHere('the build is red', { runs: [[{ conclusion: 'failure' }]] }, { why: /the Cloudflare build was red: https:\/\/example\.com\/builds\/77/ });
for (const conclusion of ['cancelled', 'timed_out', 'neutral', 'skipped', 'action_required', 'stale']) {
  backHere(`the build ends as ${conclusion}`, { runs: [[{ conclusion }]] }, { why: new RegExp(`ended as ${conclusion}`) });
}
backHere('the build is still going', { runs: [[{ status: 'in_progress', conclusion: null }]] }, { why: /no result after/, cloudflare: SHORT });
backHere('the build is queued', { runs: [[{ status: 'queued', conclusion: null }]] }, { why: /no result after/, cloudflare: SHORT });
backHere('a run in progress that already says success', { runs: [[{ status: 'in_progress', conclusion: 'success' }]] }, { why: /no result after/, cloudflare: SHORT });
backHere('there is no check run at all', { runs: [[]] }, { why: /no result after/, cloudflare: SHORT });
backHere('the name is not the configured one', { runs: [[{ name: 'Workers Builds: other-worker' }]] }, { why: /no result after/, cloudflare: SHORT });
backHere('another app made the check run, under the right name', { runs: [[{ app: { slug: 'github-actions' } }]] }, { why: /no result after/, cloudflare: SHORT });
backHere('the check run has no app', { runs: [[{ app: null }]] }, { why: /no result after/, cloudflare: SHORT });
backHere('the check run is for another commit', { runs: [[{ head_sha: 'f'.repeat(40) }]] }, { why: /no result after/, cloudflare: SHORT });
backHere('a genuine red beside a forged green', { runs: [[{ conclusion: 'failure' }, { app: { slug: 'github-actions' } }, { name: 'Workers Builds: other-worker' }]] }, { why: /build was red/ });
backHere('a genuine red beside a genuine green', { runs: [[{}, { conclusion: 'failure' }]] }, { why: /build was red/ });
backHere('a genuine neutral beside a genuine green', { runs: [[{ conclusion: 'neutral' }, {}]] }, { why: /ended as neutral/ });
backHere('GitHub stops answering', { readFails: 1e6 }, { why: /GitHub has not answered/, blindMs: 30 });

test('a genuine green is green whatever else is on the commit', { timeout: 60_000 }, async () => {
  const s = await setup({ steps: ['exit 9'], builds: { runs: [[{ app: { slug: 'github-actions' }, conclusion: 'failure' }, { name: 'Workers Builds: other-worker', conclusion: 'failure' }, { head_sha: 'f'.repeat(40), conclusion: 'failure' }, {}]] } });
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0);
  assert.match((await s.statuses()).at(-1).description, /on Cloudflare$/);
});

test('a build that is not over at first is waited for; a short wobble in GitHub\'s answers does not end the wait', { timeout: 60_000 }, async () => {
  const s = await setup({ steps: ['exit 9'], builds: { readFails: 2, runs: [[], [{ status: 'in_progress', conclusion: null }], [{}]] } });
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: { ...s.deps, cloudflareBlindMs: 60_000 } }), 0);
  assert.match((await s.statuses()).at(-1).description, /on Cloudflare$/);
});

test('buildVerdict: exactly the app, the name and the commit; completed and successful', () => {
  const sha = 'a'.repeat(40);
  const run = { name: 'Workers Builds: w', head_sha: sha, status: 'completed', conclusion: 'success', html_url: 'u', app: { slug: BUILD_APP } };
  const verdict = (...runs) => buildVerdict(runs, { sha, checkName: 'Workers Builds: w' });
  assert.deepEqual(verdict(run), { done: true, ok: true, url: 'u' });
  assert.deepEqual(verdict({ ...run, conclusion: 'failure' }), { done: true, ok: false, conclusion: 'failure', url: 'u' });
  assert.deepEqual(verdict(), { done: false });
  for (const [what, other] of [
    ['another name', { name: 'Workers Builds: w2' }], ['a name that only contains it', { name: 'x Workers Builds: w' }], ['another case', { name: 'workers builds: w' }],
    ['another app', { app: { slug: 'github-actions' } }], ['a slug that only contains it', { app: { slug: `${BUILD_APP}-x` } }], ['no app', { app: null }],
    ['another commit', { head_sha: 'b'.repeat(40) }], ['no commit', { head_sha: undefined }],
  ]) {
    assert.deepEqual(verdict({ ...run, ...other }), { done: false }, what);
    assert.deepEqual(verdict({ ...run, ...other, conclusion: 'failure' }), { done: false }, `${what}: nor red`);
  }
  for (const [status, conclusion] of [['in_progress', null], ['in_progress', 'success'], ['queued', null], ['queued', 'success'], ['requested', null]]) {
    assert.deepEqual(verdict({ ...run, status, conclusion }), { done: false }, `${status}/${conclusion}`);
  }
  for (const conclusion of ['neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', null]) {
    const v = verdict({ ...run, conclusion });
    assert.equal(v.done && v.ok, false, String(conclusion));
  }
  // A run of ours that is over and not a success is not green, whatever else is on the commit; one that is not over says nothing.
  for (const conclusion of ['failure', 'neutral', 'cancelled', 'timed_out']) {
    assert.deepEqual(verdict(run, { ...run, conclusion }), { done: true, ok: false, conclusion, url: 'u' }, `a success beside ${conclusion}`);
    assert.deepEqual(verdict({ ...run, conclusion }, run), { done: true, ok: false, conclusion, url: 'u' }, `${conclusion} beside a success`);
  }
  assert.equal(verdict(run, { ...run, conclusion: 'failure', app: { slug: 'github-actions' } }).ok, true, 'but another app\'s red is not ours');
  assert.equal(verdict(run, { ...run, status: 'in_progress', conclusion: null }).ok, true, 'and a build going again says nothing yet');
  assert.equal(verdict(run, run).ok, true, 'two successes are green');
});

test('a push the runner repository refuses: the check goes back in line', { timeout: 60_000 }, async () => {
  const s = await setup({ overflow: { minAhead: 1 } });
  await mkdir(join(s.runner, 'hooks'), { recursive: true });
  await writeFile(join(s.runner, 'hooks', 'pre-receive'), '#!/bin/sh\necho "branch is protected" >&2\nexit 1\n');
  await chmod(join(s.runner, 'hooks', 'pre-receive'), 0o755);
  const line = await longLine(s);
  const check = runCheck({ cwd: s.work, deps: s.deps });
  await waitUntil(() => says(s, /back in line on this machine/), 'it comes back');
  await line.free();
  assert.equal(await check, 0);
  assert.ok(says(s, /the Cloudflare run could not be started \(.*\)/), s.lines.join('\n'));
  assert.equal((await pushes(s)).length, 0);
  assert.equal((await dispatches(s)).length, 0, 'GitHub is not tried after Cloudflare');
  noRedStatus(await s.statuses());
  await assertPlaceFree(s);
});

test('a runner repository that cannot be read: the check goes back in line', { timeout: 60_000 }, async () => {
  const s = await setup();
  s.deps.remoteUrl = (repo) => (repo === CLOUDFLARE.repo ? join(s.root, 'no-such-repository.git') : s.origin);
  assert.equal(await runCheck({ cwd: s.work, cloudflare: true, deps: s.deps }), 0);
  assert.ok(says(s, /the Cloudflare run could not be started/));
  noRedStatus(await s.statuses());
  assert.doesNotMatch((await s.statuses()).at(-1).description, /on Cloudflare/);
});

// --- when the check ends before the build ---------------------------------------------------------------

test('Ctrl-C while on Cloudflare says error and frees the place; there is no run to cancel', { timeout: 60_000 }, async () => {
  const dir = await tempDir('cloudflare-int-');
  const s = await setup({ builds: { runs: [[{ status: 'in_progress', conclusion: null }]] } });
  // The flow sleeps between looks, as it does for 20 s in use: only the unwind is awake.
  const run = await spawnCheckLeader(s, dir, { cloudflare: true, cloudflarePollMs: 120_000, runner: { repo: CLOUDFLARE.repo, url: s.runner } });
  try {
    await waitUntil(async () => (await s.statuses()).some((x) => /on Cloudflare/.test(x.description ?? '')), 'the run has started', 30_000);
    await new Promise((r) => setTimeout(r, 300));
    process.kill(-run.child.pid, 'SIGINT');
    await run.exited;
    assert.equal((await s.statuses()).at(-1).state, 'error');
    assert.equal((await cancels(s)).length, 0, 'the build cannot be cancelled from here, and nothing else is');
    await assert.rejects(stat(join(s.deps.tmpRoot, 'lanes', 'cloudflare-0')), { code: 'ENOENT' }, 'given back, not left for the next to take over');
  } finally {
    run.kill();
    killQuietly(run.child.pid);
  }
});

test('a pull request that moves on while its check is on Cloudflare: the wait ends, no verdict', { timeout: 60_000 }, async () => {
  const s = await setup({ builds: { runs: [[{ status: 'in_progress', conclusion: null }]] } });
  const check = runCheck({ cwd: s.work, cloudflare: true, deps: { ...s.deps, doomedPollMs: 20 } });
  await waitUntil(() => says(s, /Cloudflare run:/), 'the run has started');
  await s.setPr({ headRefOid: 'f'.repeat(40) });
  assert.equal(await check, 2);
  assert.ok(says(s, /stopped checking PR #7/));
  assert.equal((await s.statuses()).filter((x) => x.state === 'success' || x.state === 'failure').length, 0);
  assert.equal((await cancels(s)).length, 0);
  await assertPlaceFree(s);
});

// --- the places, and what is said about them -------------------------------------------------------------

test('Cloudflare has places of its own: GitHub\'s are not used, and each is held until given back', async () => {
  const s = await setup();
  await mkdir(s.deps.tmpRoot, { recursive: true, mode: 0o700 });
  const cloudflare = { ...CLOUDFLARE, maxRunning: 2 };
  const lines = [];
  const d = { ...s.deps, out: (l) => lines.push(l) };
  const gates = [1, 2, 3].map((pr) => cloudflareGate({ d, owner: { repo: 't/r', pr, sha: 'abc1234' }, cloudflare }));
  const won = [];
  for (const g of gates) won.push(await g.claim());
  assert.deepEqual(won, [true, true, false]);
  assert.deepEqual(gates.map((g) => g.place?.dir.split('/').at(-1) ?? null), ['cloudflare-0', 'cloudflare-1', null]);
  assert.ok(lines.some((l) => /^· Cloudflare: 2 run\(s\) going already$/.test(l)));
  const free = await tryLock(join(s.deps.tmpRoot, 'lanes', 'github-0'), await ownerInfo());
  assert.ok(free, 'GitHub\'s place was not touched');
  await free();
  await gates[0].release();
  await gates[1].release();
  assert.equal(await gates[2].claim(), true, 'a place that was given back is taken');
  await gates[2].release();
  assert.equal(await ledgerExists(s), false);
});

test('cloudflareGate.ask: only a line of minAhead or more, and only once in a while', async () => {
  const s = await setup();
  await mkdir(s.deps.tmpRoot, { recursive: true, mode: 0o700 });
  const gate = cloudflareGate({ d: { ...s.deps, overflowAskMs: 60_000, out: () => {} }, owner: { repo: 't/r', pr: 1, sha: 'abc1234' }, cloudflare: { ...CLOUDFLARE, minAhead: 2 } });
  assert.equal(await gate.ask(undefined), false, 'no line');
  assert.equal(await gate.ask({ ahead: [{}] }), false, 'one ahead is not two');
  assert.equal(await gate.ask({ ahead: [{}, {}] }), true);
  await gate.release();
  assert.equal(await gate.ask({ ahead: [{}, {}] }), false, 'just asked');
});

test('firstGate: the first remote that takes the check is the one, a named claim asks only that one', async () => {
  const gate = (name, takes, log) => ({ name, gate: { claim: async () => { log.push(`claim ${name}`); return takes; }, ask: async () => { log.push(`ask ${name}`); return takes; }, release: async () => { log.push(`release ${name}`); } } });
  const log = [];
  const both = firstGate([gate('Cloudflare', false, log), gate('GitHub', true, log)]);
  assert.equal(both.chosen, null);
  assert.equal(await both.ask({ ahead: [] }), true);
  assert.equal(both.chosen.name, 'GitHub');
  assert.deepEqual(log, ['ask Cloudflare', 'ask GitHub']);
  log.length = 0;
  assert.equal(await both.claim('Cloudflare'), false);
  assert.equal(await both.claim('Nowhere'), false);
  assert.deepEqual(log, ['claim Cloudflare'], 'only the named one is asked');
  assert.equal(await both.claim(), true);
  await both.release();
  assert.deepEqual(log.slice(-2), ['release Cloudflare', 'release GitHub']);
  const first = firstGate([gate('Cloudflare', true, []), gate('GitHub', true, [])]);
  assert.equal(await first.ask({ ahead: [] }), true);
  assert.equal(first.chosen.name, 'Cloudflare', 'in the order given');
});

test('checkRuns lists the check runs of a commit and refuses an answer that is not a list', async () => {
  const sha = 'a'.repeat(40);
  const dir = await tempDir();
  const ok = await fakeGh(dir, { pr: {}, cloudflare: { runs: [[{ conclusion: 'neutral' }, {}]] } });
  const runs = await checkRuns({ repo: 'acme/app-runner', sha, gh: ok.gh });
  assert.deepEqual(runs.map((r) => [r.conclusion, r.head_sha, r.app.slug]), [['neutral', sha, BUILD_APP], ['success', sha, BUILD_APP]]);
  assert.equal((await ok.calls())[0][1], `repos/acme/app-runner/commits/${sha}/check-runs?per_page=100`);
  const bad = await fakeGh(await tempDir(), { pr: {} });
  await assert.rejects(checkRuns({ repo: 'acme/app-runner', sha, gh: bad.gh }));
});

test('the build script is the constant ship hands over: strict, from the checkout root, with the pieces the design lists', async () => {
  const text = await readFile(new URL('../lib/cloudflare-run.sh', import.meta.url), 'utf8');
  assert.match(text, /^set -euo pipefail$/m);
  assert.match(text, /^cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\."$/m);
  for (const piece of ['locale -a', 'LC_ALL=C.UTF-8', '.ship-run/setup.sh', 'SHIP_GROUPS', 'codeload.github.com/runnel/ship/tar.gz/$sha', 'run-groups', '--config .ship-run/config.mjs', '--files .ship-run/changed-files', '--env .ship-run/env.json', 'tail -n 300']) {
    assert.ok(text.includes(piece), piece);
  }
});

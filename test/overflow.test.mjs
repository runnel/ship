import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCheck } from '../lib/check.mjs';
import { acquire, ownerInfo, tryLock } from '../lib/lock.mjs';
import { minutesUsed, daysLeftInMonth, reserveVerdict, recentRuns, PENDING_WINDOW_MS } from '../lib/overflow.mjs';
import { runGroupsHere } from '../lib/run-groups.mjs';
import { validateConfig, ConfigError } from '../lib/config.mjs';
import { commitFiles, git, killQuietly, makeOrigin, setupCheck, spawnCheckLeader, tempDir, waitUntil } from './helpers.mjs';

const actionsRow = (quantity, sku = 'Actions Linux') => ({ product: 'actions', unitType: 'Minutes', sku, quantity, repositoryName: 'r' });
const USAGE = (quantity) => ({ usageItems: [actionsRow(quantity)] });
const LOTS_LEFT = USAGE(100); // whatever the date, far above the reserve of the config below
const AT_THE_RESERVE = USAGE(2900);

const OVERFLOW = { workflow: 'ship-check.yml', includedMinutes: 3000, reservePerDay: 60, reserveFloor: 300, minAhead: 1, maxRunning: 1 };
const configText = (steps, overflow = OVERFLOW, check = {}) => `export default { repo: 't/r', docsOnly: ['*.md'], checks: [${JSON.stringify({ name: 'unit', lane: 'heavy', paths: ['src/**'], steps, ...check })}]${overflow ? `, overflow: ${JSON.stringify(overflow)}` : ''} };\n`;

const setup = ({ steps = ['true'], overflow = OVERFLOW, check = {}, github = { usage: LOTS_LEFT }, ...rest } = {}) =>
  setupCheck({ configText: configText(steps, overflow, check), ghOptions: { github }, ...rest });

// The lane is held and one waiter stands in line, so a check that arrives is second in line. `free()`
// lets both go (the waiter gives the lane back at once).
async function longLine(s) {
  await mkdir(s.deps.tmpRoot, { recursive: true, mode: 0o700 });
  const lane = join(s.deps.tmpRoot, 'lanes', 'heavy');
  const holder = await acquire(lane, await ownerInfo({ repo: 'o/x', pr: 1 }));
  const waiter = acquire(lane, await ownerInfo({ repo: 'o/x', pr: 2 }), { priority: 1, pollMs: 5 }).then((release) => release());
  await waitUntil(async () => (await readdir(join(s.deps.tmpRoot, 'lanes'))).some((n) => n.startsWith('heavy.q-') && n.endsWith('.json')), 'the waiter is in line');
  return { free: async () => { await holder(); await waiter; } };
}

const dispatches = async (s) => (await s.calls()).filter((c) => c[0] === 'api' && c[3]?.endsWith('/dispatches'));
const billingReads = async (s) => (await s.calls()).filter((c) => c[0] === 'api' && c[1]?.includes('/billing/'));
const cancels = async (s) => (await s.calls()).filter((c) => c[0] === 'api' && c[3]?.endsWith('/cancel'));
const says = (s, re) => s.lines.some((l) => re.test(l));

// --- the arithmetic that keeps the minutes from running out -------------------------------------

test('minutesUsed adds up Actions minutes, weighs dearer runners, and counts an unknown kind high', () => {
  assert.equal(minutesUsed({ usageItems: [actionsRow(10), actionsRow(5), { product: 'actions', unitType: 'GigabyteHours', sku: 'Actions storage', quantity: 99 }, { product: 'copilot', unitType: 'Minutes', quantity: 99 }] }), 15);
  assert.equal(minutesUsed({ usageItems: [actionsRow(1, 'Actions Windows'), actionsRow(1, 'Actions macOS')] }), 12);
  assert.equal(minutesUsed({ usageItems: [actionsRow(1, 'Actions Linux 4-core')] }), 10);
});

test('minutesUsed refuses a report that does not say, rather than reading it as nothing used', () => {
  for (const report of [null, {}, { usageItems: 'x' }, { usageItems: [] }, { usageItems: [{ product: 'actions', unitType: 'GigabyteHours', quantity: 1 }] }, { usageItems: [{ product: 'actions', unitType: 'Minutes', sku: 'Actions Linux' }] }, { usageItems: [actionsRow(-1)] }]) {
    assert.throws(() => minutesUsed(report), undefined, JSON.stringify(report));
  }
});

test('daysLeftInMonth counts today, by the UTC month', () => {
  assert.equal(daysLeftInMonth(new Date('2026-11-01T16:00:00Z')), 30);
  assert.equal(daysLeftInMonth(new Date('2026-11-30T23:59:00Z')), 1);
  assert.equal(daysLeftInMonth(new Date('2026-12-01T00:00:00Z')), 31);
  assert.equal(daysLeftInMonth(new Date('2026-10-31T22:30:00Z')), 1, 'already November in Tallinn, still October for GitHub');
});

test('reserveVerdict: one run may bring the minutes down to the reserve, and not one minute below', () => {
  const overflow = { includedMinutes: 3000, reservePerDay: 60, reserveFloor: 300, runMinutes: 20 };
  const now = new Date('2026-11-21T12:00:00Z'); // 10 days left: 900 kept
  assert.deepEqual(reserveVerdict({ used: 2080, pendingRuns: 0, overflow, now }), { ok: true, left: 900, reserve: 900 });
  assert.equal(reserveVerdict({ used: 2081, pendingRuns: 0, overflow, now }).ok, false);
  assert.equal(reserveVerdict({ used: 2060, pendingRuns: 1, overflow, now }).ok, true, 'a run the report does not show yet counts');
  assert.equal(reserveVerdict({ used: 2061, pendingRuns: 1, overflow, now }).ok, false);
});

test('recentRuns counts the runs inside the window; no file is none; a broken line refuses', async () => {
  const dir = await tempDir();
  const file = join(dir, 'runs.jsonl');
  const now = Date.parse('2026-11-21T12:00:00Z');
  assert.equal(await recentRuns(file, now, PENDING_WINDOW_MS), 0);
  await writeFile(file, `${JSON.stringify({ at: now - PENDING_WINDOW_MS - 1 })}\n${JSON.stringify({ at: now - PENDING_WINDOW_MS })}\n${JSON.stringify({ at: now })}\n`);
  assert.equal(await recentRuns(file, now, PENDING_WINDOW_MS), 2);
  await writeFile(file, '{"at":');
  await assert.rejects(recentRuns(file, now, PENDING_WINDOW_MS));
  await writeFile(file, '{"pr":1}\n');
  await assert.rejects(recentRuns(file, now, PENDING_WINDOW_MS));
});

// --- when a check goes ---------------------------------------------------------------------------

test('a long line: the check runs on GitHub, ship posts the green, nothing runs here', { timeout: 60_000 }, async () => {
  const s = await setup({ steps: ['exit 9'] }); // would be red here
  const line = await longLine(s);
  try {
    assert.equal(await runCheck({ cwd: s.work, deps: s.deps }), 0);
  } finally {
    await line.free();
  }
  const [call] = await dispatches(s);
  const field = (name) => call.find((x) => x.startsWith(`${name}=`))?.split('=')[1];
  assert.equal(field('ref'), 'main', 'always the workflow on main, never the copy on the pull request\'s branch');
  assert.equal(field('inputs[head_sha]').length, 40);
  assert.equal(field('inputs[main_sha]').length, 40);
  assert.match(field('inputs[tree_sha]'), /^[0-9a-f]{40}$/);
  assert.equal(field('inputs[groups]'), 'unit');
  assert.equal(field('inputs[ship_sha]'), 'c'.repeat(40));
  const st = await s.statuses();
  assert.ok(st.some((x) => x.state === 'pending' && /on GitHub/.test(x.description)));
  const last = st.at(-1);
  assert.equal(last.state, 'success');
  assert.match(last.description, /^unit · vs main@[0-9a-f]{7} · \d+\S* · on GitHub$/, 'ship merge reads the main out of it');
  assert.equal(last.target_url, 'https://example.com/runs/555');
  const ledger = (await readFile(join(s.deps.overflowRoot, 'runs.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].pr, 7);
  assert.equal(await tryLock(join(s.deps.tmpRoot, 'lanes', 'github-0'), await ownerInfo()).then((r) => r?.()), undefined, 'the place is free again');
});

test('a short line: the check waits here, and the minutes are not even looked at', { timeout: 60_000 }, async () => {
  const s = await setup({ overflow: { ...OVERFLOW, minAhead: 2 } }); // one ahead is not two
  const line = await longLine(s);
  const check = runCheck({ cwd: s.work, deps: s.deps });
  await waitUntil(() => says(s, /2nd in line/), 'the check is in line');
  await line.free();
  assert.equal(await check, 0);
  assert.equal((await dispatches(s)).length, 0);
  assert.equal((await billingReads(s)).length, 0);
  assert.doesNotMatch((await s.statuses()).at(-1).description, /on GitHub/);
});

test('without overflow in the config nothing changes', { timeout: 60_000 }, async () => {
  const s = await setup({ overflow: null });
  const line = await longLine(s);
  const check = runCheck({ cwd: s.work, deps: s.deps });
  await waitUntil(() => says(s, /2nd in line/), 'the check is in line');
  await line.free();
  assert.equal(await check, 0);
  assert.equal((await dispatches(s)).length, 0);
  assert.equal((await billingReads(s)).length, 0);
});

test('a light check never goes, not even when asked', { timeout: 60_000 }, async () => {
  const s = await setup({ check: { lane: 'light' } });
  assert.equal(await runCheck({ cwd: s.work, github: true, deps: s.deps }), 0);
  assert.equal((await dispatches(s)).length, 0);
  assert.ok(says(s, /--github: this check cannot run on GitHub/));
});

test('a check with a group the config does not send stays here', { timeout: 60_000 }, async () => {
  const s = await setup({ overflow: { ...OVERFLOW, groups: [] } });
  assert.equal(await runCheck({ cwd: s.work, github: true, deps: s.deps }), 0);
  assert.equal((await dispatches(s)).length, 0);
});

test('a pull request cannot turn overflow on for itself: only main\'s config counts', { timeout: 60_000 }, async () => {
  const s = await setupCheck({
    mainConfig: false, // main has no config yet: the check uses the pull request's
    featFiles: { 'src/x.ts': 'x\n', 'ship.config.mjs': configText(['true']) },
    ghOptions: { github: { usage: LOTS_LEFT } },
  });
  assert.equal(await runCheck({ cwd: s.work, github: true, deps: s.deps }), 0);
  assert.equal((await dispatches(s)).length, 0);
});

test('--github goes without a line, and the reserve still holds it back', { timeout: 60_000 }, async () => {
  const go = await setup({ steps: ['exit 9'] });
  assert.equal(await runCheck({ cwd: go.work, github: true, deps: go.deps }), 0);
  assert.equal((await dispatches(go)).length, 1);
  const held = await setup({ github: { usage: AT_THE_RESERVE } });
  assert.equal(await runCheck({ cwd: held.work, github: true, deps: held.deps }), 0);
  assert.equal((await dispatches(held)).length, 0);
  assert.ok(says(held, /at the reserve/));
});

// --- when it must not go ---------------------------------------------------------------------------

for (const [name, github, line] of [
  ['the reserve is reached', { usage: AT_THE_RESERVE }, /at the reserve/],
  ['the usage cannot be read', {}, /could not be read/],
  ['the usage report says nothing', { usage: { usageItems: [] } }, /could not be read/],
]) {
  test(`${name}: nothing is started and the check waits its turn here`, { timeout: 60_000 }, async () => {
    const s = await setup({ github });
    const queue = await longLine(s);
    const check = runCheck({ cwd: s.work, deps: s.deps });
    await waitUntil(() => says(s, line), 'the reason is said');
    await queue.free();
    assert.equal(await check, 0);
    assert.equal((await dispatches(s)).length, 0);
    assert.equal(s.lines.filter((l) => line.test(l)).length, 1, 'said once, however often it is asked');
    assert.equal((await s.statuses()).at(-1).state, 'success');
  });
}

test('a ledger that cannot be read: nothing is started', { timeout: 60_000 }, async () => {
  const s = await setup();
  await mkdir(s.deps.overflowRoot, { recursive: true });
  await writeFile(join(s.deps.overflowRoot, 'runs.jsonl'), 'not json\n');
  assert.equal(await runCheck({ cwd: s.work, github: true, deps: s.deps }), 0);
  assert.equal((await dispatches(s)).length, 0);
  assert.ok(says(s, /could not be read/));
});

test('runs started in the last day count: the report may not show them yet', { timeout: 60_000 }, async () => {
  const now = Date.parse('2026-11-01T12:00:00Z'); // 30 days left: 2100 kept
  const started = async (s, at) => {
    await mkdir(s.deps.overflowRoot, { recursive: true });
    await writeFile(join(s.deps.overflowRoot, 'runs.jsonl'), `${JSON.stringify({ at })}\n`.repeat(5));
  };
  const recent = await setup({ github: { usage: USAGE(800) } });
  await started(recent, now);
  assert.equal(await runCheck({ cwd: recent.work, github: true, deps: { ...recent.deps, now: () => now } }), 0);
  assert.equal((await dispatches(recent)).length, 0, '3000 - 800 - 6 x 20 = 2080, 2100 are kept');
  const older = await setup({ github: { usage: USAGE(800) } });
  await started(older, now - PENDING_WINDOW_MS - 1);
  assert.equal(await runCheck({ cwd: older.work, github: true, deps: { ...older.deps, now: () => now } }), 0);
  assert.equal((await dispatches(older)).length, 1, 'older ones are in the report by now: 3000 - 800 - 20 = 2180');
});

test('no free place: the check stays in line and takes one when it comes free', { timeout: 60_000 }, async () => {
  const s = await setup({ steps: ['exit 9'] });
  const line = await longLine(s);
  const place = join(s.deps.tmpRoot, 'lanes', 'github-0');
  const taken = await tryLock(place, await ownerInfo({ repo: 'o/x', pr: 3 }));
  const check = runCheck({ cwd: s.work, deps: s.deps });
  try {
    await waitUntil(() => says(s, /GitHub run\(s\) going already/), 'the check says why it stays');
    assert.equal((await dispatches(s)).length, 0);
    await taken();
    assert.equal(await check, 0, 'it left the line for the place, so the red step never ran here');
    assert.equal((await dispatches(s)).length, 1);
  } finally {
    await line.free();
  }
});

// --- when GitHub does not say green ----------------------------------------------------------------

const backHere = (name, github, { why, cancelled = false } = {}) =>
  test(`${name}: the check goes back in line and this machine gives the verdict`, { timeout: 60_000 }, async () => {
    const s = await setup({ github: { usage: LOTS_LEFT, ...github } });
    const line = await longLine(s);
    const deps = { ...s.deps, githubQueueMs: 30, githubBlindMs: 30 };
    const check = runCheck({ cwd: s.work, deps });
    await waitUntil(() => says(s, /back in line on this machine/), 'it comes back');
    await line.free();
    assert.equal(await check, 0);
    const st = await s.statuses();
    assert.equal(st.filter((x) => x.state === 'failure' || x.state === 'error').length, 0, 'an infrastructure failure must not read as red');
    assert.equal(st.at(-1).state, 'success');
    assert.doesNotMatch(st.at(-1).description, /on GitHub/);
    assert.equal(st.at(-1).target_url, undefined);
    assert.ok(says(s, why), s.lines.join('\n'));
    assert.equal((await dispatches(s)).length, 1, 'one try per check');
    assert.equal((await cancels(s)).length, cancelled ? 1 : 0);
  });

backHere('the dispatch fails', { dispatchFail: 'HTTP 404: workflow not found' }, { why: /could not be started \(HTTP 404/ });
backHere('the run is cancelled', { runs: [{ conclusion: 'cancelled' }] }, { why: /ended as cancelled/ });
backHere('the run times out on GitHub', { runs: [{ conclusion: 'timed_out' }] }, { why: /ended as timed_out/ });
backHere('the run never starts', { runs: [{ status: 'queued', conclusion: null }] }, { why: /had not started/, cancelled: true });
backHere('GitHub stops answering', { runReadFails: 1e6 }, { why: /has not answered/, cancelled: true });
backHere('the run is red', {
  runs: [{ conclusion: 'failure' }], jobs: [{ id: 9, conclusion: 'failure', steps: [{ name: 'Run the check groups', conclusion: 'failure' }] }],
  jobLog: '2026-11-01T01:00:00Z ok\n2026-11-01T01:00:01Z ✗ unit: npm test (3s)\n',
}, { why: /GitHub run was red \(unit: npm test \(3s\)\)/ });
for (const [name, run] of [
  ['another workflow', { path: '.github/workflows/other.yml' }],
  ['a run from another branch', { head_branch: 'feat' }],
  ['a run of another name', { display_title: 'ship check other' }],
  ['a run started another way', { event: 'push' }],
]) backHere(`GitHub answers about ${name}`, { runs: [run] }, { why: /is not the run ship started/, cancelled: true });

test('a red run here is still a red check: the verdict is this machine\'s', { timeout: 60_000 }, async () => {
  const s = await setup({ steps: ['exit 3'], github: { usage: LOTS_LEFT, runs: [{ conclusion: 'failure' }] } });
  const line = await longLine(s);
  const check = runCheck({ cwd: s.work, deps: s.deps });
  await waitUntil(() => says(s, /back in line/), 'it comes back');
  await line.free();
  assert.equal(await check, 1);
  assert.match((await s.statuses()).at(-1).description, /^unit: exit 3 failed/);
  assert.equal((await dispatches(s)).length, 1, 'no second try');
});

test('a short wobble in GitHub\'s answers does not end the wait', { timeout: 60_000 }, async () => {
  const s = await setup({ github: { usage: LOTS_LEFT, runReadFails: 2 } });
  assert.equal(await runCheck({ cwd: s.work, github: true, deps: { ...s.deps, githubBlindMs: 60_000 } }), 0);
  assert.match((await s.statuses()).at(-1).description, /on GitHub/);
});

test('it comes back to the place it had, ahead of whoever arrived while it was away', { timeout: 60_000 }, async () => {
  const order = join(await tempDir(), 'order');
  const away = Array.from({ length: 40 }, () => ({ status: 'in_progress', conclusion: null }));
  const s = await setup({ steps: [`echo check >> ${order}`], github: { usage: LOTS_LEFT, runs: [...away, { conclusion: 'failure' }] } });
  const line = await longLine(s);
  const check = runCheck({ cwd: s.work, deps: s.deps });
  await waitUntil(async () => (await dispatches(s)).length === 1, 'it has gone');
  const latecomer = acquire(join(s.deps.tmpRoot, 'lanes', 'heavy'), await ownerInfo({ repo: 'o/x', pr: 4 }), { priority: 1, pollMs: 5 })
    .then(async (release) => { await appendFile(order, 'latecomer\n'); await release(); });
  await waitUntil(() => says(s, /back in line/), 'it comes back');
  const tickets = async () => (await readdir(join(s.deps.tmpRoot, 'lanes'))).filter((n) => n.startsWith('heavy.q-') && n.endsWith('.json'));
  await waitUntil(async () => (await tickets()).length === 3, 'three in line: the first waiter, the check, the latecomer');
  await line.free();
  assert.equal(await check, 0);
  await latecomer;
  assert.deepEqual((await readFile(order, 'utf8')).trim().split('\n'), ['check', 'latecomer']);
});

test('Ctrl-C while on GitHub cancels the run, says error, and frees the place', { timeout: 60_000 }, async () => {
  const dir = await tempDir('overflow-int-');
  const s = await setup({ github: { usage: LOTS_LEFT, runs: [{ status: 'in_progress', conclusion: null }] } });
  const run = await spawnCheckLeader(s, dir, { github: true });
  try {
    await waitUntil(() => run.out.text.includes('GitHub run:'), 'the run has started', 30_000);
    process.kill(-run.child.pid, 'SIGINT');
    await run.exited;
    assert.equal((await cancels(s)).length, 1);
    assert.equal((await s.statuses()).at(-1).state, 'error');
    const free = await tryLock(join(s.deps.tmpRoot, 'lanes', 'github-0'), await ownerInfo());
    assert.ok(free, 'the place is free again');
    await free();
  } finally {
    run.kill();
    killQuietly(run.child.pid);
  }
});

test('a pull request that moves on while its check is on GitHub: the run is cancelled, no verdict', { timeout: 60_000 }, async () => {
  const s = await setup({ github: { usage: LOTS_LEFT, runs: [{ status: 'in_progress', conclusion: null }] } });
  const check = runCheck({ cwd: s.work, github: true, deps: { ...s.deps, doomedPollMs: 20 } });
  await waitUntil(() => says(s, /GitHub run:/), 'the run has started');
  await s.setPr({ headRefOid: 'f'.repeat(40) });
  assert.equal(await check, 2);
  assert.equal((await cancels(s)).length, 1);
  assert.ok(says(s, /stopped checking PR #7/));
  assert.equal((await s.statuses()).filter((x) => x.state === 'success' || x.state === 'failure').length, 0);
  const free = await tryLock(join(s.deps.tmpRoot, 'lanes', 'github-0'), await ownerInfo());
  assert.ok(free, 'the place is free again');
  await free();
});

// --- what the run on GitHub executes ---------------------------------------------------------------

async function treeOnBranch(mainConfig, featConfig = null) {
  const { work } = await makeOrigin({ 'ship.config.mjs': mainConfig, 'a.txt': 'a\n' });
  const mainSha = (await git(['rev-parse', 'HEAD'], work)).trim();
  await git(['checkout', '--quiet', '-b', 'feat'], work);
  const headSha = await commitFiles(work, { 'src/x.ts': 'x\n', ...(featConfig ? { 'ship.config.mjs': featConfig } : {}) }, 'feat');
  return { work, mainSha, headSha };
}
const twoGroups = (first, second) => `export default { repo: 't/r', checks: [{ name: 'one', paths: ['src/**'], steps: [${JSON.stringify(first)}] }, { name: 'two', paths: ['src/**'], steps: [${JSON.stringify(second)}] }] };\n`;

test('run-groups runs the groups of main\'s config, in the order given, and tells them what changed', async () => {
  const dir = await tempDir();
  const seen = join(dir, 'seen');
  const { work, mainSha, headSha } = await treeOnBranch(twoGroups(`echo one >> ${seen}; echo "$SHIP_CHANGED_FILES" >> ${seen}`, `echo two >> ${seen}`));
  const lines = [];
  assert.equal(await runGroupsHere({ cwd: work, groups: ['one', 'two'], mainSha, headSha, logFile: join(dir, 'log'), out: (l) => lines.push(l) }), 0);
  assert.deepEqual((await readFile(seen, 'utf8')).trim().split('\n'), ['one', 'src/x.ts', 'two']);
});

test('run-groups: a pull request\'s own config changes nothing, a red step is exit 1', async () => {
  const dir = await tempDir();
  const { work, mainSha, headSha } = await treeOnBranch(twoGroups('exit 4', 'true'), twoGroups('true', 'true'));
  const lines = [];
  assert.equal(await runGroupsHere({ cwd: work, groups: ['one'], mainSha, headSha, logFile: join(dir, 'log'), out: (l) => lines.push(l) }), 1);
  assert.ok(lines.some((l) => l.startsWith('✗ one: exit 4')), 'the line a red run is summed up by');
});

test('run-groups refuses groups that main\'s config does not have', async () => {
  const dir = await tempDir();
  const { work, mainSha, headSha } = await treeOnBranch(twoGroups('true', 'true'));
  const lines = [];
  assert.equal(await runGroupsHere({ cwd: work, groups: ['nope'], mainSha, headSha, logFile: join(dir, 'log'), out: (l) => lines.push(l) }), 2);
  assert.equal(await runGroupsHere({ cwd: work, groups: [], mainSha, headSha, logFile: join(dir, 'log'), out: (l) => lines.push(l) }), 2);
});

test('the example workflow takes what ship sends, can only read, and starts nothing by itself', async () => {
  const text = await readFile(new URL('../examples/ship-check.yml', import.meta.url), 'utf8');
  for (const input of ['head_sha', 'main_sha', 'tree_sha', 'groups', 'ship_sha', 'nonce']) assert.match(text, new RegExp(`^ {6}${input}: `, 'm'), input);
  assert.match(text, /^run-name: ship check \$\{\{ inputs\.nonce \}\}$/m, 'how ship recognises its run');
  assert.match(text, /^permissions:\n {2}contents: read\n\n/m);
  assert.doesNotMatch(text, /statuses:|secrets\./);
  assert.match(text, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(text, /^ {2}(push|pull_request|schedule):/m);
  // Inputs reach a shell only through env: `${{ }}` inside a script would run what it contains.
  for (const script of text.matchAll(/run: \|?\n?((?:.*\n)*?)(?=^ {6}- |\Z)/gm)) assert.doesNotMatch(script[1], /\$\{\{/);
  assert.match(text, /timeout-minutes: \d+/);
  assert.doesNotMatch(text, /\bGROUPS:|\$GROUPS/, 'bash keeps its own GROUPS: the user\'s group ids, whatever the environment says');
});

// --- configuration ---------------------------------------------------------------------------------

const withOverflow = (overflow) => ({ repo: 't/r', checks: [{ name: 'unit', paths: ['**'], steps: ['true'] }], overflow });

test('overflow config: defaults, and no default for what must stay free', () => {
  assert.equal(validateConfig({ repo: 't/r', checks: [{ name: 'unit', paths: ['**'], steps: ['true'] }] }).overflow, null);
  assert.deepEqual(validateConfig(withOverflow({ workflow: 'c.yml', includedMinutes: 3000, reservePerDay: 60, reserveFloor: 300 })).overflow, {
    workflow: 'c.yml', includedMinutes: 3000, reservePerDay: 60, reserveFloor: 300, minAhead: 4, maxRunning: 2, runMinutes: 20, timeoutMin: 40, groups: null,
  });
  const good = { workflow: 'c.yml', includedMinutes: 3000, reservePerDay: 60, reserveFloor: 300 };
  for (const bad of [
    'x', { ...good, workflow: undefined }, { ...good, workflow: '../c.yml' }, { ...good, workflow: 'c.txt' },
    { ...good, includedMinutes: undefined }, { ...good, reservePerDay: undefined }, { ...good, reserveFloor: undefined },
    { ...good, reservePerDay: 0 }, { ...good, reserveFloor: 0 }, { ...good, minAhead: 0 }, { ...good, maxRunning: 0 }, { ...good, maxRunning: 1.5 },
    { ...good, runMinutes: 0 }, { ...good, timeoutMin: -1 }, { ...good, groups: 'unit' }, { ...good, groups: ['nope'] }, { ...good, nope: 1 },
  ]) assert.throws(() => validateConfig(withOverflow(bad)), ConfigError, JSON.stringify(bad));
});

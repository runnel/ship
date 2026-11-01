import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitFiles, git, tempDir, waitUntil } from './helpers.mjs';
import { acquire, ownerInfo } from '../lib/lock.mjs';
import { addAcks, writeHold } from '../lib/state.mjs';
import { runDeploy } from '../lib/deploy.mjs';
import { at, setupDeploy } from './deploy-fixture.mjs';

const seed = ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) });

// Takes a lane or the deploy lock, as another run would; the returned function gives it back.
async function hold(s, ...path) {
  return await acquire(join(s.deps.tmpRoot, ...path), await ownerInfo({ command: 'test holder' }), { pollMs: 10 });
}
const waitFor = (lines, text, what = text) => waitUntil(() => lines.some((l) => l.includes(text)), what, 30_000);
// main gains a commit on the origin the deploys fetch from.
async function mainMoves(s, files, message) {
  const sha = await commitFiles(s.work, files, message);
  await git(['push', '--quiet', s.deps.remoteUrl(), 'main'], s.work);
  return sha;
}
const deployMessage = async (s) => (await s.cloud.state('example-app')).deployments.at(-1).annotations['workers/message'];
const uploads = async (s) => (await s.cloud.wranglerCalls()).filter((c) => c.cmd === 'versions upload');
// A second `ship deploy` of the same repository, printing into its own list.
function second(s, lines, opts = {}) {
  return runDeploy({ cwd: s.work, names: [], dryRun: false, redeploy: false, ...opts, deps: { ...s.deps, out: (l) => lines.push(l) } });
}

test('main moves while the deploy waits for its slot: it ships the later main, and says which PRs', async () => {
  const builtSha = join(await tempDir('built-'), 'sha');
  const s = await setupDeploy({ options: { builtSha }, seed, change: { 'app/src/a.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  const releaseLane = await hold(s, 'lanes', 'heavy');
  const run = s.deploy();
  await waitFor(s.lines, 'waiting for the heavy lane');
  const later = await mainMoves(s, { 'app/src/b.ts': '3' }, 'later change (#10)');
  await releaseLane();
  assert.equal(await run, 0, s.lines.join('\n'));

  const text = s.lines.join('\n');
  assert.match(text, new RegExp(`· app: 1 changed file\\(s\\) since \\w+ · ships 1 commit\\(s\\): #9\\n`), 'the plan lines of the first head stay');
  assert.match(text, new RegExp(`↻ main moved while the deploy waited: ${s.head.slice(0, 7)} → ${later.slice(0, 7)} \\(1 new commit\\(s\\)\\)`));
  assert.match(text, new RegExp(`▸ t/r deploy main@${later.slice(0, 7)}\\n· app: 2 changed file\\(s\\) .* · ships 2 commit\\(s\\): #10 #9\\n`), 'the plan is made again for the later head');
  // The final PR list comes before the setup and the build, once.
  const building = s.lines.findIndex((l) => l === `▸ building main@${later.slice(0, 7)} · ships 2 commit(s): #10 #9`);
  assert.ok(building > 0, text);
  assert.ok(building < s.lines.findIndex((l) => /^✓ setup:/.test(l)) && building < s.lines.findIndex((l) => /^▸ app:/.test(l)), text);
  assert.equal(s.lines.filter((l) => l.startsWith('▸ building')).length, 1);
  // What was built, what the annotation says, and what the log line says are the same commit.
  assert.equal((await readFile(builtSha, 'utf8')).trim(), later);
  assert.match(await deployMessage(s), new RegExp(`^sha:${later} app run:[0-9a-f]{6} #10 #9$`));
  assert.match(text, new RegExp(`▸ app: versioned ${s.first.slice(0, 7)} → ${later.slice(0, 7)} \\(#10 #9\\)`));
  assert.equal((await uploads(s)).length, 1);
});

test('the commits that arrive bring an uncleared migration: the deploy keeps its head and says so', async () => {
  const builtSha = join(await tempDir('built-'), 'sha');
  const s = await setupDeploy({ options: { builtSha }, seed, change: { 'app/src/a.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  const releaseLane = await hold(s, 'lanes', 'heavy');
  const run = s.deploy();
  await waitFor(s.lines, 'waiting for the heavy lane');
  const later = await mainMoves(s, { 'app/src/b.ts': '3', 'db/002.sql': '' }, 'later change with a migration (#10)');
  await releaseLane();
  assert.equal(await run, 0, s.lines.join('\n'));

  const text = s.lines.join('\n');
  assert.match(text, new RegExp(`! main moved to ${later.slice(0, 7)} while the deploy waited, but it brings migrations that are not cleared for deploy \\(db/002.sql\\)`));
  assert.match(text, new RegExp(`deploying main@${s.head.slice(0, 7)} as planned`));
  assert.doesNotMatch(text, /↻/);
  assert.match(text, new RegExp(`▸ building main@${s.head.slice(0, 7)} · ships 1 commit\\(s\\): #9\\n`));
  assert.equal((await readFile(builtSha, 'utf8')).trim(), s.head, 'the build is of the older head');
  assert.match(await deployMessage(s), new RegExp(`^sha:${s.head} app run:[0-9a-f]{6} #9$`), 'and so is the annotation');
});

test('a migration the owner cleared meanwhile does not stop the move', async () => {
  const s = await setupDeploy({ seed, change: { 'app/src/a.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  const releaseLane = await hold(s, 'lanes', 'heavy');
  const run = s.deploy();
  await waitFor(s.lines, 'waiting for the heavy lane');
  const later = await mainMoves(s, { 'db/002.sql': '', 'app/src/b.ts': '3' }, 'later change with a migration (#10)');
  await addAcks(s.deps.stateRoot, 't/r', ['db/002.sql']);
  await releaseLane();
  assert.equal(await run, 0, s.lines.join('\n'));
  assert.match(await deployMessage(s), new RegExp(`^sha:${later} `));
});

test('main does not move: nothing is said about it, and the final line still comes before the build', async () => {
  const s = await setupDeploy({ seed, change: { 'app/src/a.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  assert.equal(await s.deploy(), 0, s.lines.join('\n'));
  assert.doesNotMatch(s.lines.join('\n'), /moved/);
  const at7 = s.head.slice(0, 7);
  assert.ok(s.lines.indexOf(`▸ building main@${at7} · ships 1 commit(s): #9`) > 0, s.lines.join('\n'));
  assert.match(await deployMessage(s), new RegExp(`^sha:${s.head} `));
});

test('a hold written while the deploy waited stops that deployable', async () => {
  const s = await setupDeploy({ seed, change: { 'app/src/a.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  const releaseLane = await hold(s, 'lanes', 'heavy');
  const run = s.deploy();
  await waitFor(s.lines, 'waiting for the heavy lane');
  await writeHold(s.deps.stateRoot, 't/r', 'app', { reason: 'rolled back by the owner' });
  await releaseLane();
  assert.equal(await run, 1, s.lines.join('\n'));
  assert.match(s.lines.join('\n'), /! app: held since .*rolled back by the owner/);
  assert.match(s.lines.join('\n'), /✗ ship deploy: app held/);
  assert.deepEqual(await s.cloud.wranglerCalls(), []);
});

test('a later main that would block a deployable is not moved to', async () => {
  const s = await setupDeploy({ seed, change: { 'app/src/a.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  const releaseLane = await hold(s, 'lanes', 'heavy');
  const run = s.deploy();
  await waitFor(s.lines, 'waiting for the heavy lane');
  const later = await mainMoves(s, { 'workers/tick/src/index.ts': "import '../../../app/src/a';\n" }, 'tick reaches into app (#10)');
  await releaseLane();
  assert.equal(await run, 0, s.lines.join('\n'));
  assert.match(s.lines.join('\n'), new RegExp(`! main moved to ${later.slice(0, 7)} while the deploy waited, but tick would be blocked there \\(imports files outside its paths`));
  assert.match(await deployMessage(s), new RegExp(`^sha:${s.head} `));
});

test('a second ship deploy joins the one that has not begun building: one deploy, the same result', async () => {
  const s = await setupDeploy({ seed, change: { 'app/src/a.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  const releaseLane = await hold(s, 'lanes', 'heavy');
  const a = s.deploy();
  await waitFor(s.lines, 'waiting for the heavy lane');
  const linesB = [];
  const b = second(s, linesB);
  await waitFor(linesB, '↪ t/r: a deploy started at');
  const later = await mainMoves(s, { 'app/src/b.ts': '3' }, 'merged after the first deploy began (#10)');
  await releaseLane();
  assert.equal(await a, 0, s.lines.join('\n'));
  assert.equal(await b, 0, linesB.join('\n'));

  assert.equal((await uploads(s)).length, 1, 'only one deploy ran');
  assert.match(linesB.join('\n'), /✓ ship deploy: everything selected is live/);
  assert.match(linesB.join('\n'), /✓ app: [0-9a-f]{8} live at /);
  assert.match(await deployMessage(s), new RegExp(`^sha:${later} app run:[0-9a-f]{6} #10 #9$`), 'what the second caller merged is in it');
  // It is the leader's output, line for line, after the line that says it joined.
  assert.deepEqual(linesB.slice(1), s.lines.slice(s.lines.indexOf(linesB[1])));
});

test('a caller that finds the deploy building does not join it: it waits, then deploys what is left', async () => {
  const s = await setupDeploy({ seed, change: { 'app/src/a.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  const releaseCheckLane = await hold(s, 'lanes', 'light'); // the deploy-time check holds the deploy here, after it froze
  const a = s.deploy();
  await waitFor(s.lines, 'waiting for the light lane');
  const linesB = [];
  const b = second(s, linesB);
  await waitFor(linesB, 'waiting for the deploy lock');
  const later = await mainMoves(s, { 'app/src/b.ts': '3' }, 'merged while the first deploy built (#10)');
  await releaseCheckLane();
  assert.equal(await a, 0, s.lines.join('\n'));
  assert.equal(await b, 0, linesB.join('\n'));

  assert.doesNotMatch(linesB.join('\n'), /↪/);
  const calls = await uploads(s);
  assert.equal(calls.length, 2, 'two deploys ran, one after the other');
  assert.match(await deployMessage(s), new RegExp(`^sha:${later} app run:[0-9a-f]{6} #10$`));
  assert.match(s.lines.join('\n'), new RegExp(`▸ building main@${s.head.slice(0, 7)} `), 'the first one shipped what it had frozen');
});

test('a caller joins one that is still waiting for the deploy lock, and deploys for itself if that one ends before building', async () => {
  const s = await setupDeploy({ seed, change: { 'app/src/a.ts': '2', 'db/002.sql': '' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  const releaseDeployLock = await hold(s, 'locks', 'deploy-t__r');
  const linesA = [];
  const clear = () => {
    mkdirSync(join(s.deps.stateRoot, 'acks'), { recursive: true });
    appendFileSync(join(s.deps.stateRoot, 'acks', 't__r'), `db/002.sql\t${new Date().toISOString()}\n`);
  };
  // The first deploy stops at the migration; by the time it says so, the owner has cleared it.
  const a = runDeploy({ cwd: s.work, names: [], dryRun: false, redeploy: false, deps: { ...s.deps, out: (l) => { linesA.push(l); if (/migrations not cleared/.test(l)) clear(); } } });
  await waitFor(linesA, 'waiting for the deploy lock');
  const linesB = [];
  const b = second(s, linesB);
  await waitFor(linesB, '↪ t/r: a deploy started at');
  await releaseDeployLock();
  assert.equal(await a, 1, linesA.join('\n'));
  assert.equal(await b, 0, linesB.join('\n'));

  const text = linesB.join('\n');
  assert.match(text, /✗ migrations not cleared for deploy: db\/002.sql/, 'it saw the first deploy stop');
  assert.match(text, /! the deploy this one joined ended before it began building; deploying now/);
  assert.match(text, /✓ ship deploy: everything selected is live/);
  assert.equal((await uploads(s)).length, 1);
});

test('a dry run neither joins nor is joined', async () => {
  const s = await setupDeploy({ seed, change: { 'app/src/a.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  const releaseLane = await hold(s, 'lanes', 'heavy');
  const a = s.deploy();
  await waitFor(s.lines, 'waiting for the heavy lane');
  const linesB = [];
  const b = second(s, linesB, { dryRun: true });
  await waitFor(linesB, 'waiting for the deploy lock');
  await releaseLane();
  assert.equal(await a, 0, s.lines.join('\n'));
  assert.equal(await b, 0, linesB.join('\n'));
  assert.doesNotMatch(linesB.join('\n'), /↪/);
  assert.match(linesB.join('\n'), /\(dry run\)\n✓ app: already live/, 'it planned for itself, after the other deploy was over');
  assert.equal((await uploads(s)).length, 1, 'and uploaded nothing');
});

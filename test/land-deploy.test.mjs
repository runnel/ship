import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquire, ownerInfo } from '../lib/lock.mjs';
import { addAcks } from '../lib/state.mjs';
import { landDir } from '../lib/land-line.mjs';
import { deployRunning, migrationRefusal, readDeploys, recordDeployEnd, recordDeployStart, runDetachedDeploy, startDetachedDeploy } from '../lib/land-deploy.mjs';
import { at, requiresSetup, setupDeploy } from './deploy-fixture.mjs';
import { atTestEnd, isAlive, isGone, killQuietly, stopBackground, tempDir, waitUntil } from './helpers.mjs';

afterEach(stopBackground, { timeout: 30_000 });
const TIP = 'a'.repeat(40);
const records = async (d) => (await readdir(join(landDir(d, 't/r'), 'deploys')).catch(() => [])).sort();

test('deploy records: a start whose runner lives and has not ended is running; an end says how it ended', async () => {
  const d = { tmpRoot: await tempDir('land-') };
  assert.deepEqual(await readDeploys({ d, repo: 't/r' }), { running: [], ended: [] });
  await recordDeployStart({ d, repo: 't/r', id: 'a1', tip: TIP, log: '/x.out', owner: await ownerInfo() });
  assert.deepEqual((await readDeploys({ d, repo: 't/r' })).running.map((x) => x.id), ['a1']);
  assert.equal(await deployRunning({ d, repo: 't/r' }), true);
  const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await once(dead, 'close');
  await recordDeployStart({ d, repo: 't/r', id: 'b2', tip: TIP, log: '/y.out', owner: { pid: dead.pid, pgid: dead.pid, startTime: null } });
  await recordDeployEnd({ d, repo: 't/r', id: 'a1', tip: TIP, code: 1, log: '/x.out' });
  const after = await readDeploys({ d, repo: 't/r' });
  assert.deepEqual(after.running, [], 'one has ended, the other runner is gone without a word');
  assert.deepEqual(after.ended.map((x) => [x.id, x.tip, x.code, x.migrationsWaiting]), [['a1', TIP, 1, false]]);
  assert.deepEqual(await records(d), [`${TIP}-a1.end.json`, `${TIP}-a1.start.json`], 'the gone runner\'s start record is removed');
  assert.equal(await deployRunning({ d, repo: 't/r' }), false);
  const lock = atTestEnd(await acquire(join(d.tmpRoot, 'locks', 'deploy-t__r'), await ownerInfo({ repo: 't/r', command: 'deploy' })));
  assert.equal(await deployRunning({ d, repo: 't/r' }), true, 'a ship deploy started by hand counts');
  await lock();
});

test('deploy records older than a day are removed, so a tick does not read the whole history', async () => {
  const then = Date.parse('2026-11-10T08:00:00Z');
  const root = await tempDir('land-');
  const old = { tmpRoot: root, now: () => then };
  await recordDeployStart({ d: old, repo: 't/r', id: 'o1', tip: TIP, log: '/o.out', owner: await ownerInfo() });
  await recordDeployEnd({ d: old, repo: 't/r', id: 'o1', tip: TIP, code: 1, log: '/o.out' });
  const dayLater = { tmpRoot: root, now: () => then + 25 * 60 * 60_000 };
  assert.deepEqual((await readDeploys({ d: dayLater, repo: 't/r' })).ended, []);
  assert.deepEqual(await records(dayLater), []);
});

test('a deploy that stopped at an uncleared migration on main is recorded as waiting for it, not as a failure', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: { 'app/src/a.ts': '2' } });
  const code = await runDetachedDeploy({ cwd: s.work, repo: 't/r', tip: s.head, floors: {}, id: 'm1', log: '/m1.out' }, s.deps);
  assert.equal(code, 1);
  assert.ok(s.lines.some((l) => l.startsWith('✗ migrations not cleared for deploy:')), s.lines.join('\n'));
  assert.deepEqual((await readDeploys({ d: s.deps, repo: 't/r' })).ended.map((x) => [x.code, x.migrationsWaiting]), [[1, true]]);
});

test('only the last refusal counts: a migration refusal replayed from a joined deploy, then a failure of its own, is a failure', () => {
  const replayedThenFailed = migrationRefusal();
  for (const line of [
    '↪ t/r: a deploy started at 10/11, 16:20 (pid 4242) has not begun building; this one joins it, with the same result',
    '✗ migrations not cleared for deploy: db/002_x.sql',
    '  the owner applies them (or decides they go after the deploy) and runs: ship migrations ack 002_x.sql',
    '! the deploy this one joined ended before it began building; deploying now',
    '✗ app: wrangler versions upload failed',
    '✗ ship deploy: app failed',
  ]) replayedThenFailed.see(line);
  assert.equal(replayedThenFailed.refused(), false);
  const refusedLast = migrationRefusal();
  for (const line of ['✗ app: wrangler versions upload failed', '✗ migrations not cleared for deploy: db/002_x.sql', '  the owner applies them …']) refusedLast.see(line);
  assert.equal(refusedLast.refused(), true);
  assert.equal(migrationRefusal().refused(), false);
});

test('the real runner module: started detached, it runs the deploy path and records the end', { timeout: 60_000 }, async () => {
  const dir = await tempDir('runner-');
  const d = { tmpRoot: join(dir, 'tmp'), logRoot: join(dir, 'logs'), mirrorRoot: join(dir, 'm'), stateRoot: join(dir, 'state'), gh: 'gh', ghTimeoutMs: 60_000, fetchTimeoutMs: 120_000 };
  // `dir` is no git checkout: the deploy path fails at its first step, before it asks anyone anything.
  const started = await startDetachedDeploy({ d, repo: 't/r', cwd: dir, tip: TIP, floors: {} });
  atTestEnd(() => killQuietly(started.pid));
  await waitUntil(async () => (await readDeploys({ d, repo: 't/r' })).ended.length === 1, 'the runner records its end');
  assert.deepEqual((await readDeploys({ d, repo: 't/r' })).ended.map((x) => [x.id, x.code, x.migrationsWaiting]), [[started.id, 1, false]]);
  assert.match(await readFile(started.log, 'utf8'), /✗ ship deploy: /);
  assert.equal(await isGone(started.pid, 10_000), true);
});

test('the runner runs the ship deploy path with the land\'s floor and records how it ended', async () => {
  const { s, otherFirst } = await requiresSetup();
  const code = await runDetachedDeploy({ cwd: s.work, repo: 't/r', tip: s.head, floors: { 't/api': otherFirst }, id: 'r1', log: '/r1.out' }, s.deps);
  assert.equal(code, 0, s.lines.join('\n'));
  assert.ok(s.lines.includes(`✓ requires t/api app: live at or past ${otherFirst.slice(0, 7)}`), s.lines.join('\n'));
  assert.deepEqual((await readDeploys({ d: s.deps, repo: 't/r' })).ended.map((x) => [x.id, x.tip, x.code]), [['r1', s.head, 0]]);
});

test('two runners started at once collapse into one deploy, and both record its result', async () => {
  const s = await setupDeploy({ seed: ({ first }) => ({ 'example-app': at(first), 'example-tick': at(first) }), change: { 'app/src/a.ts': '2' } });
  await addAcks(s.deps.stateRoot, 't/r', ['db/001.sql']);
  const run = (id) => runDetachedDeploy({ cwd: s.work, repo: 't/r', tip: s.head, floors: {}, id, log: `/${id}.out` }, s.deps);
  assert.deepEqual(await Promise.all([run('c1'), run('c2')]), [0, 0], s.lines.join('\n'));
  assert.equal((await s.cloud.wranglerCalls()).filter((c) => c.cmd === 'versions upload').length, 1);
  assert.deepEqual((await readDeploys({ d: s.deps, repo: 't/r' })).ended.map((x) => x.code), [0, 0]);
});

test('the detached deploy survives a SIGHUP to the land\'s process group and a SIGKILL of the land', { timeout: 60_000 }, async () => {
  const dir = await tempDir('detached-');
  const d = { tmpRoot: join(dir, 'tmp'), logRoot: join(dir, 'logs'), mirrorRoot: join(dir, 'm'), stateRoot: join(dir, 'state'), gh: 'gh', ghTimeoutMs: 60_000, fetchTimeoutMs: 120_000 };
  const go = join(dir, 'go');
  // A runner that says where it runs and with which limits, waits to be told to finish, then records
  // its end as the real one does.
  const runner = join(dir, 'runner.mjs');
  await writeFile(runner, `
import { existsSync } from 'node:fs';
import { recordDeployEnd } from ${JSON.stringify(new URL('../lib/land-deploy.mjs', import.meta.url).href)};
export async function runDetachedDeploy(a) {
  process.stdout.write('runner started in ' + process.cwd() + ' for ' + a.cwd + ' limits ' + a.deps.ghTimeoutMs + ' ' + a.deps.fetchTimeoutMs + '\\n');
  while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 20));
  await recordDeployEnd({ d: a.deps, repo: a.repo, id: a.id, tip: a.tip, code: 0, log: a.log });
  return 0;
}
`);
  // The land: leads its own process group, as bin/ship.mjs makes ship do, starts the deploy and waits.
  const landScript = `
import { startDetachedDeploy } from ${JSON.stringify(new URL('../lib/land-deploy.mjs', import.meta.url).href)};
const a = JSON.parse(process.argv[1]);
const s = await startDetachedDeploy({ d: a.d, repo: 't/r', cwd: a.cwd, tip: a.tip, floors: {}, runnerUrl: a.runnerUrl });
process.stdout.write('started ' + s.pid + ' ' + s.log + '\\n');
setInterval(() => {}, 1000);
`;
  const args = JSON.stringify({ d, cwd: dir, tip: TIP, runnerUrl: pathToFileURL(runner).href });
  const landProc = spawn(process.execPath, ['--input-type=module', '-e', landScript, args], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  atTestEnd(() => { try { process.kill(-landProc.pid, 'SIGKILL'); } catch { /* gone */ } });
  let out = '';
  landProc.stdout.on('data', (b) => { out += b; });
  await waitUntil(() => /started \d+ \S+\n/.test(out), 'the land started the deploy');
  const [, pid, log] = out.match(/started (\d+) (\S+)/);
  const runnerPid = Number(pid);
  atTestEnd(() => killQuietly(runnerPid));
  await waitUntil(async () => (await readFile(log, 'utf8').catch(() => '')).includes('runner started'), 'the runner runs');
  assert.ok((await readFile(log, 'utf8')).includes(`runner started in ${await realpath(d.tmpRoot)} for ${dir} limits 60000 120000`),
    'it runs in $SHIP_TMP, not in the checkout a session may remove, and with the land\'s limits');
  process.kill(-landProc.pid, 'SIGHUP');
  try { process.kill(landProc.pid, 'SIGKILL'); } catch { /* the hangup ended it already */ }
  await waitUntil(() => !isAlive(landProc.pid), 'the land is gone');
  assert.equal(isAlive(runnerPid), true, 'the deploy runs on');
  assert.deepEqual((await readDeploys({ d, repo: 't/r' })).running.map((x) => x.pid), [runnerPid]);
  await writeFile(go, '');
  await waitUntil(async () => (await readDeploys({ d, repo: 't/r' })).ended.length === 1, 'the deploy records its end');
  assert.equal(await isGone(runnerPid, 10_000), true);
});

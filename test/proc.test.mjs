import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { buildEnv, run, capture, ownsItsGroup } from '../lib/proc.mjs';
import { assertGone, killQuietly, readPid, tempDir } from './helpers.mjs';

const tmp = () => tempDir('proc-');

test('buildEnv keeps only allowlisted keys and forces a real locale', () => {
  const env = buildEnv({ EXTRA: '1' }, { HOME: '/h', PATH: '/p', SECRET_TOKEN: 's', LC_ALL: 'C', TMPDIR: '/t' });
  assert.equal(env.HOME, '/h');
  assert.equal(env.TMPDIR, '/t');
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.LC_ALL, 'en_US.UTF-8');
  assert.equal(env.CI, 'true');
  assert.equal(env.EXTRA, '1');
});

test('run returns the exit code and the last lines, and writes the log', async () => {
  const dir = await tmp();
  const logFile = join(dir, 'log');
  const r = await run('for i in 1 2 3 4 5; do echo line$i; done; exit 7', { cwd: dir, env: buildEnv(), logFile, tailLines: 3 });
  assert.equal(r.code, 7);
  assert.deepEqual(r.tail, ['line3', 'line4', 'line5']);
  assert.match(await readFile(logFile, 'utf8'), /\$ for i in[\s\S]*line1/);
});

test('run captures stderr', async () => {
  const dir = await tmp();
  const r = await run('echo oops >&2', { cwd: dir, env: buildEnv(), logFile: join(dir, 'log') });
  assert.equal(r.code, 0);
  assert.deepEqual(r.tail, ['oops']);
});

test('a command past its timeout is killed with its descendants and returns 124', async () => {
  const dir = await tmp();
  const pidFile = join(dir, 'pid');
  const started = Date.now();
  try {
    const r = await run(`sleep 31.4159 & echo $! > ${pidFile}; wait`, { cwd: dir, env: buildEnv(), logFile: join(dir, 'log'), timeoutMs: 300 });
    assert.equal(r.code, 124);
    assert.ok(Date.now() - started < 20_000); // the descendant sleeps 31 s: the timeout must not wait for it
    assert.match(r.tail.at(-1), /timed out/);
    await assertGone(pidFile, 'the descendant is still running');
  } finally {
    killQuietly(await readPid(pidFile));
  }
});

test('capture returns stdout and throws on failure', async () => {
  assert.equal(await capture('printf', ['hi']), 'hi');
  await assert.rejects(() => capture('false', []));
});

// --- a step whose descendants keep its output open ---------------------------------------------

const deadline = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not return within ${ms} ms`)), ms).unref());
// ship runs as the leader of its own process group (bin/ship.mjs); this reproduces that setup so
// that run() may stop orphans by group membership. A hard deadline kills the whole group.
async function runAsLeader(command, timeoutMs, dir) {
  const script = join(dir, 'leader.mjs');
  const mod = new URL('../lib/proc.mjs', import.meta.url).href;
  await writeFile(script, `
import { run, buildEnv } from ${JSON.stringify(mod)};
const started = Date.now();
const r = await run(${JSON.stringify(command)}, { cwd: '/', env: buildEnv(), logFile: ${JSON.stringify(join(dir, 'log'))}, timeoutMs: ${timeoutMs} });
process.stdout.write(JSON.stringify({ code: r.code, ms: Date.now() - started, tail: r.tail }) + '\\n');
`);
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('close', resolve));
  try {
    await Promise.race([exited, deadline(25_000, 'the leader process')]);
    return JSON.parse(out);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
}

test('a step that exits but leaves a background process holding its output returns after a short grace', { timeout: 60_000 }, async () => {
  const dir = await tmp();
  const pidFile = join(dir, 'pid');
  try {
    const started = Date.now();
    const r = await Promise.race([
      run(`(sleep 20.4711 & echo $! > ${pidFile}); echo done`, { cwd: dir, env: buildEnv(), logFile: join(dir, 'log') }),
      deadline(18_000, 'run'),
    ]);
    assert.equal(r.code, 0);
    assert.ok(r.tail.includes('done'));
    assert.ok(Date.now() - started < 15_000); // the orphan sleeps 20 s: run() must not wait for it
  } finally {
    killQuietly(await readPid(pidFile)); // this process is not a group leader: it does not stop orphans
  }
});

test('a timed-out step returns promptly and its orphan (re-parented, holding stdout) is killed', { timeout: 60_000 }, async () => {
  const dir = await tempDir('leader-');
  const pidFile = join(dir, 'pid');
  try {
    const r = await runAsLeader(`(sleep 20.4712 & echo $! > ${pidFile}); exit 0`, 300, dir);
    assert.equal(r.code, 124);
    assert.ok(r.ms < 15_000, `took ${r.ms} ms`); // the orphan sleeps 20 s
    await assertGone(pidFile, 'the orphan is still running');
  } finally {
    killQuietly(await readPid(pidFile));
  }
});

test('a descendant that ignores SIGTERM is SIGKILLed and the timeout still returns promptly', { timeout: 60_000 }, async () => {
  const dir = await tempDir('leader-');
  const pidFile = join(dir, 'pid');
  try {
    const r = await runAsLeader(`trap '' TERM; sleep 20.4714 & echo $! > ${pidFile}; wait`, 300, dir);
    assert.equal(r.code, 124);
    assert.ok(r.ms < 15_000, `took ${r.ms} ms`); // the descendant sleeps 20 s
    await assertGone(pidFile, 'the descendant is still running');
  } finally {
    killQuietly(await readPid(pidFile));
  }
});

test('a process group is ship\'s own only when ship leads it and has no controlling terminal', () => {
  assert.equal(ownsItsGroup({ pid: 10, pgid: '10', tty: '??' }), true); // macOS, after setsid
  assert.equal(ownsItsGroup({ pid: 10, pgid: 10, tty: '?' }), true); // Linux, after setsid
  assert.equal(ownsItsGroup({ pid: 10, pgid: '10', tty: 'ttys003' }), false); // a shell job: `ship check | tee log`
  assert.equal(ownsItsGroup({ pid: 10, pgid: '10', tty: 'pts/3' }), false);
  assert.equal(ownsItsGroup({ pid: 10, pgid: '4', tty: '??' }), false); // not the leader
  assert.equal(ownsItsGroup({ pid: 10, pgid: '10', tty: '' }), false); // unknown is not ours
  assert.equal(ownsItsGroup({ pid: 10, pgid: undefined, tty: '??' }), false);
});

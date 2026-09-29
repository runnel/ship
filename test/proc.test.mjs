import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildEnv, run, capture } from '../lib/proc.mjs';
import { tempDir } from './helpers.mjs';

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
  const started = Date.now();
  const r = await run('sleep 31.4159 & wait', { cwd: dir, env: buildEnv(), logFile: join(dir, 'log'), timeoutMs: 300 });
  assert.equal(r.code, 124);
  assert.ok(Date.now() - started < 4000);
  assert.match(r.tail.at(-1), /timed out/);
  const left = await capture('pgrep', ['-f', 'sleep 31.4159']).catch(() => '');
  assert.equal(left.trim(), '');
});

test('capture returns stdout and throws on failure', async () => {
  assert.equal(await capture('printf', ['hi']), 'hi');
  await assert.rejects(() => capture('false', []));
});

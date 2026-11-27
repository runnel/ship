import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claimMarker, markedFiles, notifyOwner, releaseMarker, runNotifyCommand } from '../lib/notify.mjs';
import { validateConfig, ConfigError } from '../lib/config.mjs';
import { tempDir } from './helpers.mjs';

const base = { repo: 'acme/app', checks: [{ name: 'unit', paths: ['src/**'], steps: ['npm test'] }] };

test('config: notify is optional; command is an argv array; desktop defaults to true', () => {
  assert.equal(validateConfig(base).notify, null);
  assert.deepEqual(validateConfig({ ...base, notify: { command: ['node', 'bin/post.mjs', '-'] } }).notify, { command: ['node', 'bin/post.mjs', '-'], desktop: true, timeoutSec: 30 });
  assert.deepEqual(validateConfig({ ...base, notify: { desktop: true } }).notify, { command: null, desktop: true, timeoutSec: 30 });
  for (const bad of [{ command: 'node post.mjs' }, { command: [] }, { command: [''] }, { desktop: 'yes' }, { timeoutSec: 0 }, { timeoutSec: 301 }, { other: 1 }, []]) {
    assert.throws(() => validateConfig({ ...base, notify: bad }), ConfigError, JSON.stringify(bad));
  }
});

test('runNotifyCommand: the message comes on stdin; a failure and a timeout are said, not thrown', async () => {
  const dir = await tempDir();
  const out = join(dir, 'msg.txt');
  const write = `require('fs').writeFileSync(${JSON.stringify(out)}, require('fs').readFileSync(0, 'utf8'))`;
  assert.equal(await runNotifyCommand([process.execPath, '-e', write], 'line one\nline two', { timeoutMs: 10_000 }), null);
  assert.equal(await readFile(out, 'utf8'), 'line one\nline two');
  assert.equal(await runNotifyCommand([process.execPath, '-e', 'console.error("no token"); process.exit(2)'], 'x', { timeoutMs: 10_000 }), 'exit 2: no token');
  assert.equal(await runNotifyCommand([process.execPath, '-e', 'setTimeout(() => {}, 60_000)'], 'x', { timeoutMs: 300 }), 'timed out after 0.3 s');
  assert.match(await runNotifyCommand([join(dir, 'missing')], 'x', { timeoutMs: 10_000 }), /ENOENT/);
  const t0 = Date.now();
  assert.equal(await runNotifyCommand(['/bin/sh', '-c', 'sleep 30 & wait'], 'x', { timeoutMs: 300 }), 'timed out after 0.3 s', 'a child of the command does not hold it up');
  assert.ok(Date.now() - t0 < 5000);
});

test('markers: the first claim wins, a release is had once', async () => {
  const root = await tempDir();
  assert.equal(await claimMarker(root, 'acme/app', 'db/migrations/001_x.sql', { pr: 1 }), true);
  assert.equal(await claimMarker(root, 'acme/app', 'db/migrations/001_x.sql', { pr: 2 }), false);
  assert.deepEqual(await markedFiles(root, 'acme/app'), ['db/migrations/001_x.sql']);
  assert.deepEqual(await markedFiles(root, 'acme/other'), []);
  assert.equal(await releaseMarker(root, 'acme/app', 'db/migrations/001_x.sql'), true);
  assert.equal(await releaseMarker(root, 'acme/app', 'db/migrations/001_x.sql'), false);
  assert.equal(await claimMarker(root, 'acme/app', 'db/migrations/001_x.sql', { pr: 3 }), true, 'a new hold of the same file');
});

test('notifyOwner: nothing without a block; the desktop only when there is no command or it failed', async () => {
  const lines = [];
  const calls = [];
  const d = {
    out: (l) => lines.push(l),
    notifyCommand: async (command) => { calls.push(['cmd', command[0]]); return command[0] === 'bad' ? 'exit 1' : null; },
    desktopNotify: async (title) => { calls.push(['desktop', title]); return null; },
  };
  assert.equal(await notifyOwner({ d, notify: null, title: 't', text: 'x' }), false);
  assert.equal(await notifyOwner({ d, notify: { command: ['ok'], desktop: true, timeoutSec: 30 }, title: 't', text: 'x' }), true);
  assert.equal(await notifyOwner({ d, notify: { command: ['bad'], desktop: true, timeoutSec: 30 }, title: 't', text: 'x' }), true);
  assert.equal(await notifyOwner({ d, notify: { command: null, desktop: true, timeoutSec: 30 }, title: 't', text: 'x' }), true);
  assert.equal(await notifyOwner({ d, notify: { command: ['bad'], desktop: false, timeoutSec: 30 }, title: 't', text: 'x' }), false);
  assert.deepEqual(calls, [['cmd', 'ok'], ['cmd', 'bad'], ['desktop', 't'], ['desktop', 't'], ['cmd', 'bad']]);
  assert.deepEqual(lines, ['! the notify command failed (exit 1); showing a desktop notification instead', '! the notify command failed (exit 1)']);
});

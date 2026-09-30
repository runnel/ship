import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ship.mjs', import.meta.url));
const ship = (...args) => promisify(execFile)(process.execPath, [BIN, ...args], { timeout: 20_000 })
  .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('an unknown flag of ship deploy is named, its usage is printed, and it exits 2', { timeout: 30_000 }, async () => {
  const r = await ship('deploy', '--nope');
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /^✗ ship deploy: .*--nope/);
  assert.match(r.stdout, /^ship deploy \[<deployable>…\] \[--dry-run\] \[--redeploy\] {3,}deploy what changed on main since it went live\n$/);
});

test('--redeploy without a name is a usage error; the usage lists ship deploy', { timeout: 30_000 }, async () => {
  const r = await ship('deploy', '--redeploy');
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stdout, /names are required/);
  assert.match((await ship()).stdout, /ship deploy \[<deployable>…\] \[--dry-run\] \[--redeploy\]/);
});

test('ship status takes no arguments: an unknown flag or a name is named, its usage is printed, and it exits 2', { timeout: 30_000 }, async () => {
  for (const arg of ['--nope', 'app']) {
    const r = await ship('status', arg);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`^✗ ship status: .*${arg}`));
    assert.match(r.stdout, /^ship status {5,}live commit, pending changes, holds per deployable\n$/);
  }
  assert.match((await ship()).stdout, /ship status {5,}live commit/);
});

test('an unknown flag of ship adopt or ship rollback is named, its usage is printed, and it exits 2', { timeout: 30_000 }, async () => {
  const adopt = await ship('adopt', '--nope');
  assert.equal(adopt.code, 2, adopt.stderr);
  assert.match(adopt.stderr, /^✗ ship adopt: .*--nope/);
  assert.match(adopt.stdout, /^ship adopt --at <sha> \(<deployable>…\|--all\) \| --plan {3,}record what is live/);
  const rollback = await ship('rollback', 'app', '--nope');
  assert.equal(rollback.code, 2, rollback.stderr);
  assert.match(rollback.stderr, /^✗ ship rollback: .*--nope/);
  assert.match(rollback.stdout, /^ship rollback <deployable> \[--to <version> \[--revert-secrets\]\] {2,}show the rollback target/);
});

test('ship unhold and ship migrations reject what they cannot take with exit 2', { timeout: 30_000 }, async () => {
  const unhold = await ship('unhold', '--nope');
  assert.equal(unhold.code, 2, unhold.stderr);
  assert.match(unhold.stderr, /^✗ ship unhold: .*--nope/);
  const two = await ship('unhold', 'app', 'tick');
  assert.equal(two.code, 2, two.stderr);
  assert.match(two.stderr, /^✗ ship unhold: unexpected argument: tick/);
  const sub = await ship('migrations', 'apply');
  assert.equal(sub.code, 2, sub.stderr);
  assert.match(sub.stderr, /^✗ ship migrations: unknown subcommand: apply/);
  assert.match(sub.stdout, /^ship migrations ack <file>… {3,}mark migration files as cleared for deploy\n$/);
  assert.equal((await ship('migrations')).code, 2);
  const flag = await ship('migrations', 'ack', '--nope');
  assert.equal(flag.code, 2, flag.stderr);
  assert.match(flag.stderr, /^✗ ship migrations ack: .*--nope/);
});

test('the usage lists every command with its description in one column', { timeout: 30_000 }, async () => {
  const rows = (await ship()).stdout.split('\n').filter((l) => l.startsWith('  ship '));
  assert.equal(rows.length, 8);
  assert.equal(new Set(rows.map((l) => l.match(/^ {2}ship .*? {2,}/)[0].length)).size, 1, rows.join('\n'));
});

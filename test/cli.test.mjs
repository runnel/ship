import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ship.mjs', import.meta.url));
const ship = (...args) => promisify(execFile)(process.execPath, [BIN, ...args], { timeout: 60_000 })
  .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('an unknown flag of ship deploy is named, its usage is printed, and it exits 2', { timeout: 90_000 }, async () => {
  const r = await ship('deploy', '--nope');
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /^✗ ship deploy: .*--nope/);
  assert.match(r.stdout, /^ship deploy \[<deployable>…\] \[--dry-run\] \[--redeploy\] {3,}deploy what changed on main since it went live\n$/);
});

test('--redeploy without a name is a usage error; the usage lists ship deploy', { timeout: 90_000 }, async () => {
  const r = await ship('deploy', '--redeploy');
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /^✗ ship deploy: --redeploy needs deployable names\n$/);
  assert.match(r.stdout, /^ship deploy \[<deployable>…\] \[--dry-run\] \[--redeploy\] {3,}deploy what changed/);
  assert.match((await ship()).stdout, /ship deploy \[<deployable>…\] \[--dry-run\] \[--redeploy\]/);
});

// Every usage error reads the same: the problem on stderr, the command's usage line on stdout, exit 2.
const usageError = async (args, problem, usage, { lines = 1 } = {}) => {
  const r = await ship(...args);
  assert.equal(r.code, 2, `ship ${args.join(' ')}: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`^✗ ship ${problem}.*\n$`), `ship ${args.join(' ')}`);
  assert.match(r.stdout, usage, `ship ${args.join(' ')}`);
  if (lines) assert.equal(r.stdout.trimEnd().split('\n').length, lines, 'the usage of that command only');
};

test('ship check: a bad flag or an extra argument is a usage error, exit 2', { timeout: 90_000 }, async () => {
  const usage = /^ship check \[--pr <number>\] {3,}check a pull request/;
  await usageError(['check', '--nope'], 'check: .*--nope', usage);
  await usageError(['check', '42'], 'check: .*42', usage);
  await usageError(['check', '--pr'], 'check: .*--pr', usage);
});

test('missing arguments and malformed values are usage errors in the same style', { timeout: 180_000 }, async () => {
  const adopt = /^ship adopt --at <sha> /;
  await usageError(['adopt'], 'adopt: missing --at <sha>', adopt);
  await usageError(['adopt', '--all'], 'adopt: missing --at <sha>', adopt);
  await usageError(['adopt', '--at', 'abcdef1'], 'adopt: missing deployable names \\(or --all\\)', adopt);
  await usageError(['adopt', '--at', 'zz', '--all'], 'adopt: --at zz: give a commit sha', adopt);
  await usageError(['adopt', '--at', 'abcdef1', '--all', 'app'], 'adopt: give deployable names or --all, not both', adopt);
  await usageError(['adopt', '--plan', '--all'], 'adopt: --plan takes no other argument', adopt);
  const rollback = /^ship rollback <deployable> /;
  await usageError(['rollback'], 'rollback: missing deployable name', rollback);
  await usageError(['rollback', 'app', '--to', 'zzz'], 'rollback: --to zzz: give a version id', rollback);
  await usageError(['rollback', 'app', '--revert-secrets'], 'rollback: --revert-secrets needs --to <version>', rollback);
  await usageError(['unhold'], 'unhold: missing deployable name', /^ship unhold <deployable> /);
  await usageError(['unhold', '../x'], 'unhold: "../x" is not a deployable name', /^ship unhold <deployable> /);
  await usageError(['migrations', 'ack'], 'migrations ack: missing migration file names', /^ship migrations ack <file>… /);
  await usageError(['frobnicate'], 'frobnicate: unknown command', /^usage:\n {2}ship check /, { lines: 0 });
});

test('ship status takes no arguments: an unknown flag or a name is named, its usage is printed, and it exits 2', { timeout: 90_000 }, async () => {
  for (const arg of ['--nope', 'app']) {
    const r = await ship('status', arg);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`^✗ ship status: .*${arg}`));
    assert.match(r.stdout, /^ship status {5,}live commit, pending changes, holds per deployable\n$/);
  }
  assert.match((await ship()).stdout, /ship status {5,}live commit/);
});

test('an unknown flag of ship adopt or ship rollback is named, its usage is printed, and it exits 2', { timeout: 90_000 }, async () => {
  const adopt = await ship('adopt', '--nope');
  assert.equal(adopt.code, 2, adopt.stderr);
  assert.match(adopt.stderr, /^✗ ship adopt: .*--nope/);
  assert.match(adopt.stdout, /^ship adopt --at <sha> \(<deployable>…\|--all\) \| --plan {3,}record what is live/);
  const rollback = await ship('rollback', 'app', '--nope');
  assert.equal(rollback.code, 2, rollback.stderr);
  assert.match(rollback.stderr, /^✗ ship rollback: .*--nope/);
  assert.match(rollback.stdout, /^ship rollback <deployable> \[--to <version> \[--revert-secrets\]\] {2,}show the rollback target/);
});

test('ship unhold and ship migrations reject what they cannot take with exit 2', { timeout: 90_000 }, async () => {
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

test('the usage lists every command with its description in one column', { timeout: 90_000 }, async () => {
  const rows = (await ship()).stdout.split('\n').filter((l) => l.startsWith('  ship '));
  assert.equal(rows.length, 8);
  assert.equal(new Set(rows.map((l) => l.match(/^ {2}ship .*? {2,}/)[0].length)).size, 1, rows.join('\n'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ship.mjs', import.meta.url));
const ship = (...args) => promisify(execFile)(process.execPath, [BIN, ...args], { timeout: 20_000 })
  .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('an unknown flag of ship deploy prints its usage and exits 2', { timeout: 30_000 }, async () => {
  const r = await ship('deploy', '--nope');
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stdout, /^ship deploy \[<deployable>…\] \[--dry-run\] \[--redeploy\] {3}deploy what changed on main since it went live\n$/);
});

test('--redeploy without a name is a usage error; the usage lists ship deploy', { timeout: 30_000 }, async () => {
  const r = await ship('deploy', '--redeploy');
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stdout, /names are required/);
  assert.match((await ship()).stdout, /ship deploy \[<deployable>…\] \[--dry-run\] \[--redeploy\]/);
});

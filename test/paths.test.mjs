import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SHIP_TMP, ensurePrivateDir } from '../lib/paths.mjs';
import { tempDir } from './helpers.mjs';

test('the default temp root is per user, not one shared name', { skip: Boolean(process.env.SHIP_TMP) }, () => {
  assert.match(SHIP_TMP, /ship-\d+$/);
});

test('ensurePrivateDir creates a 0700 directory, tightens a looser one, and is idempotent', async () => {
  const dir = join(await tempDir(), 'a', 'ship');
  await ensurePrivateDir(dir);
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  await chmod(dir, 0o755);
  await ensurePrivateDir(dir);
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
});

test('ensurePrivateDir refuses a symlink, even one that points at a real directory', async () => {
  const base = await tempDir();
  await mkdir(join(base, 'real'));
  await symlink(join(base, 'real'), join(base, 'link'));
  await assert.rejects(() => ensurePrivateDir(join(base, 'link')), /not a plain directory/);
});

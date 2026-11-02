import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from '../lib/proc.mjs';
import { tempDir } from './helpers.mjs';

// lib/cloudflare-run.sh as a build machine runs it: from a directory that holds .ship-run/, with the
// network replaced by a `curl` that hands out a tarball of this tree, and `locale` by one that says which
// locales the machine has. Nothing leaves the test.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHA = 'a'.repeat(40);

// The tarball codeload would give: one top-level directory with ship in it.
async function shipTarball() {
  const dir = await tempDir('ship-tar-');
  await mkdir(join(dir, 'src', 'ship-x'), { recursive: true });
  for (const part of ['bin', 'lib', 'package.json']) await cp(join(ROOT, part), join(dir, 'src', 'ship-x', part), { recursive: true });
  const tarball = join(dir, 'ship.tgz');
  await capture('tar', ['-czf', tarball, '-C', join(dir, 'src'), 'ship-x']);
  return tarball;
}
const TARBALL = await shipTarball();

async function checkout({ steps, groups = 'unit', files = ['src/x.ts', 'docs/y.md'], env = {}, setup = null, shipSha = SHA, locales = 'C\nC.utf8\nPOSIX' }) {
  const dir = await realpath(await tempDir('build-'));
  await mkdir(join(dir, '.ship-run'));
  await mkdir(join(dir, 'fake'));
  await mkdir(join(dir, 'tmp'));
  const put = (name, text) => writeFile(join(dir, '.ship-run', name), text);
  await cp(join(ROOT, 'lib', 'cloudflare-run.sh'), join(dir, '.ship-run', 'run.sh'));
  await put('config.mjs', `export default { repo: 't/r', checks: [{ name: 'unit', paths: ['**'], steps: ${JSON.stringify(steps)} }] };\n`);
  await put('groups', `${groups}\n`);
  await put('changed-files', files.map((f) => `${f}\n`).join(''));
  await put('ship-sha', `${shipSha}\n`);
  await put('env.json', JSON.stringify(env));
  if (setup !== null) await put('setup.sh', setup);
  await writeFile(join(dir, 'fake', 'curl'), '#!/bin/sh\nfor last; do :; done\necho "$last" >> "$CURL_LOG"\ncat "$TARBALL"\n');
  await writeFile(join(dir, 'fake', 'locale'), `#!/bin/sh\ncat <<'EOF'\n${locales}\nEOF\n`);
  await chmod(join(dir, 'fake', 'curl'), 0o755);
  await chmod(join(dir, 'fake', 'locale'), 0o755);
  return { dir, curlLog: join(dir, 'curl.log') };
}

// Runs the script the way the build command does: `bash .ship-run/run.sh`, from the checkout root unless told otherwise.
async function build(c, { cwd = c.dir } = {}) {
  const env = { PATH: `${join(c.dir, 'fake')}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: c.dir, TMPDIR: join(c.dir, 'tmp'), CURL_LOG: c.curlLog, TARBALL };
  const path = cwd === c.dir ? '.ship-run/run.sh' : join(c.dir, '.ship-run', 'run.sh');
  try {
    return { code: 0, out: await capture('bash', [path], { cwd, env, timeout: 60_000 }) };
  } catch (e) {
    return { code: e.code, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
const curls = async (c) => (await readFile(c.curlLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);

test('run.sh downloads ship at the commit it was given, runs the groups of the handed-over config, and passes', { timeout: 60_000 }, async () => {
  const dir = await realpath(await tempDir('build-out-'));
  const out = join(dir, 'seen');
  const c = await checkout({
    steps: [`printf '%s|%s|%s' "$LC_ALL" "$SOME_VAR" "$SHIP_CHANGED_FILES" > ${out}`],
    env: { unit: { SOME_VAR: '{root}/scripts/x.cjs' } },
  });
  const r = await build(c);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(await curls(c), [`https://codeload.github.com/runnel/ship/tar.gz/${SHA}`]);
  assert.equal(await readFile(out, 'utf8'), `C.UTF-8|${c.dir}/scripts/x.cjs|src/x.ts\ndocs/y.md`, 'a machine without en_US gets C.UTF-8; {root} is the checkout; the files are the handed-over ones');
});

test('run.sh leaves the locale to ship where the machine has en_US.UTF-8', { timeout: 60_000 }, async () => {
  const dir = await realpath(await tempDir('build-out-'));
  const out = join(dir, 'seen');
  const c = await checkout({ steps: [`printf '%s' "$LC_ALL" > ${out}`], locales: 'C\nen_US.utf8\nPOSIX' });
  const r = await build(c);
  assert.equal(r.code, 0, r.out);
  assert.equal(await readFile(out, 'utf8'), 'en_US.UTF-8');
});

test('run.sh works from any directory, not only the checkout root', { timeout: 60_000 }, async () => {
  const dir = await realpath(await tempDir('build-out-'));
  const out = join(dir, 'seen');
  const c = await checkout({ steps: [`pwd > ${out}`] });
  const r = await build(c, { cwd: dir });
  assert.equal(r.code, 0, r.out);
  assert.equal((await readFile(out, 'utf8')).trim(), c.dir);
});

test('run.sh sources setup.sh first, with the groups, and what it does to PATH reaches the steps', { timeout: 60_000 }, async () => {
  const dir = await realpath(await tempDir('build-out-'));
  const out = join(dir, 'seen');
  const c = await checkout({
    steps: [`mytool > ${out}`],
    groups: 'unit',
    setup: `printf '%s' "$SHIP_GROUPS" > ${join(dir, 'groups-seen')}\nmkdir -p "$PWD/tools"\nprintf '#!/bin/sh\\necho from-setup\\n' > "$PWD/tools/mytool"\nchmod +x "$PWD/tools/mytool"\nexport PATH="$PWD/tools:$PATH"\n`,
  });
  const r = await build(c);
  assert.equal(r.code, 0, r.out);
  assert.equal(await readFile(join(dir, 'groups-seen'), 'utf8'), 'unit');
  assert.equal((await readFile(out, 'utf8')).trim(), 'from-setup');
});

test('run.sh: a red step is a red build with the tail of the log; a setup that fails stops it before anything is downloaded', { timeout: 60_000 }, async () => {
  const red = await checkout({ steps: ['echo boom-from-the-step; exit 3'] });
  const r = await build(red);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✗ unit: echo boom-from-the-step; exit 3/);
  assert.match(r.out, /--- log of the failed step ---\n[\s\S]*boom-from-the-step/);

  const broken = await checkout({ steps: ['true'], setup: 'exit 7\n' });
  const b = await build(broken);
  assert.equal(b.code, 7, b.out);
  assert.deepEqual(await curls(broken), [], 'the build stopped first');
});

test('run.sh refuses a ship commit that is not a full sha, before it downloads anything', { timeout: 60_000 }, async () => {
  for (const shipSha of ['main', 'abc1234', `${SHA}/../x`, 'A'.repeat(40)]) {
    const c = await checkout({ steps: ['true'], shipSha });
    const r = await build(c);
    assert.equal(r.code, 2, `${shipSha}: ${r.out}`);
    assert.match(r.out, /ship-sha is not a commit/);
    assert.deepEqual(await curls(c), []);
  }
});

test('run.sh: a download that fails fails the build', { timeout: 60_000 }, async () => {
  const c = await checkout({ steps: ['true'] });
  await writeFile(join(c.dir, 'fake', 'curl'), '#!/bin/sh\necho "curl: (22) 404" >&2\nexit 22\n');
  const r = await build(c);
  assert.notEqual(r.code, 0, r.out);
});

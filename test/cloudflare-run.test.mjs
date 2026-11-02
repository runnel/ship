import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from '../lib/proc.mjs';
import { git, tempDir } from './helpers.mjs';

// lib/cloudflare-run.sh as a build machine runs it: from a git checkout that holds .ship-run/, started for
// that commit (WORKERS_CI_COMMIT_SHA), with the network replaced by a `curl` that hands out a tarball of
// this tree, and `locale` by one that says which locales the machine has. Nothing leaves the test.

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

// `nodeVersion`: a `node` that says it is that version, ahead of the real one on PATH.
async function checkout({ steps, groups = 'unit', files = ['src/x.ts', 'docs/y.md'], env = {}, setup = null, shipSha = SHA, locales = 'C\nC.utf8\nPOSIX', nodeVersion = null }) {
  const dir = await realpath(await tempDir('build-'));
  await mkdir(join(dir, '.ship-run'));
  const fake = await realpath(await tempDir('fake-')); // outside the checkout, as the tools of a build image are
  await mkdir(join(dir, 'tmp'));
  const put = (name, text) => writeFile(join(dir, '.ship-run', name), text);
  await cp(join(ROOT, 'lib', 'cloudflare-run.sh'), join(dir, '.ship-run', 'run.sh'));
  await put('config.mjs', `export default { repo: 't/r', checks: [{ name: 'unit', paths: ['**'], steps: ${JSON.stringify(steps)} }] };\n`);
  await put('groups', `${groups}\n`);
  await put('changed-files', files.map((f) => `${f}\n`).join(''));
  await put('ship-sha', `${shipSha}\n`);
  await put('env.json', JSON.stringify(env));
  if (setup !== null) await put('setup.sh', setup);
  await writeFile(join(fake, 'curl'), '#!/bin/sh\nfor last; do :; done\necho "$last" >> "$CURL_LOG"\ncat "$TARBALL"\n');
  await writeFile(join(fake, 'locale'), `#!/bin/sh\ncat <<'EOF'\n${locales}\nEOF\n`);
  await chmod(join(fake, 'curl'), 0o755);
  await chmod(join(fake, 'locale'), 0o755);
  if (nodeVersion !== null) {
    await writeFile(join(fake, 'node'), `#!/bin/sh\necho ${nodeVersion}\n`);
    await chmod(join(fake, 'node'), 0o755);
  }
  await git(['init', '--quiet'], dir);
  await git(['add', '-A'], dir);
  await git(['commit', '--quiet', '-m', 'the commit the build is for'], dir);
  return { dir, fake, curlLog: join(dir, 'curl.log'), sha: (await git(['rev-parse', 'HEAD'], dir)).trim() };
}

// Runs the script the way the build command does: `bash .ship-run/run.sh`, from the checkout root unless
// told otherwise, for the commit that is checked out unless told otherwise (`sha: null`: not told at all).
async function build(c, { cwd = c.dir, sha = c.sha } = {}) {
  const env = { ...(sha === null ? {} : { WORKERS_CI_COMMIT_SHA: sha }), PATH: `${c.fake}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: c.dir, TMPDIR: join(c.dir, 'tmp'), CURL_LOG: c.curlLog, TARBALL };
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
  assert.equal(b.code, 2, b.out);
  assert.match(b.out, /setup\.sh failed \(status 7\)/);
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
  await writeFile(join(c.fake, 'curl'), '#!/bin/sh\necho "curl: (22) 404" >&2\nexit 22\n');
  const r = await build(c);
  assert.notEqual(r.code, 0, r.out);
});

// --- the build is for the commit it cloned ----------------------------------------------------------------

test('run.sh runs only for the commit the build was started for: another commit, a short one, none, or an empty one is exit 2', { timeout: 60_000 }, async () => {
  for (const [what, sha] of [['another commit', 'b'.repeat(40)], ['an abbreviation of this one', null], ['none at all', null], ['an empty one', '']]) {
    const c = await checkout({ steps: ['true'] });
    const told = what === 'an abbreviation of this one' ? c.sha.slice(0, 12) : sha;
    const r = await build(c, { sha: told });
    assert.equal(r.code, 2, `${what}: ${r.out}`);
    assert.match(r.out, what === 'another commit' || what === 'an abbreviation of this one' ? /the checkout is at [0-9a-f]{40}, the build was started for / : /WORKERS_CI_COMMIT_SHA is not set/, what);
    assert.deepEqual(await curls(c), [], `${what}: nothing was downloaded, nothing ran`);
  }
});

test('run.sh: a checkout that is not at the commit it is told to be at is exit 2, even when the tree would pass', { timeout: 60_000 }, async () => {
  const c = await checkout({ steps: ['true'] });
  const first = c.sha;
  await writeFile(join(c.dir, 'later'), 'a later push\n');
  await git(['add', '-A'], c.dir);
  await git(['commit', '--quiet', '-m', 'a later push superseded the build'], c.dir);
  const r = await build(c, { sha: first });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /the build was started for /);
  assert.equal((await build(c, { sha: (await git(['rev-parse', 'HEAD'], c.dir)).trim() })).code, 0, 'for the commit it is at, it passes');
});

test('run.sh outside a git checkout is exit 2', { timeout: 60_000 }, async () => {
  const c = await checkout({ steps: ['true'] });
  await rm(join(c.dir, '.git'), { recursive: true });
  const r = await build(c);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /the checkout is at no commit/);
});

// --- setup.sh cannot end the build, or change what it does -------------------------------------------------

// Whatever the setup script does to the shell it runs in, the build that follows is the one that was
// asked for: a step that passes still passes (and runs), a step that fails is still red.
const setupCase = (name, setup, { code, out }) => test(`setup.sh ${name}`, { timeout: 60_000 }, async () => {
  const dir = await realpath(await tempDir('build-out-'));
  const marker = join(dir, 'unit-ran');
  const c = await checkout({ steps: [code === 0 ? `echo ran > ${marker}` : 'echo red-step; exit 3'], setup });
  const r = await build(c);
  assert.equal(r.code, code, r.out);
  if (out) assert.match(r.out, out, r.out);
  if (code === 0) assert.equal((await readFile(marker, 'utf8')).trim(), 'ran', 'the step ran');
  if (code === 2) assert.deepEqual(await curls(c), [], 'the build stopped before ship was downloaded');
});

setupCase('that exits 0 does not end the build green', 'exit 0\n', { code: 2, out: /setup\.sh did not run to its end/ });
setupCase('that exits with a failure ends the build', 'exit 5\n', { code: 2, out: /setup\.sh failed \(status 5\)/ });
setupCase('that has a failing command ends the build', 'false\n', { code: 2, out: /setup\.sh failed/ });
setupCase('that uses a variable it never set ends the build', 'echo "$NO_SUCH_VARIABLE"\n', { code: 2, out: /setup\.sh failed/ });
setupCase('that exits 0 from an EXIT trap after failing ends the build', "trap 'exit 0' EXIT\nexit 1\n", { code: 2, out: /did not run to its end/ });
setupCase('that sets an EXIT trap leaves it in the subshell: a red step stays red', "trap 'exit 0' EXIT\n", { code: 1, out: /red-step/ });
setupCase('that changes the groups leaves them alone: the group that was asked for runs', 'groups=other\n', { code: 0 });
setupCase('that empties the groups leaves them alone', 'groups=\n', { code: 0 });
setupCase('that defines a function named node does not replace node: a red step stays red', 'node() { return 0; }\nexport -f node\n', { code: 1, out: /red-step/ });
setupCase('that defines a function named node does not replace node: a good step runs', 'node() { return 0; }\nexport -f node\n', { code: 0 });

// --- the Node that runs ship ----------------------------------------------------------------------------------

test('run.sh refuses a Node older than 24, before it downloads anything', { timeout: 60_000 }, async () => {
  for (const version of ['22', '20', '8', '23']) {
    const c = await checkout({ steps: ['true'], nodeVersion: version });
    const r = await build(c);
    assert.equal(r.code, 2, `${version}: ${r.out}`);
    assert.match(r.out, new RegExp(`node ${version} is too old: ship needs 24 or newer \\(set NODE_VERSION`));
    assert.deepEqual(await curls(c), []);
  }
  const unreadable = await checkout({ steps: ['true'], nodeVersion: 'v-not-a-number' });
  const u = await build(unreadable);
  assert.equal(u.code, 2, u.out);
  assert.match(u.out, /cannot tell which version of node/);
});

test('run.sh refuses a node that is inside the checkout, even a good one, and one the setup script put first on PATH', { timeout: 60_000 }, async () => {
  const c = await checkout({ steps: ['true'], setup: `mkdir -p "$PWD/tools"\nln -s ${process.execPath} "$PWD/tools/node"\nexport PATH="$PWD/tools:$PATH"\n` });
  const r = await build(c);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /node is .*\/tools\/node, inside the checkout/);
  assert.deepEqual(await curls(c), []);
  // A relative entry of PATH is the checkout too.
  const rel = await checkout({ steps: ['true'], setup: `mkdir -p tools\nln -s ${process.execPath} tools/node\nexport PATH="tools:$PATH"\n` });
  const q = await build(rel);
  assert.equal(q.code, 2, q.out);
  assert.match(q.out, /inside the checkout/);
});

test('run.sh takes the Node a setup script puts on PATH when it is outside the checkout and new enough', { timeout: 60_000 }, async () => {
  const dir = await realpath(await tempDir('build-out-'));
  await mkdir(join(dir, 'bin'));
  await symlink(process.execPath, join(dir, 'bin', 'node'));
  const out = join(dir, 'seen');
  const c = await checkout({ steps: [`command -v node > ${out}`], nodeVersion: '22', setup: `export PATH="${join(dir, 'bin')}:$PATH"\n` });
  const r = await build(c);
  assert.equal(r.code, 0, r.out);
  assert.equal((await readFile(out, 'utf8')).trim(), join(dir, 'bin', 'node'), 'the old node on PATH was passed over for the one setup put first');
});

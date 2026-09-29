import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { capture } from '../lib/proc.mjs';

// One scratch root per test process, removed when the process exits.
const ROOT = mkdtempSync(join(tmpdir(), 'ship-tests-'));
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));

export const tempDir = (prefix = 't-') => mkdtemp(join(ROOT, prefix));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost',
};
export const git = (args, cwd) => capture('git', args, { cwd, env: GIT_ENV });

export async function commitFiles(work, files, message) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await git(['add', '-A'], work);
  await git(['commit', '--quiet', '-m', message], work);
  return (await git(['rev-parse', 'HEAD'], work)).trim();
}

// A bare "origin" whose main holds `files`, plus a working clone (on main) to commit from.
export async function makeOrigin(files) {
  const root = await tempDir();
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  await git(['init', '--bare', '--quiet', '--initial-branch=main', origin]);
  await git(['clone', '--quiet', origin, work]);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], work);
  await commitFiles(work, files, 'initial');
  await git(['push', '--quiet', 'origin', 'main'], work);
  return { root, origin, work };
}

// A fake `gh` executable: answers the calls ship makes and records every invocation.
// apiDelay = { ms, match }: `gh api` calls whose arguments contain `match` answer after `ms`; every
// answered api call is logged again as ['done', ...args], so a call that was killed is visible.
// apiFail = { match }: `gh api` calls whose arguments contain `match` fail (exit 1), as gh does offline.
export async function fakeGh(dir, { pr, repo = { defaultBranchRef: { name: 'main' } }, runs = [], apiDelay = null, apiFail = null }) {
  const log = join(dir, 'gh.log');
  const script = join(dir, 'gh');
  await writeFile(script, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const reply = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (args[0] === 'pr' && args[1] === 'view') reply(${JSON.stringify(pr)});
if (args[0] === 'repo' && args[1] === 'view') reply(${JSON.stringify(repo)});
if (args[0] === 'run' && args[1] === 'list') reply(${JSON.stringify(runs)});
if (args[0] === 'api') {
  const fail = ${JSON.stringify(apiFail)};
  if (fail && args.join(' ').includes(fail.match)) { process.stderr.write('fake gh: forced failure'); process.exit(1); }
  const delay = ${JSON.stringify(apiDelay)};
  const ms = delay && args.join(' ').includes(delay.match) ? delay.ms : 0;
  setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(['done', ...args]) + '\\n'); reply({}); }, ms);
} else {
  process.stderr.write('fake gh: unhandled ' + args.join(' '));
  process.exit(1);
}
`);
  await chmod(script, 0o755);
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { gh: script, calls };
}

export const CONFIG = (steps, extra = {}) =>
  `export default { repo: 't/r', docsOnly: ['*.md'], checks: [${JSON.stringify({ name: 'unit', paths: ['src/**'], steps, ...extra })}] };\n`;

// origin: main has the config + a.txt; branch feat adds featFiles; main then moves with mainFiles.
export async function setupCheck({
  steps = ['test -f src/x.ts', 'test -f b.txt'], checkExtra = {},
  featFiles = { 'src/x.ts': 'x\n' }, mainFiles = { 'b.txt': 'b\n' }, prOverrides = {}, mainConfig = true, configText = null, ghOptions = {},
} = {}) {
  const { origin, work, root } = await makeOrigin({ ...(mainConfig ? { 'ship.config.mjs': configText ?? CONFIG(steps, checkExtra) } : {}), 'a.txt': 'a\n' });
  await git(['checkout', '--quiet', '-b', 'feat'], work);
  const head = await commitFiles(work, featFiles, 'feat');
  await git(['push', '--quiet', 'origin', 'feat'], work);
  await git(['checkout', '--quiet', 'main'], work);
  await commitFiles(work, mainFiles, 'main moves');
  await git(['push', '--quiet', 'origin', 'main'], work);
  await git(['checkout', '--quiet', 'feat'], work);
  await git(['remote', 'set-url', 'origin', 'https://github.com/t/r.git'], work);
  const pr = { number: 7, headRefOid: head, headRefName: 'feat', baseRefName: 'main', isCrossRepository: false, state: 'OPEN', ...prOverrides };
  const fake = await fakeGh(root, { pr, ...ghOptions });
  const lines = [];
  const deps = {
    gh: fake.gh, remoteUrl: () => origin,
    mirrorRoot: join(root, 'mirrors'), tmpRoot: join(root, 'tmp'), logRoot: join(root, 'logs'),
    out: (s) => lines.push(s), pollMs: 10,
  };
  const statuses = async () =>
    (await fake.calls())
      .filter((a) => a[0] === 'api')
      .map((a) => Object.fromEntries(a.filter((x) => /^(state|description)=/.test(x)).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)])));
  return { work, deps, statuses, lines, origin, root, gh: fake.gh, calls: fake.calls };
}

// runCheck in a child process that leads its own process group, as bin/ship.mjs makes ship do.
// Printed lines go to `out.text`; `exited` resolves with the exit code; `kill()` ends the whole
// group (the test's cleanup: nothing may outlive it).
export async function spawnCheckLeader(s, dir, { env = process.env, pollMs = 10, unwindPostTimeoutMs } = {}) {
  const script = join(dir, 'check.mjs');
  const mod = new URL('../lib/check.mjs', import.meta.url).href;
  await writeFile(script, `
import { runCheck } from ${JSON.stringify(mod)};
const a = JSON.parse(process.argv[2]);
const deps = { gh: a.gh, remoteUrl: () => a.origin, mirrorRoot: a.mirrorRoot, tmpRoot: a.tmpRoot, logRoot: a.logRoot, pollMs: a.pollMs, out: (l) => process.stdout.write(l + '\\n') };
if (a.unwindPostTimeoutMs) deps.unwindPostTimeoutMs = a.unwindPostTimeoutMs;
const code = await runCheck({ cwd: a.cwd, deps });
process.stdout.write('RETURNED ' + code + '\\n');
`);
  const arg = JSON.stringify({ gh: s.gh, origin: s.origin, cwd: s.work, mirrorRoot: s.deps.mirrorRoot, tmpRoot: s.deps.tmpRoot, logRoot: s.deps.logRoot, pollMs, unwindPostTimeoutMs });
  const child = spawn(process.execPath, [script, arg], { detached: true, stdio: ['ignore', 'pipe', 'inherit'], env });
  const out = { text: '' };
  child.stdout.on('data', (b) => { out.text += b; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ } };
  return { child, out, exited, kill };
}

// Process checks by recorded pid: `pgrep -f <text>` is machine-wide, so two runs of the suite at
// once (or ship checking this repository while the suite runs) could fail each other.
//
// Only real pids are ever passed to process.kill: 0 means "my whole process group" and a negative
// number a whole other one, so a missing or empty pid file (a step that never ran, a test that timed
// out first) must not turn a cleanup into killing the runner, or ship itself when ship checks itself.
const isPid = (pid) => Number.isInteger(pid) && pid > 0;

export const isAlive = (pid) => {
  if (!isPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
// The pid a step wrote to `file`, or null when there is none (missing, empty, not a number).
export async function readPid(file) {
  const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim());
  return isPid(pid) ? pid : null;
}
// True once the process is gone (a killed orphan is reaped a moment later), false after `ms`.
export async function isGone(pid, ms = 3000) {
  const until = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}
// The step recorded a pid, and that process is gone. A missing pid file fails loudly here instead
// of passing (isGone of nothing).
export async function assertGone(file, message, ms = 3000) {
  const pid = await readPid(file);
  assert.ok(pid, 'the step never recorded its pid');
  assert.equal(await isGone(pid, ms), true, message);
}
export const killQuietly = (pid) => {
  if (!isPid(pid) || pid === process.pid) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
};

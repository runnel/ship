import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { capture, isPid } from '../lib/proc.mjs';

// One scratch root per test process, removed when the process exits.
const ROOT = mkdtempSync(join(tmpdir(), 'ship-tests-'));
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));

export const tempDir = (prefix = 't-') => mkdtemp(join(ROOT, prefix));

// Polls `fn` until it is true; fails with `what` after `ms`.
export async function waitUntil(fn, what, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${what}: not reached within ${ms} ms`);
}

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
// prSequence = [overrides…]: the Nth `gh pr view` answers `pr` merged with the Nth entry (the last
// entry repeats), as GitHub does while it catches up with a push; empty: every answer is `pr`. An
// entry { fail: true } makes that `gh pr view` fail (exit 1) instead.
// openPrs = [{ number, files: [{ path }] }]: what `gh pr list` prints (the open pull requests).
// prListFail: `gh pr list` fails (exit 1) with a reason on stderr, as gh does when GitHub is unreachable.
// statuses = { <sha>: [{ context, state, description }] }: what the combined-status call answers for
// that commit (an empty list for any other sha, as GitHub does for a commit without statuses).
// mergeFail = 'reason': `gh pr merge` fails (exit 1) with that reason on stderr, as gh does when GitHub refuses.
// mergeDelayMs: `gh pr merge` answers only after that long (a hung call).
// The pull request can also change while a check runs: every `gh pr view` merges the JSON in
// `<dir>/pr-live.json` (when it exists) over its answer, last (see setPr in setupCheck).
// github = { usage, dispatchFail, runs, runReadFails, jobs, jobLog }: the Actions side. `usage` answers
// the billing report (undefined: gh fails); `dispatchFail` makes the dispatch fail; `runs` = [overrides…]
// is what the Nth read of the run says on top of a run of the workflow that was dispatched, the last one
// repeating; `runReadFails` makes the first reads fail.
export async function fakeGh(dir, { pr, prSequence = [], repo = { defaultBranchRef: { name: 'main' } }, runs = [], apiDelay = null, apiFail = null, openPrs = [], prListFail = false, statuses = null, mergeFail = null, mergeDelayMs = 0, github = null }) {
  const log = join(dir, 'gh.log');
  const script = join(dir, 'gh');
  const viewCount = join(dir, 'gh-pr-view.count');
  await writeFile(script, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const reply = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (args[0] === 'pr' && args[1] === 'view') {
  const sequence = ${JSON.stringify(prSequence)};
  let i = 0;
  if (sequence.length > 0) {
    try { i = Number(fs.readFileSync(${JSON.stringify(viewCount)}, 'utf8')) || 0; } catch { /* first call */ }
    fs.writeFileSync(${JSON.stringify(viewCount)}, String(i + 1));
  }
  const entry = sequence.length > 0 ? sequence[Math.min(i, sequence.length - 1)] : {};
  if (entry.fail) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }
  let live = {};
  try { live = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'pr-live.json'))}, 'utf8')); } catch { /* the pull request is as it was */ }
  reply({ ...${JSON.stringify(pr)}, ...entry, ...live });
}
if (args[0] === 'pr' && args[1] === 'list') {
  if (${JSON.stringify(prListFail)}) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }
  reply(${JSON.stringify(openPrs)});
}
if (args[0] === 'pr' && args[1] === 'merge') {
  if (${JSON.stringify(mergeDelayMs)} > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${JSON.stringify(mergeDelayMs)});
  if (${JSON.stringify(mergeFail)}) { process.stderr.write(${JSON.stringify(mergeFail)} + '\\n'); process.exit(1); }
  reply({});
}
const asked = ${JSON.stringify(statuses)} !== null && args[0] === 'api' && /\\/commits\\/([0-9a-f]+)\\/statuses/.exec(args[1]);
if (asked) reply(${JSON.stringify(statuses)}[asked[1]] ?? []);
const github = ${JSON.stringify(github)};
if (github && args[0] === 'api') {
  const path = args.find((x) => x.includes('/'));
  const nonceFile = ${JSON.stringify(join(dir, 'gh-nonce'))};
  const reads = ${JSON.stringify(join(dir, 'gh-run-reads'))};
  if (path.includes('/settings/billing/usage')) {
    if (github.usage === undefined) { process.stderr.write('HTTP 403: Forbidden\\n'); process.exit(1); }
    reply(github.usage);
  }
  if (path.endsWith('/dispatches')) {
    if (github.dispatchFail) { process.stderr.write(github.dispatchFail + '\\n'); process.exit(1); }
    fs.writeFileSync(nonceFile, args.find((x) => x.startsWith('inputs[nonce]=')).split('=')[1]);
    reply({ workflow_run_id: 555, run_url: 'https://api.example.com/runs/555', html_url: 'https://example.com/runs/555' });
  }
  if (path.endsWith('/actions/runs/555/cancel')) reply({});
  if (path.endsWith('/actions/runs/555/jobs')) reply({ jobs: github.jobs ?? [] });
  if (/\\/actions\\/jobs\\/\\d+\\/logs$/.test(path)) { process.stdout.write(github.jobLog ?? ''); process.exit(0); }
  if (path.endsWith('/actions/runs/555')) {
    let i = 0;
    try { i = Number(fs.readFileSync(reads, 'utf8')) || 0; } catch { /* first read */ }
    fs.writeFileSync(reads, String(i + 1));
    if (i < (github.runReadFails ?? 0)) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }
    const list = github.runs ?? [{}];
    reply({ id: 555, path: '.github/workflows/ship-check.yml', event: 'workflow_dispatch', head_branch: 'main', display_title: 'ship check ' + fs.readFileSync(nonceFile, 'utf8'), status: 'completed', conclusion: 'success', ...list[Math.min(i, list.length - 1)] });
  }
}
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

// The status posts among a fake gh's recorded calls: [{ sha, state, description }].
export const statusesOf = (calls) =>
  calls
    .filter((a) => a[0] === 'api' && a[3]?.includes('/statuses/'))
    .map((a) => ({
      sha: a[3].slice(a[3].lastIndexOf('/') + 1),
      ...Object.fromEntries(a.filter((x) => /^(state|description|target_url)=/.test(x)).map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)])),
    }));

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
    overflowRoot: join(root, 'overflow'), overflowAskMs: 0, githubPollMs: 5, shipSha: async () => 'c'.repeat(40),
    out: (s) => lines.push(s), pollMs: 10,
    onBattery: async () => false, // never ask the real pmset: a test that wants the warning injects its own
  };
  const statuses = async () => statusesOf(await fake.calls());
  // The pull request as GitHub shows it from now on: setPr({ state: 'MERGED' }), setPr({ headRefOid: … }).
  const setPr = (overrides) => writeFile(join(root, 'pr-live.json'), JSON.stringify(overrides));
  return { work, deps, statuses, lines, origin, root, gh: fake.gh, calls: fake.calls, setPr };
}

// runCheck in a child process that leads its own process group, as bin/ship.mjs makes ship do.
// Printed lines go to `out.text`; `exited` resolves with the exit code; `kill()` ends the whole
// group (the test's cleanup: nothing may outlive it).
export async function spawnCheckLeader(s, dir, { env = process.env, pollMs = 10, unwindPostTimeoutMs, github = false } = {}) {
  const script = join(dir, 'check.mjs');
  const mod = new URL('../lib/check.mjs', import.meta.url).href;
  await writeFile(script, `
import { runCheck } from ${JSON.stringify(mod)};
import { isInterrupted } from ${JSON.stringify(new URL('../lib/interrupt.mjs', import.meta.url).href)};
const a = JSON.parse(process.argv[2]);
const deps = { gh: a.gh, remoteUrl: () => a.origin, mirrorRoot: a.mirrorRoot, tmpRoot: a.tmpRoot, logRoot: a.logRoot, pollMs: a.pollMs, out: (l) => process.stdout.write(l + '\\n') };
if (a.unwindPostTimeoutMs) deps.unwindPostTimeoutMs = a.unwindPostTimeoutMs;
if (a.github) Object.assign(deps, { overflowRoot: a.overflowRoot, githubPollMs: 5, shipSha: async () => 'c'.repeat(40) });
// Like lib/cli.mjs: an interrupt that makes a call fail is exit 130, anything else a plain failure.
let code;
try {
  code = await runCheck({ cwd: a.cwd, github: a.github, deps });
} catch (e) {
  if (e?.aborted || isInterrupted()) code = 130;
  else { process.stderr.write('ship check: ' + e.message + '\\n'); code = 1; }
}
process.stdout.write('RETURNED ' + code + '\\n');
process.exitCode = code;
`);
  const arg = JSON.stringify({ gh: s.gh, origin: s.origin, cwd: s.work, mirrorRoot: s.deps.mirrorRoot, tmpRoot: s.deps.tmpRoot, logRoot: s.deps.logRoot, pollMs, unwindPostTimeoutMs, github, overflowRoot: s.deps.overflowRoot });
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
// Only real pids are ever passed to process.kill (isPid, the same definition ship itself uses): 0
// means "my whole process group" and a negative number a whole other one, so a missing or empty
// pid file (a step that never ran, a test that timed out first) must not turn a cleanup into
// killing the runner, or ship itself when ship checks itself.
//
// A pid that isGone proved dead is never signalled again: it may have been reused since.
const provenGone = new Set();

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
  if (isPid(pid)) provenGone.add(pid);
  return true;
}
// The step recorded a pid, and that process is gone. A missing pid file fails loudly here instead
// of passing (isGone of nothing).
export async function assertGone(file, message, ms = 3000) {
  const pid = await readPid(file);
  assert.ok(pid, 'the step never recorded its pid');
  assert.equal(await isGone(pid, ms), true, message);
}
// `kill` is injectable so that the guard can be tested without real signals.
export const killQuietly = (pid, { kill = (p, sig) => process.kill(p, sig) } = {}) => {
  if (!isPid(pid) || pid === process.pid || provenGone.has(pid)) return;
  try { kill(pid, 'SIGKILL'); } catch { /* gone */ }
};

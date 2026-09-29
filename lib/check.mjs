import { mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { capture, run, buildEnv } from './proc.mjs';
import { ensureMirror, fetchCommit, revParse, addWorktree, removeWorktree, mergeInto, changedFiles, showFile, MIRROR_ROOT } from './git.mjs';
import { parseRepoFromUrl, prInfo, defaultBranch, postStatus, nightlyFailures } from './github.mjs';
import { loadConfigSource } from './config.mjs';
import { classify, laneFor } from './classify.mjs';
import { acquire, ownerInfo } from './lock.mjs';
import { onInterrupt, isInterrupted } from './interrupt.mjs';
import { duration, tallinn } from './report.mjs';
import { SHIP_TMP, SHIP_HOME } from './paths.mjs';

const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const STALE_WORKTREE_MS = 12 * 60 * 60 * 1000;

function defaultDeps() {
  return {
    gh: 'gh',
    remoteUrl: (repo) => `https://github.com/${repo}.git`,
    mirrorRoot: MIRROR_ROOT,
    tmpRoot: SHIP_TMP,
    logRoot: join(SHIP_HOME, 'logs'),
    out: (line) => process.stdout.write(`${line}\n`),
    pollMs: 5000,
  };
}

const once = (fn) => { let done = false; return (...a) => { if (!done) { done = true; fn(...a); } }; };
const everyMinute = (fn) => { let last = 0; return (...a) => { if (Date.now() - last >= 60_000) { last = Date.now(); fn(...a); } }; };

// A lock that an interrupt releases too.
async function lockWithCleanup(dir, owner, opts) {
  const release = await acquire(dir, owner, opts);
  const off = onInterrupt(release);
  return async () => { off(); await release(); };
}

export async function runCheck({ cwd, pr = null, deps = {} }) {
  const d = { ...defaultDeps(), ...deps };
  const repo = parseRepoFromUrl(await capture('git', ['-C', cwd, 'remote', 'get-url', 'origin']));
  let ref = pr;
  if (!ref) {
    ref = (await capture('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (ref === 'HEAD') { d.out('✗ detached HEAD — run: ship check --pr <number>'); return 2; }
  }
  const info = await prInfo({ repo, pr: ref, gh: d.gh });
  if (info.fork) { d.out(`✗ PR #${info.number} comes from a fork — ship never runs another account's code`); return 2; }
  if (info.state !== 'OPEN') { d.out(`✗ PR #${info.number} is ${String(info.state).toLowerCase()}`); return 2; }
  const main = await defaultBranch({ repo, gh: d.gh });
  if (info.base !== main) { d.out(`✗ PR #${info.number} targets ${info.base}; only PRs into ${main} are gated`); return 2; }

  const repoKey = repo.replace('/', '__');
  const releaseMirror = await lockWithCleanup(join(d.tmpRoot, 'locks', `mirror-${repoKey}`), await ownerInfo({ repo }), { pollMs: d.pollMs });
  let mirror, mainSha;
  try {
    mirror = await ensureMirror(repo, { root: d.mirrorRoot, url: d.remoteUrl(repo) });
    await fetchCommit(mirror, info.headSha, info.number);
    mainSha = await revParse(mirror, `refs/heads/${main}`);
  } finally {
    await releaseMirror();
  }

  const key = `${repoKey}__${info.headSha}`;
  const checksDir = join(d.tmpRoot, 'checks');
  await mkdir(checksDir, { recursive: true });
  const waitStarted = Date.now();
  const releaseSha = await lockWithCleanup(join(checksDir, key), await ownerInfo({ repo, pr: info.number }), {
    pollMs: d.pollMs,
    onWait: once(() => d.out(`… a check of ${info.headSha.slice(0, 7)} is already running — waiting for its result`)),
  });
  try {
    const resultFile = join(checksDir, `${key}.json`);
    const cached = await readFile(resultFile, 'utf8').then(JSON.parse, () => null);
    // Reuse only a result that finished while this call waited (two sessions asked for the same
    // commit at once). An older result is re-run: a red check may have been flaky, and "check
    // again" must mean check again.
    if (cached && cached.mainSha === mainSha && cached.at >= waitStarted) {
      d.out(`${cached.exitCode === 0 ? '✓' : '✗'} local-ci ${cached.state}: ${cached.description} (from the run that just finished)`);
      return cached.exitCode;
    }
    const result = await checkOnce({ d, repo, info, main, mainSha, mirror });
    // An interrupted run has no result a waiting duplicate could reuse.
    if (!isInterrupted()) await writeFile(resultFile, JSON.stringify({ ...result, mainSha, at: Date.now() }));
    return result.exitCode;
  } finally {
    await releaseSha();
  }
}

async function checkOnce({ d, repo, info, main, mainSha, mirror }) {
  const sha7 = info.headSha.slice(0, 7);
  const vs = `vs ${main}@${mainSha.slice(0, 7)}`;
  const started = Date.now();
  const status = (state, description) => postStatus({ repo, sha: info.headSha, state, description, gh: d.gh });
  let offStatus = () => {};
  const finish = async (state, description, exitCode) => {
    // An interrupted run posts no verdict of its own: the unwind posts the error status, and
    // whatever the flow concluded after the signal (a step killed and reported as failed, a merge
    // cut short) is an artefact of the interrupt.
    if (isInterrupted()) return { state: 'error', description: 'interrupted', exitCode: 1 };
    offStatus(); // from here on an interrupt must not overwrite the final status
    await status(state, description);
    d.out(`${exitCode === 0 ? '✓' : '✗'} local-ci ${state}: ${description}`);
    const now = await prInfo({ repo, pr: String(info.number), gh: d.gh }).catch(() => null);
    if (now && now.headSha !== info.headSha) d.out(`! the PR head moved to ${now.headSha.slice(0, 7)} during the check — run ship check again for it`);
    try {
      for (const r of await nightlyFailures({ repo, branch: main, gh: d.gh })) {
        d.out(`! nightly ${r.workflowName} on ${main} is red since ${tallinn(r.createdAt)}: ${r.url}`);
      }
    } catch { /* advisory only */ }
    return { state, description, exitCode };
  };

  d.out(`▸ ${repo} PR #${info.number} ${info.headRef} @ ${sha7} (${vs})`);
  await status('pending', `queued · ${vs}`);
  offStatus = onInterrupt(() => status('error', `ship interrupted · ${vs}`));
  const wt = join(d.tmpRoot, 'w', `c-${sha7}-${randomBytes(2).toString('hex')}`);
  let releaseLane = null;
  let offWorktree = () => {};
  try {
    await sweepWorktrees(join(d.tmpRoot, 'w'));
    const logFile = await newLogFile(d.logRoot, repo, sha7);
    await addWorktree(mirror, wt, info.headSha);
    offWorktree = onInterrupt(() => removeWorktree(mirror, wt));
    if (!(await mergeInto(wt, mainSha)).ok) return await finish('failure', `merge conflict with ${main}@${mainSha.slice(0, 7)}`, 1);

    // The gate is defined by main, never by the PR under check. Only a repo whose main has no
    // config yet (the adopting PR) falls back to the PR's own.
    const source = (await showFile(mirror, mainSha, 'ship.config.mjs')) ?? (await showFile(mirror, info.headSha, 'ship.config.mjs'));
    if (!source) return await finish('error', `no ship.config.mjs on ${main} or in the PR`, 1);
    let config;
    try {
      config = await loadConfigSource(source, { root: wt });
    } catch (e) {
      return await finish('error', `config: ${e.message}`, 1);
    }
    if (config.mainBranch !== main) return await finish('error', `config mainBranch ${config.mainBranch} is not ${main}`, 1);

    const files = await changedFiles(mirror, mainSha, info.headSha);
    const plan = classify(files, config);
    if (plan.docsOnly) return await finish('success', `docs-only · ${vs}`, 0);

    const lane = laneFor(plan.groups, config);
    d.out(`▸ groups: ${plan.groups.join(', ')} (${lane} lane)`);
    releaseLane = await lockWithCleanup(join(d.tmpRoot, 'lanes', lane), await ownerInfo({ repo, pr: info.number }), {
      pollMs: d.pollMs,
      onWait: everyMinute((h) => d.out(`… waiting for the ${lane} lane: ${h?.repo ?? '?'} PR #${h?.pr ?? '?'} since ${h?.since ? tallinn(h.since) : '?'}`)),
    });
    await status('pending', `running ${plan.groups.join(',')} · ${vs}`);

    for (const name of plan.groups) {
      const group = config.checks.find((c) => c.name === name);
      const steps = [...(group.install ? [{ run: group.install, env: {} }] : []), ...group.steps];
      for (const step of steps) {
        const env = buildEnv({ ...group.env, ...group.stubEnv, ...step.env, SHIP_CHANGED_FILES: files.join('\n') });
        const r = await run(step.run, { cwd: join(wt, group.cwd), env, logFile, timeoutMs: group.timeoutMin * 60_000 });
        if (r.code !== 0) {
          d.out(`✗ ${name}: ${step.run} (${duration(r.durationMs)})`);
          for (const l of r.tail) d.out(`  ${l}`);
          d.out(`  log: ${logFile}`);
          return await finish('failure', `${name}: ${step.run} failed · ${vs}`, 1);
        }
        d.out(`✓ ${name}: ${step.run} (${duration(r.durationMs)})`);
      }
    }
    const lockfile = files.some((f) => f.endsWith('package-lock.json')) ? ' · lockfile changed' : '';
    return await finish('success', `${plan.groups.join(',')} · ${vs} · ${duration(Date.now() - started)}${lockfile}`, 0);
  } catch (e) {
    return await finish('error', `ship error: ${String(e.message).split('\n')[0]}`, 1);
  } finally {
    offWorktree();
    if (releaseLane) await releaseLane();
    await removeWorktree(mirror, wt);
  }
}

// Worktrees left by a ship that was killed outright (SIGKILL) before it could clean up.
async function sweepWorktrees(dir) {
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir).catch(() => [])) {
    const p = join(dir, name);
    const st = await stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > STALE_WORKTREE_MS) await rm(p, { recursive: true, force: true });
  }
}

async function newLogFile(logRoot, repo, sha7) {
  await mkdir(logRoot, { recursive: true });
  for (const f of await readdir(logRoot).catch(() => [])) {
    const p = join(logRoot, f);
    const st = await stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > LOG_RETENTION_MS) await rm(p, { force: true });
  }
  const stamp = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  return join(logRoot, `${repo.replace('/', '__')}-${sha7}-${stamp}.log`);
}

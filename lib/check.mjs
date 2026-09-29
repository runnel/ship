import { mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { capture, run, buildEnv, stopStrays } from './proc.mjs';
import { ensureMirror, fetchCommit, revParse, addWorktree, removeWorktree, mergeInto, changedFiles, showFile, MIRROR_ROOT } from './git.mjs';
import { parseRepoFromUrl, prInfo, defaultBranch, postStatus, nightlyFailures } from './github.mjs';
import { loadConfigSource } from './config.mjs';
import { classify, laneFor } from './classify.mjs';
import { acquire, ownerInfo } from './lock.mjs';
import { onInterrupt, isInterrupted } from './interrupt.mjs';
import { duration, localTime, scrubPaths } from './report.mjs';
import { SHIP_TMP, SHIP_HOME, ensurePrivateDir } from './paths.mjs';

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

const firstLine = (text) => String(text ?? '').trim().split('\n')[0];
const once = (fn) => { let done = false; return (...a) => { if (!done) { done = true; fn(...a); } }; };
const everyMinute = (fn) => { let last = 0; return (...a) => { if (Date.now() - last >= 60_000) { last = Date.now(); fn(...a); } }; };

// A cleanup that runs once however many ask for it: the flow's own and the interrupt's unwind share
// one promise, so whoever comes second waits for the first instead of exiting, or removing twice,
// while it is still running.
const sharedCleanup = (fn) => {
  let promise = null;
  return () => (promise ??= Promise.resolve().then(fn));
};

const abortedError = () => Object.assign(new Error('interrupted'), { aborted: true });

// A lock with a shared release. Not taken once the process is interrupted, and given back if it was
// won at the last moment.
async function acquireShared(dir, owner, opts) {
  const release = sharedCleanup(await acquire(dir, owner, { ...opts, isAborted: isInterrupted }));
  if (isInterrupted()) {
    await release();
    throw abortedError();
  }
  return release;
}

// A lock that an interrupt releases too. After an interrupt its handler stays registered, so that
// the unwind waits for a release that is still in flight.
async function lockWithCleanup(dir, owner, opts) {
  const release = await acquireShared(dir, owner, opts);
  const off = onInterrupt(release);
  return async () => {
    await release();
    if (!isInterrupted()) off();
  };
}

export async function runCheck({ cwd, pr = null, deps = {} }) {
  const d = { ...defaultDeps(), ...deps };
  await ensurePrivateDir(d.tmpRoot);
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
  const roots = { tmp: d.tmpRoot, mirrors: d.mirrorRoot, logs: d.logRoot, sysTmp: tmpdir(), home: homedir() };
  // Status posts go through one queue, so that the error an interrupt posts always lands after a post
  // that is already in flight.
  let queue = Promise.resolve();
  const post = (state, description) => {
    const posted = queue.then(() => postStatus({ repo, sha: info.headSha, state, description: scrubPaths(description, roots), gh: d.gh }));
    queue = posted.catch(() => {});
    return posted;
  };
  // The flow posts nothing once interrupted: what it would conclude then is an artefact of the
  // interrupt. Only the unwind's error below is posted.
  const status = (state, description) => (isInterrupted() ? Promise.resolve() : post(state, description));
  let concluded = false; // the final status has been posted
  const finish = async (state, description, exitCode) => {
    if (isInterrupted()) return { state: 'error', description: 'interrupted', exitCode: 1 };
    await post(state, description);
    concluded = true;
    d.out(`${exitCode === 0 ? '✓' : '✗'} local-ci ${state}: ${description}`);
    const now = await prInfo({ repo, pr: String(info.number), gh: d.gh }).catch(() => null);
    if (now && now.headSha !== info.headSha) d.out(`! the PR head moved to ${now.headSha.slice(0, 7)} during the check — run ship check again for it`);
    try {
      for (const r of await nightlyFailures({ repo, branch: main, gh: d.gh })) {
        d.out(`! nightly ${r.workflowName} on ${main} is red since ${localTime(r.createdAt)}: ${r.url}`);
      }
    } catch { /* advisory only */ }
    return { state, description, exitCode };
  };

  d.out(`▸ ${repo} PR #${info.number} ${info.headRef} @ ${sha7} (${vs})`);
  const wt = join(d.tmpRoot, 'w', `c-${sha7}-${randomBytes(2).toString('hex')}`);
  const removeTree = sharedCleanup(() => removeWorktree(mirror, wt));
  let releaseLane = null;
  // One handler, registered before anything is posted or created, in the order that matters when
  // interrupted: say so (unless the verdict is already posted), free the lane, remove the worktree
  // (the lane first: a slow removal must not keep the next check waiting). Each step stands on its
  // own: the error POST fails exactly when Ctrl-C is likely (offline, an expired login), and the
  // cleanup after it must still happen.
  const offUnwind = onInterrupt(async () => {
    if (!concluded) await post('error', `ship interrupted · ${vs}`).catch(() => {});
    if (releaseLane) await releaseLane().catch(() => {});
    await removeTree().catch(() => {});
  });
  await status('pending', `queued · ${vs}`);
  try {
    await sweepWorktrees(join(d.tmpRoot, 'w'));
    const logFile = await newLogFile(d.logRoot, repo, sha7);
    if (isInterrupted()) return await finish('error', 'interrupted', 1);
    await addWorktree(mirror, wt, info.headSha);
    const merged = await mergeInto(wt, mainSha);
    if (!merged.ok) {
      if (merged.conflict) return await finish('failure', `merge conflict with ${main}@${mainSha.slice(0, 7)}`, 1);
      return await finish('error', `merge with ${main} failed: ${firstLine(merged.output)}`, 1);
    }

    // The gate is defined by main, never by the PR under check. Only a repo whose main has no
    // config yet (the adopting PR) falls back to the PR's own.
    const onMain = await showFile(mirror, mainSha, 'ship.config.mjs');
    const source = onMain ?? (await showFile(mirror, info.headSha, 'ship.config.mjs'));
    if (!source) return await finish('error', `no ship.config.mjs on ${main} or in the PR`, 1);
    if (onMain === null) d.out(`! ${main} has no ship.config.mjs yet — checking with the one in the PR`);
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
    releaseLane = await acquireShared(join(d.tmpRoot, 'lanes', lane), await ownerInfo({ repo, pr: info.number }), {
      pollMs: d.pollMs,
      onWait: everyMinute((h) => d.out(`… waiting for the ${lane} lane: ${h?.repo ?? '?'} PR #${h?.pr ?? '?'} since ${h?.since ? localTime(h.since) : '?'}`)),
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
    // Not when interrupted: the interrupt has stopped the group, and the helpers of the unwind
    // (gh, git) run in it now.
    const stray = isInterrupted() ? 0 : await stopStrays();
    if (stray > 0) d.out(`! ${stray} background process(es) started by the check were still running — stopped`);
    try {
      if (releaseLane) await releaseLane();
      await removeTree();
      await removeWorktree(mirror, wt); // also catches a worktree created after the unwind's removal ran
    } finally {
      if (!isInterrupted()) offUnwind(); // an interrupt's unwind still has to say "error"
    }
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

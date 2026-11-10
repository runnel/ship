import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { buildEnv, capture, stopStrays, stopActiveCommands } from './proc.mjs';
import { ensureMirror, fetchCommit, revParse, addWorktree, removeWorktree, mergeInto, changedFiles, showFile, listTree, MIRROR_ROOT } from './git.mjs';
import { parseRepoFromUrl, prInfo, defaultBranch, postStatus, nightlyFailures, openPrFiles, cancelRun } from './github.mjs';
import { matchesAny } from './glob.mjs';
import { prefixClashes } from './migrations.mjs';
import { loadConfigSource } from './config.mjs';
import { classify, laneFor } from './classify.mjs';
import { importsOutside } from './imports.mjs';
import { ownerInfo } from './lock.mjs';
import { whyDoomed, watchDoomed } from './doomed.mjs';
import { onBatteryPower } from './power.mjs';
import { onInterrupt, isInterrupted } from './interrupt.mjs';
import { duration, localTime, scrubPaths } from './report.mjs';
import { SHIP_TMP, SHIP_HOME, ensurePrivateDir } from './paths.mjs';
import { once, sharedCleanup, checkKey, acquireShared, lockWithCleanup, sweepWorktrees, newLogFile, firstLine, repoKeyOf, runGroups, LANE_PRIORITY, laneWaitReporter } from './shared.mjs';
import { overflowGate, firstGate, runOnGitHub } from './overflow.mjs';
import { cloudflareGate, runOnCloudflare } from './overflow-cloudflare.mjs';

export function checkDeps() {
  return {
    gh: 'gh',
    remoteUrl: (repo) => `https://github.com/${repo}.git`,
    mirrorRoot: MIRROR_ROOT,
    tmpRoot: SHIP_TMP,
    logRoot: join(SHIP_HOME, 'logs'),
    overflowRoot: join(SHIP_HOME, 'overflow'), // what runs on GitHub have been started
    out: (line) => process.stdout.write(`${line}\n`),
    pollMs: 5000,
    unwindPostTimeoutMs: 10_000, // the error status an interrupt posts: it must not hold the cleanup up
    treeConfigTimeoutMs: 30_000, // evaluating the pull request's own config
    headWaitMs: 60_000, // how long to wait for GitHub to show the head that was pushed
    headPollMs: 2000,
    doomedPollMs: 60_000, // how often a waiting or running check asks whether its result can still be used
    doomedFreshMs: 10_000, // a look this recent is good enough when the lane is won
    doomedConfirmMs: 3000, // a head that is not the checked one is asked about again after this long
    onBattery: onBatteryPower,
    overflowAskMs: 60_000, // how often a waiter looks whether it can go to GitHub
    githubPollMs: 20_000,
    githubQueueMs: 5 * 60_000, // a run that has not started by then is given up
    githubBlindMs: 5 * 60_000, // so is one GitHub has said nothing about for this long
    cloudflarePollMs: 20_000, // how often the check runs of a pushed commit are looked at
    cloudflareQueueMs: 5 * 60_000, // a build with no check run by then is given up
    cloudflareBlindMs: 5 * 60_000, // GitHub saying nothing about them for this long ends the wait
    progressPostTimeoutMs: 20_000, // a status that only says how far a check is must not hold it up
    verdictRetryMs: 5000, // before the second try at posting a verdict
    shipSha: async () => (await capture('git', ['-C', fileURLToPath(new URL('..', import.meta.url)), 'rev-parse', 'HEAD'])).trim(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

// The docsOnly globs and deployables that the merged tree's own ship.config.mjs declares, or null
// when it cannot be loaded. The file is the pull request's, so it is evaluated in a child with the
// minimal environment the check steps get, never in ship's own process.
const TREE_CONFIG = `
import { readFile } from 'node:fs/promises';
const { loadConfigSource } = await import(process.argv[1]);
const config = await loadConfigSource(await readFile(process.argv[2], 'utf8'), { root: process.argv[3] });
process.stdout.write('\\n' + JSON.stringify({ docsOnly: config.docsOnly, deployables: config.deployables }) + '\\n');
`;
async function treeConfig(wt, timeoutMs) {
  try {
    const args = ['--input-type=module', '-e', TREE_CONFIG, new URL('./config.mjs', import.meta.url).href, join(wt, 'ship.config.mjs'), wt];
    // SIGKILL: a config that traps SIGTERM (or is stuck in a loop) must not outlive the timeout.
    const out = await capture(process.execPath, args, { env: buildEnv(), cwd: wt, timeout: timeoutMs, killSignal: 'SIGKILL' });
    return JSON.parse(out.trim().split('\n').at(-1));
  } catch {
    return null;
  }
}

export async function runCheck({ cwd, pr = null, github = false, cloudflare = false, deps = {} }) {
  const d = { ...checkDeps(), ...deps };
  await ensurePrivateDir(d.tmpRoot);
  const repo = parseRepoFromUrl(await capture('git', ['-C', cwd, 'remote', 'get-url', 'origin']));
  let ref = pr;
  if (!ref) {
    ref = (await capture('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (ref === 'HEAD') { d.out('✗ detached HEAD — run: ship check --pr <number>'); return 2; }
  }
  let info = await prInfo({ repo, pr: ref, gh: d.gh });
  if (info.fork) { d.out(`✗ PR #${info.number} comes from a fork — ship never runs another account's code`); return 2; }
  if (info.state !== 'OPEN') { d.out(`✗ PR #${info.number} is ${String(info.state).toLowerCase()}`); return 2; }
  const main = await defaultBranch({ repo, gh: d.gh });
  if (info.base !== main) { d.out(`✗ PR #${info.number} targets ${info.base}; only PRs into ${main} are gated`); return 2; }

  const repoKey = repoKeyOf(repo);
  const releaseMirror = await lockWithCleanup(join(d.tmpRoot, 'locks', `mirror-${repoKey}`), await ownerInfo({ repo }), { pollMs: d.pollMs });
  let mirror, mainSha;
  try {
    mirror = await ensureMirror(repo, { root: d.mirrorRoot, url: d.remoteUrl(repo) });
    await fetchCommit(mirror, info.headSha, info.number);
    mainSha = await revParse(mirror, `refs/heads/${main}`);
  } finally {
    await releaseMirror();
  }

  // `gh pr view` can still answer with the previous head for a while after a push; the branch ref
  // fetched into the mirror a moment ago cannot. Check the commit that was pushed.
  const settled = await settleHead({ d, repo, ref, info, mirror });
  if (settled.lagging) {
    d.out(`✗ local-ci not run: GitHub still shows ${info.headSha.slice(0, 7)} as the head of #${info.number}, the branch is at ${settled.tip.slice(0, 7)}; run ship check again in a minute`);
    return 1;
  }
  info = settled.info;

  const key = checkKey(repo, info.headSha);
  const checksDir = join(d.tmpRoot, 'checks');
  await mkdir(checksDir, { recursive: true });
  const waitStarted = Date.now();
  const releaseSha = await lockWithCleanup(join(checksDir, key), await ownerInfo({ repo, pr: info.number }), {
    pollMs: d.pollMs,
    onWait: once(() => d.out(`… a check of ${info.headSha.slice(0, 7)} is already running — waiting for its result`)),
  });
  try {
    const cached = await readResult(d, repo, info.headSha);
    // Reuse only a result that finished while this call waited (two sessions asked for the same
    // commit at once). An older result is re-run: a red check may have been flaky, and "check
    // again" must mean check again.
    if (cached && cached.mainSha === mainSha && cached.at >= waitStarted) {
      d.out(`${cached.exitCode === 0 ? '✓' : '✗'} local-ci ${cached.state}: ${cached.description} (from the run that just finished)`);
      return cached.exitCode;
    }
    const result = await checkOnce({ d, repo, info, main, mainSha, mirror, github, cloudflare });
    await writeResult(d, repo, info.headSha, result, mainSha);
    return result.exitCode;
  } finally {
    await releaseSha();
  }
}

// The pull request as GitHub shows it once its head is the branch tip the mirror has. A branch
// ref the mirror lacks (a deleted branch) leaves the answer as it is.
export async function settleHead({ d, repo, ref, info, mirror }) {
  const tip = await revParse(mirror, `refs/heads/${info.headRef}`).catch(() => null);
  if (!tip || tip === info.headSha) return { info };
  d.out(`… GitHub still shows ${info.headSha.slice(0, 7)} as the head of #${info.number}; the branch is at ${tip.slice(0, 7)} — waiting for GitHub`);
  const started = Date.now();
  for (;;) {
    await d.sleep(d.headPollMs);
    const now = await prInfo({ repo, pr: ref, gh: d.gh, timeoutMs: d.ghTimeoutMs ?? 0 });
    if (now.headSha === tip) return { info: now };
    if (Date.now() - started >= d.headWaitMs) return { lagging: true, tip };
  }
}

// The result of the latest check of a head, kept for whoever asks about that head next: a duplicate
// that waited for it (runCheck), or ship land (its reuse rule).
const resultPath = (d, repo, headSha) => join(d.tmpRoot, 'checks', `${checkKey(repo, headSha)}.json`);

export const readResult = (d, repo, headSha) => readFile(resultPath(d, repo, headSha), 'utf8').then(JSON.parse, () => null);

// An interrupted or stopped run has no result anyone could reuse.
export async function writeResult(d, repo, headSha, result, mainSha) {
  if (isInterrupted() || result.state === 'stopped') return;
  const file = resultPath(d, repo, headSha);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...result, mainSha, at: Date.now() }));
}

// Each pull request is checked against a main without the others, so two that add one migration
// number both pass. Warns about the open pull requests that add a file with a prefix this one adds;
// the verdict stays as it is (which of the two renumbers is decided at merge). Returns the clashes.
async function migrationClashes({ d, repo, info, config, mirror, mainSha, changed }) {
  if (!config.migrations) return [];
  const onMain = new Set((await listTree(mirror, mainSha)).filter((f) => matchesAny(f, config.migrations.paths)));
  const added = (files) => files.filter((f) => matchesAny(f, config.migrations.paths) && !onMain.has(f));
  const ours = added(changed);
  if (ours.length === 0) return [];
  let open;
  try {
    open = await openPrFiles({ repo, gh: d.gh, timeoutMs: d.ghTimeoutMs ?? 0 });
  } catch (e) {
    d.out(`! could not compare migration prefixes with open PRs (${firstLine(e.stderr) || firstLine(e.message)})`);
    return [];
  }
  const others = open.filter((p) => p.number !== info.number).map((p) => ({ number: p.number, files: added(p.files) }));
  const clashes = prefixClashes({ ours, others });
  for (const c of clashes) d.out(`! migration prefix ${c.prefix} is also added by open PR #${c.number} (${c.file}) — whichever merges second must renumber`);
  return clashes;
}

// One check of the pull request head merged with `mainSha`, posting local-ci as it goes. `land`: the
// check ship land runs. It goes ahead of the optional checks in the heavy lane, never runs on a
// remote (in a serial line the machine is faster), and only its pull request can stop it: main
// moving is the land's to judge before it merges.
export async function checkOnce({ d, repo, info, main, mainSha, mirror, github = false, cloudflare = false, land = false }) {
  const sha7 = info.headSha.slice(0, 7);
  const vs = `vs ${main}@${mainSha.slice(0, 7)}`;
  const started = Date.now();
  const roots = { tmp: d.tmpRoot, mirrors: d.mirrorRoot, logs: d.logRoot, sysTmp: tmpdir(), home: homedir() };
  // Status posts go through one queue, so that the error an interrupt posts is sent after a post
  // that is already in flight, not before it. The unwind stops a post that does not finish in
  // time (every post is awaited before the next is made, so nothing is ever queued behind it).
  let queue = Promise.resolve();
  const inFlight = new Set(); // AbortControllers of the posts running now
  let run = null; // the run on a remote this check is waiting for: statuses link to it, an interrupt cancels a GitHub one
  const postNow = (state, description, timeoutMs = d.ghTimeoutMs ?? 0) => {
    const controller = new AbortController();
    inFlight.add(controller);
    return postStatus({ repo, sha: info.headSha, state, description: scrubPaths(description, roots), targetUrl: run?.url ?? null, gh: d.gh, timeoutMs, signal: controller.signal })
      .finally(() => inFlight.delete(controller));
  };
  const post = (state, description, timeoutMs = d.ghTimeoutMs ?? 0) => {
    const posted = queue.then(() => postNow(state, description, timeoutMs));
    queue = posted.catch(() => {});
    return posted;
  };
  // The flow posts nothing once interrupted: what it would conclude then is an artefact of the
  // interrupt. Only the unwind's error below is posted.
  const status = (state, description) => (isInterrupted() ? Promise.resolve() : post(state, description));
  // A pending status only says how far the check is. If GitHub does not take it the check goes on, and
  // the earlier one stays on the commit.
  const progress = (description) => (isInterrupted() ? Promise.resolve() : post('pending', description, d.progressPostTimeoutMs)).catch(() => {});
  let concluded = false; // the final status has been posted
  const finish = async (state, description, exitCode) => {
    if (isInterrupted()) return { state: 'error', description: 'interrupted', exitCode: 1 };
    // A verdict gets a second try: one failed post must not lose it. If GitHub takes neither, nothing
    // says it is an error of the check: the status stays pending, and ship merge refuses that.
    try {
      await post(state, description).catch(async () => {
        await d.sleep(d.verdictRetryMs);
        if (!isInterrupted()) await post(state, description);
      });
    } catch (e) {
      d.out(`✗ local-ci ${state}: ${description}, but GitHub did not take the status (${firstLine(e.stderr) || firstLine(e.message)}); run ship check again`);
      return { state: 'error', description: 'the verdict could not be posted', exitCode: 1 };
    }
    if (isInterrupted()) return { state: 'error', description: 'interrupted', exitCode: 1 };
    concluded = true;
    d.out(`${exitCode === 0 ? '✓' : '✗'} local-ci ${state}: ${description}`);
    const now = await prInfo({ repo, pr: String(info.number), gh: d.gh, timeoutMs: d.ghTimeoutMs ?? 0 }).catch(() => null);
    if (now && now.headSha !== info.headSha) d.out(`! the PR head moved to ${now.headSha.slice(0, 7)} during the check — run ship check again for it`);
    try {
      for (const r of await nightlyFailures({ repo, branch: main, gh: d.gh, timeoutMs: d.ghTimeoutMs ?? 0 })) {
        d.out(`! nightly ${r.workflowName} on ${main} is red since ${localTime(r.createdAt)}: ${r.url}`);
      }
    } catch { /* advisory only */ }
    return { state, description, exitCode };
  };
  // A check whose result can no longer be used ends without a verdict: whatever status it posted
  // earlier (queued, running) stays on a head, or against a main, that nobody will merge on this
  // result. Returning is all it takes to give the lane back, as for any other end of the flow.
  const stopped = (reason) => {
    concluded = true;
    d.out(`✗ stopped checking PR #${info.number} @ ${sha7}: ${reason} (no verdict posted)`);
    return { state: 'stopped', description: reason, exitCode: 2 };
  };

  d.out(`▸ ${repo} PR #${info.number} ${info.headRef} @ ${sha7} (${vs})`);
  const wt = join(d.tmpRoot, 'w', `c-${sha7}-${randomBytes(2).toString('hex')}`);
  const removeTree = sharedCleanup(() => removeWorktree(mirror, wt));
  let releaseLane = null;
  let watch = null; // asks whether this check still has a result worth having, from the lane wait on
  let gate = null;
  // One handler, registered before anything is posted or created, in the order that matters when
  // interrupted: say so (unless the verdict is already posted), free the lane, remove the worktree
  // (the lane first: a slow removal must not keep the next check waiting). Each step stands on its
  // own: the error POST fails exactly when Ctrl-C is likely (offline, an expired login), and the
  // cleanup after it must still happen.
  const offUnwind = onInterrupt(async () => {
    if (!concluded) {
      // One budget for both waits: a post ahead of the error may hang (a captive portal, a
      // half-open connection); it is stopped when the budget runs out, and the error POST gets
      // what is left, but never less than a short floor.
      const budget = d.unwindPostTimeoutMs;
      const until = Date.now() + budget;
      const drained = await Promise.race([queue.then(() => true), new Promise((resolve) => setTimeout(resolve, budget, false).unref())]);
      if (!drained) for (const controller of inFlight) controller.abort();
      const floor = Math.max(1000, Math.min(2000, budget / 4));
      await postNow('error', `ship interrupted · ${vs}`, Math.max(floor, until - Date.now())).catch(() => {});
    }
    // A Cloudflare build has no id here: without a Cloudflare credential it cannot be cancelled, and runs on.
    if (run?.runId) await cancelRun({ repo, runId: run.runId, gh: d.gh, timeoutMs: d.unwindPostTimeoutMs }).catch(() => {});
    if (gate) await gate.release().catch(() => {});
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
      if (merged.conflict) return { ...(await finish('failure', `merge conflict with ${main}@${mainSha.slice(0, 7)}`, 1)), conflict: true };
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

    const clashes = await migrationClashes({ d, repo, info, config, mirror, mainSha, changed: files });

    // A deployable that imports a file outside its `paths` would ship code that a deploy plan
    // does not see change; fail at the gate rather than at the next deploy. The plan of the next
    // deploy uses the config as it is after this merge, so an import that main's paths leave out
    // but the pull request's own config covers is not held against the pull request (which is what
    // lets one that widens `paths` pass when main is already in violation). If that config cannot
    // be loaded, main's verdict stands.
    let mergedConfig; // undefined until it is needed, then the config or null
    for (const dep of config.deployables) {
      let outside = await importsOutside(wt, dep, config.docsOnly);
      if (outside.length > 0 && onMain !== null) {
        if (mergedConfig === undefined) mergedConfig = await treeConfig(wt, d.treeConfigTimeoutMs);
        const own = mergedConfig?.deployables.find((x) => x.name === dep.name);
        if (mergedConfig) {
          const key = (o) => `${o.from}\0${o.to}`;
          const still = new Set(own ? (await importsOutside(wt, own, mergedConfig.docsOnly)).map(key) : []);
          outside = outside.filter((o) => still.has(key(o)));
        }
      }
      const [first, ...more] = outside;
      if (first) return await finish('failure', `deployable ${dep.name} imports ${first.to} (from ${first.from}${more.length ? ` +${more.length}` : ''}), outside its paths · ${vs}`, 1);
    }

    const lane = laneFor(plan.groups, config);
    d.out(`▸ groups: ${plan.groups.join(', ')} (${lane} lane)`);
    if (lane === 'heavy' && await d.onBattery()) d.out('! on battery power: heavy checks time out more often on battery — plug in (the check goes on)');

    const lockfile = files.some((f) => f.endsWith('package-lock.json')) ? ' · lockfile changed' : '';
    const verdictEnd = `${lockfile}${clashes.length ? ` · migration ${clashes[0].prefix} also in #${clashes[0].number}` : ''}`;

    // From here the check waits for a lane and then runs, which can take a quarter of an hour:
    // long enough for the pull request to be merged, closed or pushed to, or for main to gain a
    // file that makes `ship merge` refuse the result. Look before queueing, while queued (a doomed
    // wait ends and gives its place back), when the lane is won, and while the steps run (they are
    // stopped) or the run on GitHub goes on (it is cancelled). A look that cannot be made says nothing.
    watch = watchDoomed({
      intervalMs: d.doomedPollMs,
      probe: () => whyDoomed({ d, repo, pr: info.number, headSha: info.headSha, main, mainSha, recheck: land ? [] : config.recheckOnMainChange, again: land ? 'ship land' : 'ship check', timeoutMs: d.ghTimeoutMs ?? 0 }),
      onDoomed: () => stopActiveCommands(),
    });
    const doomedBefore = await watch.now();
    if (doomedBefore) return stopped(doomedBefore);

    // main's own config only: a pull request cannot send itself anywhere. A check goes to one remote at
    // most, once: Cloudflare first when it is configured, then GitHub, each on its own rules. It keeps
    // its place in line for coming back.
    const mayGo = !land && onMain !== null && lane === 'heavy' && config.overflow;
    const takes = (o) => mayGo && o && (!o.groups || plan.groups.every((g) => o.groups.includes(g)));
    const overflow = takes(config.overflow) ? config.overflow : null;
    const onCloudflare = takes(config.overflow?.cloudflare) ? config.overflow.cloudflare : null;
    if (github && !overflow) d.out('! --github: this check cannot run on GitHub (it needs a heavy group, and an overflow config on main that takes its groups) — it stays on this machine');
    if (cloudflare && !onCloudflare) d.out('! --cloudflare: this check cannot run on Cloudflare (it needs a heavy group, and an overflow.cloudflare config on main that takes its groups) — it stays on this machine');
    const laneOwner = { repo, pr: info.number, sha: sha7, log: logFile };
    const remotes = [];
    if (onCloudflare) {
      remotes.push({
        name: 'Cloudflare',
        gate: cloudflareGate({ d, owner: laneOwner, cloudflare: onCloudflare }),
        go: (common) => runOnCloudflare({ ...common, mirror, files, config: onMain, cloudflare: onCloudflare, label: `${repo} PR #${info.number} @ ${sha7} (${vs})` }),
      });
    }
    if (overflow) {
      remotes.push({
        name: 'GitHub',
        gate: overflowGate({ d, owner: laneOwner, overflow }),
        go: (common) => runOnGitHub({ ...common, repo, main, headSha: info.headSha, overflow }),
      });
    }
    gate = remotes.length > 0 ? firstGate(remotes) : null;
    const arrivedAt = Date.now();
    const onRemote = async () => {
      const remote = gate.chosen;
      const r = await remote.go({
        d, mainSha, tree: wt, groups: plan.groups, place: remote.gate.place,
        isStopped: () => watch.reason() !== null,
        onStarted: (begun) => { run = begun; return progress(`running ${plan.groups.join(',')} on ${remote.name} · ${vs}`); },
      });
      if (r.ok) {
        if (r.url) run = { ...run, url: r.url }; // the verdict links to the page of the run that gave it
        return await finish('success', `${plan.groups.join(',')} · ${vs} · ${duration(Date.now() - started)} · on ${remote.name}${verdictEnd}`, 0);
      }
      run = null;
      await gate.release();
      gate = null;
      if (r.stopped) return stopped(watch.reason());
      if (isInterrupted()) return await finish('error', 'interrupted', 1);
      d.out(`! ${r.why}${r.url ? `: ${r.url}` : ''} — back in line on this machine, which gives the verdict`);
      await progress(`back from ${remote.name}, in line · ${vs}`);
      return null;
    };
    const asked = github ? 'GitHub' : cloudflare ? 'Cloudflare' : null; // --github, --cloudflare: go without looking at the line
    if (asked && gate && await gate.claim(asked)) {
      const verdict = await onRemote();
      if (verdict) return verdict;
    }
    for (;;) {
      releaseLane = await acquireShared(join(d.tmpRoot, 'lanes', lane), await ownerInfo(laneOwner), {
        pollMs: d.pollMs,
        priority: land ? LANE_PRIORITY.land : LANE_PRIORITY.check,
        onWait: laneWaitReporter(d, lane),
        isAborted: () => watch.reason() !== null,
        arrivedAt,
        leaveWhen: gate ? gate.ask : null,
      });
      if (releaseLane) break;
      const verdict = await onRemote();
      if (verdict) return verdict;
    }
    const doomedAtLane = await watch.now(d.doomedFreshMs);
    if (doomedAtLane) return stopped(doomedAtLane);
    await progress(`running ${plan.groups.join(',')} · ${vs}`);

    const r = await runGroups({ config, groups: plan.groups, root: wt, files, logFile, out: d.out, isStopped: () => watch.reason() !== null });
    if (r.stopped) return stopped(watch.reason());
    if (!r.ok) return await finish('failure', `${r.name}: ${r.step.run} failed · ${vs}`, 1);
    return await finish('success', `${plan.groups.join(',')} · ${vs} · ${duration(Date.now() - started)}${verdictEnd}`, 0);
  } catch (e) {
    if (watch?.reason() && !isInterrupted()) return stopped(watch.reason()); // the wait for the lane ended because of it
    return await finish('error', `ship error: ${String(e.message).split('\n')[0]}`, 1);
  } finally {
    watch?.stop();
    // Not when interrupted: the interrupt has stopped the group, and the helpers of the unwind
    // (gh, git) run in it now.
    const stray = isInterrupted() ? 0 : await stopStrays();
    if (stray > 0) d.out(`! ${stray} background process(es) started by the check were still running — stopped`);
    try {
      if (gate) await gate.release();
      if (releaseLane) await releaseLane();
      await removeTree();
      await removeWorktree(mirror, wt); // also catches a worktree created after the unwind's removal ran
    } finally {
      if (!isInterrupted()) offUnwind(); // an interrupt's unwind still has to say "error"
    }
  }
}

import { access, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { run, buildEnv } from '../proc.mjs';
import { firstLine, runSteps, withLane } from '../shared.mjs';
import { newestVersion, resolveLive } from '../live.mjs';
import { CONFIG_KEYS, WRANGLER_FILES, changedSettings, expectedState, workerName } from '../wrangler-config.mjs';
import { CloudflareError } from '../cloudflare.mjs';
import { describeProbes, probeAll, probeOptions, waitForText, warm } from '../probe.mjs';
import { clearHold, readHold, writeHold } from '../state.mjs';
import { isInterrupted, onInterrupt } from '../interrupt.mjs';
import { duration, localTime } from '../report.mjs';

const exists = (p) => access(p).then(() => true, () => false);
export const shq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

// `sha:<40 hex>` first: the deployment copy of a `wrangler deploy` message keeps 50 characters,
// and Cloudflare cuts every message at 1,000. The nonce finds our version after a hung upload.
export function deployMessage({ sha, name, nonce, note = '' }) {
  return `sha:${sha} ${name} run:${nonce}${note ? ` ${note}` : ''}`.slice(0, 200);
}

export async function wranglerConfigPath(wt, dep) {
  if (dep.wranglerConfig) return join(dep.cwd, dep.wranglerConfig);
  for (const f of WRANGLER_FILES) if (await exists(join(wt, dep.cwd, f))) return join(dep.cwd, f);
  throw new Error(`${dep.name}: no ${WRANGLER_FILES.join(' / ')} in ${dep.cwd}`);
}

const records = async (file) => (await readFile(file, 'utf8').catch(() => ''))
  .split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return {}; } });
const describeLive = (l) => (l.state === 'known' ? `${l.sha.slice(0, 7)} (${l.versionId.slice(0, 8)})` : l.state);
const sameLive = (a, b) => a.state === b.state && a.sha === b.sha && a.versionId === b.versionId;
const sameCrons = (a, b) => [...a].sort().join('|') === [...b].sort().join('|');
const currentVersion = async (cf, worker) => (await cf.deployments(worker))[0]?.versions?.[0]?.version_id ?? null;

// State keys: the target config's effective values against what the Worker has now. A versioned
// deploy cannot change them, so a real difference needs the owner once (wrangler triggers deploy).
async function stateMismatch(cf, dep, want) {
  let sub;
  let crons;
  try {
    [sub, crons] = await Promise.all([cf.subdomain(dep.worker), cf.schedules(dep.worker)]);
  } catch (e) {
    if (e instanceof CloudflareError && e.codes.includes(10007)) return `${dep.worker} does not exist yet; a versioned deployable's first deploy is the owner's`;
    return `could not read the state of ${dep.worker} (${e.message})`;
  }
  const diff = [];
  if (want.workersDev !== sub.enabled) diff.push(`workers_dev (config ${want.workersDev}, Worker ${sub.enabled})`);
  if (want.previewUrls !== sub.previews_enabled) diff.push(`preview_urls (config ${want.previewUrls}, Worker ${sub.previews_enabled})`);
  if (want.crons && !sameCrons(want.crons, crons)) diff.push(`triggers.crons (config ${want.crons.join(', ') || 'none'}, Worker ${crons.join(', ') || 'none'})`);
  if (diff.length > 0) return `${diff.join('; ')}: a versioned deploy does not apply these — the owner applies them once with \`wrangler triggers deploy\` in ${dep.cwd}, then ship deploy again`;
  if (!sub.previews_enabled) return `preview URLs are off for ${dep.worker}; a versioned deploy needs them`;
  return null;
}

// The wrangler config against the live commit's, before anything is built. The parsers do not say
// which file they were reading, so a config that cannot be read or parsed is named here. wrangler
// deploys to the name in the config, so a name other than the deployable's Worker is refused: every
// check ship makes is against the Worker it was told about.
async function inspectConfig({ wt, dep, cfgPath, liveSha, readAt }) {
  try {
    const targetConfig = await readFile(join(wt, cfgPath), 'utf8');
    const liveConfig = liveSha ? await readAt(liveSha, cfgPath) : null;
    const changed = liveSha ? changedSettings(liveConfig, targetConfig, cfgPath) : []; // for the rollback notes
    const inspected = { changed };
    if (dep.mode === 'versioned') {
      inspected.configChanged = liveSha ? changedSettings(liveConfig, targetConfig, cfgPath, CONFIG_KEYS) : [];
      inspected.want = expectedState(targetConfig, cfgPath);
    }
    const name = workerName(targetConfig, cfgPath);
    if (name === null) return { error: `${cfgPath}: no top-level "name"; wrangler would deploy to a name of its own, not to ${dep.worker}` };
    if (name !== dep.worker) return { error: `${cfgPath}: name "${name}" is not this deployable's worker "${dep.worker}"; wrangler deploys to the name in the config` };
    return inspected;
  } catch (e) {
    return { error: `${cfgPath}: ${firstLine(e.message)}` };
  }
}

// After a hung or failed upload the version may still appear: poll for our exact message.
async function findByMessage(cf, worker, message, d) {
  const started = Date.now();
  for (;;) {
    const hit = (await cf.versions(worker)).find((v) => v.annotations?.['workers/message'] === message);
    if (hit || Date.now() - started >= d.probeWindowMs) return hit ?? null;
    await d.sleep(d.probeIntervalMs);
  }
}

// After the promote nothing may escape as an exception, and that includes a hold that cannot be
// written: the result then says so, because nothing else stops the next deploy.
async function hold({ d, r, dep }, fields) {
  try {
    await writeHold(d.stateRoot, r.repo, dep.name, fields);
    return { reason: fields.reason, ok: true };
  } catch (e) {
    return { reason: fields.reason, ok: false, error: firstLine(e.message) };
  }
}
const holdText = (h, dep, ifSet) => (h.ok ? ifSet
  : `WARNING: the hold could not be written (${h.error}), so nothing blocks another deploy of ${dep.name} — look at ${dep.worker} before running one`);
const stuck = (h, dep, ifSet) => ({ outcome: 'stuck', detail: `${h.reason} — ${holdText(h, dep, ifSet)}` });

export async function deployOne(ctx) {
  const { d, r, wt, dep, entry, cf, creds, target, nonce, note = '', logFile, dryRun = false, readAt } = ctx;
  const out = d.out;
  const cwd = join(wt, dep.cwd);
  const failed = (detail) => ({ outcome: 'failed', detail });
  const showTail = (res) => {
    for (const l of res.tail) out(`  ${l}`);
    out(`  log: ${logFile}`);
  };
  let cfgPath;
  try {
    cfgPath = await wranglerConfigPath(wt, dep);
  } catch (e) {
    return failed(e.message);
  }
  const liveSha = entry.live.state === 'known' ? entry.live.sha : null;
  const inspected = await inspectConfig({ wt, dep, cfgPath, liveSha, readAt });
  if (inspected.error) return failed(inspected.error);
  const { changed } = inspected;

  if (dep.mode === 'versioned') {
    if (inspected.configChanged.length > 0) {
      return failed(`${inspected.configChanged.join(', ')} changed in ${cfgPath} since ${liveSha.slice(0, 7)}; a versioned deploy does not apply that — the owner deploys this change once: \`wrangler deploy --message "sha:${target} ${dep.name} owner"\` from a clean checkout of main after its install and build, then ship deploy again`);
    }
    const mismatch = await stateMismatch(cf, dep, inspected.want);
    if (mismatch) return failed(mismatch);
  }

  // The env files exist only between install and build, and are removed whatever happens.
  const copied = dep.envFiles.map((f) => join(wt, f.to));
  try {
    if (dep.install || dep.build) {
      const stepOf = (cmd) => runSteps({ label: dep.name, steps: [{ run: cmd, env: {}, cwd: null }], cwd, env: dep.env, logFile, timeoutMin: dep.timeoutMin, out });
      const built = await withLane({
        d, lane: 'heavy', owner: { repo: r.repo, command: `deploy ${dep.name}` },
        fn: async () => {
          if (dep.install) {
            const installed = await stepOf(dep.install);
            if (!installed.ok) return installed;
          }
          for (const [i, f] of dep.envFiles.entries()) {
            await mkdir(dirname(copied[i]), { recursive: true });
            await copyFile(f.from, copied[i]);
          }
          return dep.build ? stepOf(dep.build) : { ok: true };
        },
      });
      if (!built.ok) return failed(`build failed: ${built.step.run}`);
    }
  } finally {
    for (const f of copied) await rm(f, { force: true });
  }

  if (dep.bundleCheck) {
    const { file, pattern, allow } = dep.bundleCheck;
    const text = await readFile(join(cwd, file), 'utf8').catch(() => null);
    if (text === null) return failed(`bundle check: ${file} is missing`);
    const found = [...new Set([...text.matchAll(new RegExp(pattern, 'g'))].map((m) => m[0]))];
    if (found.length === 0) return failed(`bundle check: nothing in ${file} matches ${pattern}`);
    const bad = found.filter((m) => !allow.some((a) => m.includes(a)));
    if (bad.length > 0) return failed(`bundle check: ${bad.slice(0, 3).join(', ')} in ${file} is not allowed`);
    out(`✓ ${dep.name}: bundle check`);
  }
  // The build id the live host must serve, read now: after the promote nothing may fail on it.
  let marker = null;
  if (dep.liveMarker) {
    const file = join(dep.cwd, dep.liveMarker.file);
    marker = (await readFile(join(wt, file), 'utf8').catch(() => null))?.trim() ?? null;
    if (marker === null) return failed(`live marker: ${file} is missing after the build`);
    if (marker === '') return failed(`live marker: ${file} is empty`);
  }
  const wrangler = join(wt, dep.wrangler);
  if (!(await exists(wrangler))) return failed(`wrangler missing at ${dep.wrangler} (deploySetup installs it)`);
  if (dep.preDeploy.length > 0) {
    const pre = await runSteps({ label: `${dep.name} preDeploy`, steps: dep.preDeploy, cwd, env: dep.env, logFile, timeoutMin: dep.timeoutMin, out });
    if (!pre.ok) return failed(`preDeploy failed: ${pre.step.run}`);
  }
  if (dryRun) return { outcome: 'dry-run', detail: `would deploy ${liveSha ? liveSha.slice(0, 7) : '(new)'} → ${target.slice(0, 7)} (${dep.mode})` };

  const message = deployMessage({ sha: target, name: dep.name, nonce, note });
  const outFile = join(wt, `.ship-wrangler-${dep.name}-${randomBytes(3).toString('hex')}.ndjson`);
  const env = buildEnv({ ...creds, WRANGLER_SEND_METRICS: 'false', WRANGLER_OUTPUT_FILE_PATH: outFile });
  const configArg = dep.wranglerConfig ? ` --config ${shq(dep.wranglerConfig)}` : '';
  const reread = async () => {
    const [deployments, versions] = await Promise.all([cf.deployments(dep.worker), cf.versions(dep.worker)]);
    return { now: resolveLive({ deployments, versions }), versions };
  };

  let versionId = null;
  if (dep.mode === 'versioned') {
    const up = await run(`${shq(wrangler)} versions upload${configArg} --message ${shq(message)}`, { cwd, env, logFile, timeoutMs: dep.uploadTimeoutMin * 60_000 });
    const rec = (await records(outFile)).find((x) => x.type === 'version-upload');
    versionId = rec?.version_id ?? null;
    let previewUrl = rec?.preview_url ?? null;
    if (!versionId) {
      const how = up.code === 124 ? 'timed out' : `exited ${up.code}`;
      const mine = await findByMessage(cf, dep.worker, message, d);
      if (!mine) {
        showTail(up);
        return failed(`upload ${how} and no version carries our message; live untouched — ship deploy again`);
      }
      versionId = mine.id;
      out(`! ${dep.name}: upload ${how}, but version ${versionId.slice(0, 8)} with our message exists — using it`);
    }
    previewUrl ??= `https://${versionId.slice(0, 8)}-${dep.worker}.${await cf.accountSubdomain()}.workers.dev`;
    out(`✓ ${dep.name}: uploaded ${versionId.slice(0, 8)} (${duration(up.durationMs)})`);
    await warm(previewUrl, dep.warmup, { fetchImpl: d.fetch });
    const pre = await probeAll(previewUrl, dep.probes, probeOptions(d));
    if (!pre.ok) {
      return failed(`preview probes failed (${describeProbes(pre.results)}); live untouched. Version ${versionId.slice(0, 8)} stays undeployed, and \`wrangler secret put\` on ${dep.worker} fails until the next successful deploy`);
    }
    out(`✓ ${dep.name}: preview probes (${dep.probes.length})`);
    const { now, versions } = await reread();
    if (!sameLive(now, entry.live)) return failed(`live changed during the deploy (${describeLive(entry.live)} → ${describeLive(now)}); not promoting — ship deploy again`);
    const newest = newestVersion(versions);
    if (newest?.id !== versionId) {
      return failed(`version ${newest?.id.slice(0, 8)} (${newest?.annotations?.['workers/triggered_by']}) was made after ours; not promoting — ship deploy again`);
    }
  } else {
    const { now } = await reread();
    if (!sameLive(now, entry.live)) return failed(`live changed during the deploy (${describeLive(entry.live)} → ${describeLive(now)}); not deploying — ship deploy again`);
  }

  // From the promote on, our code may be live: an interrupt leaves a hold (the unwind runs the
  // handlers registered before it started, so the handler goes in before the last check), and so
  // does any error after this point. A process that is killed outright can do neither, so a hold
  // is written before anything is promoted: it stays if ship dies before the live probes have
  // passed, and every other ending replaces it (with what happened) or removes it.
  let promoting = false;
  let marked = null; // the hold written before the promote
  const off = onInterrupt(async () => {
    if (promoting) await writeHold(d.stateRoot, r.repo, dep.name, { reason: 'interrupted while deploying; our version may be live but unverified — ship status', versionId, sha: target });
  });
  // '' when the hold that marked this deploy is gone (or was replaced by another, which stays);
  // otherwise why it could not be removed.
  const dropMark = async () => {
    try {
      const now = await readHold(d.stateRoot, r.repo, dep.name);
      if (now && now.reason === marked.reason && now.at === marked.at) await clearHold(d.stateRoot, r.repo, dep.name);
      return '';
    } catch (e) {
      return firstLine(e.message);
    }
  };
  try {
    if (isInterrupted()) return failed('interrupted before promoting; live untouched');
    try {
      marked = await writeHold(d.stateRoot, r.repo, dep.name, {
        reason: `deploy of ${target.slice(0, 7)} in progress since ${localTime(new Date().toISOString())}: if ship is not running, the result was never verified — ship status, then the owner decides (ship unhold ${dep.name})`,
        versionId, sha: target,
      });
    } catch (e) {
      return failed(`could not write the deploy-in-progress hold (${firstLine(e.message)}); nothing was deployed`);
    }
    // The last check before the promote, made after the await that could have let an interrupt in;
    // nothing is awaited between it and the request.
    if (isInterrupted()) {
      const stale = await dropMark();
      return failed(`interrupted before promoting; live untouched${stale ? ` (its deploy-in-progress hold could not be removed: ${stale} — ship unhold ${dep.name})` : ''}`);
    }
    promoting = true;
    if (dep.mode === 'versioned') {
      await cf.createDeployment(dep.worker, versionId, message);
    } else {
      const res = await run(`${shq(wrangler)} deploy${configArg} --message ${shq(message)}`, { cwd, env, logFile, timeoutMs: dep.timeoutMin * 60_000 });
      versionId = (await records(outFile)).find((x) => x.type === 'deploy')?.version_id ?? null;
      if (res.code !== 0 || !versionId) {
        showTail(res);
        const after = (await reread()).now;
        // Ours only if it is a different version than before: a redeploy starts out live at the target.
        const ours = after.state === 'known' && after.sha === target && after.versionId !== entry.live.versionId;
        if (!ours && (res.code === 124 || res.code === 130)) {
          // wrangler was killed (its timeout, an interrupt): its upload may still land, so the hold stays.
          const h = await hold({ d, r, dep }, { reason: `wrangler deploy ${res.code === 124 ? 'timed out' : 'was interrupted'}; whether our code went live is unknown`, versionId: null, sha: target });
          return stuck(h, dep, `hold set; ship status, then the owner decides (ship unhold ${dep.name})`);
        }
        if (!ours) {
          // A definite failure with nothing changed on the Worker: no hold either.
          const stale = await dropMark();
          return failed(`wrangler deploy exited ${res.code}${res.code === 0 ? ' without a deploy record' : ''}; live is ${describeLive(after)}${stale ? `; the deploy-in-progress hold could not be removed (${stale}) — ship unhold ${dep.name}` : ''}`);
        }
        if (res.code !== 0) {
          // The code went live, but wrangler failed later (e.g. while applying triggers).
          const h = await hold({ d, r, dep }, { reason: `wrangler deploy exited ${res.code} after our code went live; triggers may not be applied`, versionId: after.versionId, sha: target });
          return stuck(h, dep, `hold set; the owner checks ${dep.worker}, then ship unhold ${dep.name}`);
        }
        versionId = after.versionId;
        out(`! ${dep.name}: wrangler wrote no deploy record, but version ${versionId.slice(0, 8)} with our commit is live — verifying it`);
      } else {
        out(`✓ ${dep.name}: deployed ${versionId.slice(0, 8)} (${duration(res.durationMs)})`);
      }
    }
    const result = await verifyLive({ d, r, dep, entry, cf, target, versionId, changed, marker });
    if (result.outcome === 'deployed') {
      const stale = await dropMark();
      if (stale) out(`! ${dep.name}: deployed and verified, but its deploy-in-progress hold could not be cleared (${stale}) — ship unhold ${dep.name}`);
    }
    promoting = false; // settled: verified, rolled back, or already held
    return result;
  } catch (e) {
    if (!promoting) throw e;
    const h = await hold({ d, r, dep }, { reason: `ship error after the deploy started: ${firstLine(e.message)}`, versionId, sha: target });
    return stuck(h, dep, 'hold set; ship status');
  } finally {
    if (!isInterrupted()) off();
  }
}

async function verifyLive({ d, r, dep, entry, cf, target, versionId, changed, marker }) {
  const out = d.out;
  const current = await currentVersion(cf, dep.worker);
  if (current !== versionId) {
    const h = await hold({ d, r, dep }, { reason: `after the deploy the current version is ${current?.slice(0, 8) ?? 'none'}, not ours (${versionId.slice(0, 8)})`, versionId, sha: target });
    return stuck(h, dep, 'hold set; ship status');
  }
  if (dep.probes.length === 0) return { outcome: 'deployed', versionId };
  await warm(dep.liveHost, dep.warmup, { fetchImpl: d.fetch });
  const live = await probeAll(dep.liveHost, dep.probes, probeOptions(d));
  if (!live.ok) return await autoRollback({ d, r, dep, entry, cf, target, versionId, changed, reason: `live probes failed (${describeProbes(live.results)})` });
  out(`✓ ${dep.name}: live probes (${dep.probes.length})`);
  if (marker) {
    const seen = await waitForText(dep.liveHost, dep.liveMarker.path, marker, probeOptions(d));
    out(seen
      ? `✓ ${dep.name}: ${dep.liveMarker.path} serves build ${marker}`
      : `! ${dep.name}: ${dep.liveHost}${dep.liveMarker.path} did not show build ${marker} within ${Math.round(d.probeWindowMs / 1000)} s — look at it (not rolled back)`);
  }
  return { outcome: 'deployed', versionId };
}

// What is live after a rollback request failed. A refusal from Cloudflare changed nothing; any
// other failure (no answer, a 5xx) may have been applied, so the deployment is read again.
async function liveAfterFailedRollback(cf, dep, error, ours, previous) {
  if (error instanceof CloudflareError) return `our version ${ours.slice(0, 8)} is live`;
  try {
    const current = await currentVersion(cf, dep.worker);
    if (current === ours) return `our version ${ours.slice(0, 8)} is still live`;
    if (current === previous) return `the rollback did take effect: ${previous.slice(0, 8)} is live`;
    return `version ${current?.slice(0, 8) ?? 'none'} is live`;
  } catch {
    return 'could not read which version is live';
  }
}

async function autoRollback({ d, r, dep, entry, cf, target, versionId, changed, reason }) {
  const h = await hold({ d, r, dep }, { reason, versionId, sha: target });
  d.out(`✗ ${dep.name}: ${reason} — ${h.ok ? 'hold set' : 'the hold could not be written'}`);
  if (entry.live.state !== 'known') {
    return { outcome: 'stuck', detail: `${reason}. There is no earlier version with a known commit to roll back to. ${holdText(h, dep, `Owner: look at ${dep.liveHost}, fix forward, then ship unhold ${dep.name}`)}` };
  }
  if (changed.includes('migrations')) {
    return { outcome: 'stuck', detail: `${reason}. A Durable Object migration changed, and Cloudflare refuses a rollback past it. ${holdText(h, dep, `Owner: fix forward with a new deploy, then ship unhold ${dep.name}`)}` };
  }
  // Nothing is promoted over a version that is not ours: whoever deployed since owns what is live.
  let current;
  try {
    current = await currentVersion(cf, dep.worker);
  } catch {
    current = undefined;
  }
  if (current !== versionId) {
    const what = current === undefined ? 'could not read which version is live' : `version ${current?.slice(0, 8) ?? 'none'} is live, not ours (${versionId.slice(0, 8)})`;
    return { outcome: 'stuck', detail: `${reason}. Not rolling back: ${what}. ${holdText(h, dep, `hold in place; the owner looks at ${dep.worker}, then ship unhold ${dep.name}`)}` };
  }
  try {
    await cf.createDeployment(dep.worker, entry.live.versionId, `sha:${entry.live.sha} rollback`);
  } catch (e) {
    const secrets = e instanceof CloudflareError && e.codes.includes(10220)
      ? ` Cloudflare refuses it because a secret changed since that version was live; the owner decides: ship rollback ${dep.name} --to ${entry.live.versionId.slice(0, 8)} --revert-secrets, or fix forward.`
      : '';
    const live = await liveAfterFailedRollback(cf, dep, e, versionId, entry.live.versionId);
    return { outcome: 'stuck', detail: `${reason}. Rolling back to ${entry.live.versionId.slice(0, 8)} failed (${e.message}); ${live}; ${holdText(h, dep, 'hold in place')}.${secrets}` };
  }
  const again = await probeAll(dep.liveHost, dep.probes, probeOptions(d));
  const notRestored = changed.filter((k) => k !== 'migrations');
  return {
    outcome: 'rolled-back',
    detail: `${reason}. Rolled back to ${entry.live.sha.slice(0, 7)} (${entry.live.versionId.slice(0, 8)}); live probes after rollback: ${again.ok ? 'ok' : describeProbes(again.results)}`
      + `${notRestored.length ? `; a rollback does not restore ${notRestored.join(', ')}` : ''}. ${holdText(h, dep, `Hold set: fix, merge, then ship unhold ${dep.name}`)}`,
  };
}

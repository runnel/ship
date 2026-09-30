import { join } from 'node:path';
import { ownerInfo } from './lock.mjs';
import { UsageError, everyMinute, firstLine, holderText, lockWithCleanup, repoKeyOf } from './shared.mjs';
import { deployDeps, openTree, repoFromCwd, syncMirror } from './repo.mjs';
import { CloudflareError, cloudflare } from './cloudflare.mjs';
import { DEPLOYABLE_NAME } from './config.mjs';
import { codeSha, madeBySecretPut, previousCode, resolveLive, secretChangesBetween } from './live.mjs';
import { addAcks, clearHold, listHolds, readHold, writeHold } from './state.mjs';
import { changedFiles, commitsTouching, hasCommit, isAncestor, lastCommitBefore, listTree, revParse, showFile, subject } from './git.mjs';
import { matchesAny, pendingFile } from './glob.mjs';
import { changedSettings } from './wrangler-config.mjs';
import { wranglerConfigPath } from './adapters/workers.mjs';
import { describeProbes, probeAll, probeOptions, warm } from './probe.mjs';
import { isInterrupted } from './interrupt.mjs';
import { ensurePrivateDir } from './paths.mjs';
import { timeOr } from './report.mjs';

// The deploy lock (when `lock` names the command), a fresh mirror, main's config in a worktree, and
// a Cloudflare client (unless the command does not talk to Cloudflare).
async function withRepo({ cwd, d, lock, cloud = true, fn }) {
  await ensurePrivateDir(d.tmpRoot);
  const repo = await repoFromCwd(cwd);
  const release = lock
    ? await lockWithCleanup(join(d.tmpRoot, 'locks', `deploy-${repoKeyOf(repo)}`), await ownerInfo({ repo, command: lock }), {
      pollMs: d.pollMs,
      onWait: everyMinute((h) => d.out(`… waiting for the deploy lock: ${holderText(h)}`)),
    })
    : async () => {};
  try {
    const r = await syncMirror({ repo, d });
    const tree = await openTree({ d, r, sha: r.mainSha, label: 'a' });
    try {
      const { config } = tree;
      const cf = cloud && config.credentials
        ? await d.readCredentials(config.credentials).then((c) => cloudflare({ token: c.CLOUDFLARE_API_TOKEN, accountId: c.CLOUDFLARE_ACCOUNT_ID, fetchImpl: d.fetch }))
        : null;
      return await fn({ r, tree, config, cf });
    } finally {
      await tree.close();
    }
  } finally {
    await release();
  }
}

// The deployables the command names; a name that is not one is a usage error.
function findDeployables(config, names) {
  const unknown = names.filter((n) => !config.deployables.some((x) => x.name === n));
  if (unknown.length > 0) throw new UsageError(`unknown deployable: ${unknown.join(', ')} (known: ${config.deployables.map((x) => x.name).join(', ')})`);
  return names.map((n) => config.deployables.find((x) => x.name === n));
}

export async function runAdopt({ cwd, at = null, names = [], all = false, plan = false, deps = {} }) {
  const d = { ...deployDeps(), ...deps };
  if (plan) {
    if (at || all || names.length > 0) throw new UsageError('--plan takes no other argument');
  } else {
    if (!at) throw new UsageError('missing --at <sha>');
    if (all && names.length > 0) throw new UsageError('give deployable names or --all, not both');
    if (!all && names.length === 0) throw new UsageError('missing deployable names (or --all)');
    if (!/^[0-9a-f]{7,40}$/i.test(at)) throw new UsageError(`--at ${at}: give a commit sha (at least 7 hex digits)`);
  }
  return withRepo({ cwd, d, lock: plan ? null : 'adopt', fn: async ({ r, config, cf }) => {
    if (config.deployables.length === 0) {
      d.out('· no deployables in ship.config.mjs');
      return 0;
    }
    const chosen = plan || all ? config.deployables : findDeployables(config, [...new Set(names)]);
    if (plan) return adoptPlan({ d, r, cf, chosen });
    let sha;
    try {
      sha = await revParse(r.mirror, at);
    } catch {
      d.out(`✗ ${at} is not a commit in ${r.repo}`);
      return 2;
    }
    if (!(await isAncestor(r.mirror, sha, r.mainSha))) {
      d.out(`✗ ${sha.slice(0, 7)} is not on ${r.mainBranch}`);
      return 2;
    }
    let failures = 0;
    let refused = 0;
    for (const dep of chosen) {
      const result = await adoptOne({ d, r, docsOnly: config.docsOnly, cf, dep, sha });
      if (result === 'refused') refused++;
      if (result !== 'ok') failures++;
    }
    if (config.migrations && refused > 0) {
      // A commit that would hide changes would also clear the migrations that came with them.
      d.out(`! migrations: not recorded; ${refused} deployable(s) were refused at ${sha.slice(0, 7)} — adopt the earlier commit named above, which records the migrations present there`);
    } else if (config.migrations) {
      const files = (await listTree(r.mirror, sha)).filter((f) => matchesAny(f, config.migrations.paths));
      const added = await addAcks(d.stateRoot, r.repo, files);
      const newest = [...files].sort().slice(-5).map((f) => f.split('/').pop());
      d.out(`✓ migrations: ${added.length} file(s) present at ${sha.slice(0, 7)} recorded as cleared (newest: ${newest.join(', ') || 'none'})`);
    }
    return failures > 0 ? 1 : 0;
  } });
}

// Commits and files between a known live commit and `sha` that ship deploy would still ship: with
// `sha` recorded as live they would count as deployed. Nothing when the live commit is unknown, not
// on main, the same as `sha`, or not before it (adopting an older commit only adds work).
async function hiddenBy({ r, docsOnly, dep, before, sha }) {
  const none = { files: [], commits: [] };
  if (before.state !== 'known' || before.sha === sha) return none;
  if (!(await hasCommit(r.mirror, before.sha))) return none;
  if (!(await isAncestor(r.mirror, before.sha, r.mainSha)) || !(await isAncestor(r.mirror, before.sha, sha))) return none;
  const wanted = pendingFile(dep, docsOnly);
  const files = (await changedFiles(r.mirror, before.sha, sha)).filter(wanted);
  return { files, commits: files.length > 0 ? await commitsTouching(r.mirror, before.sha, sha, wanted) : [] };
}

// Re-deploys the current version with a `sha:` annotation: same code, a new deployment record.
// 'ok', 'refused' (recording `sha` would hide pending changes) or 'failed'.
async function adoptOne({ d, r, docsOnly, cf, dep, sha }) {
  try {
    const [deployments, versions] = await Promise.all([cf.deployments(dep.worker), cf.versions(dep.worker)]);
    const current = deployments[0];
    if (!current) {
      d.out(`! ${dep.name}: ${dep.worker} has no deployment — nothing to adopt (${dep.mode === 'versioned' ? "the first deploy of a versioned deployable is the owner's" : 'ship deploy creates it'})`);
      return 'ok';
    }
    if (current.versions.length !== 1 || current.versions[0].percentage !== 100) {
      d.out(`✗ ${dep.name}: the current deployment splits traffic; not adopting`);
      return 'failed';
    }
    const before = resolveLive({ deployments, versions });
    const { files, commits } = await hiddenBy({ r, docsOnly, dep, before, sha });
    if (files.length > 0) {
      const what = commits.length > 0 ? `${commits.length} commit(s) that touch it (${commits.slice(0, 3).map((c) => c.subject.slice(0, 60)).join(' | ')})` : `changes to ${files.length} file(s)`;
      d.out(`✗ ${dep.name}: ${before.sha.slice(0, 7)} is live and known; adopting ${sha.slice(0, 7)} would hide ${what} — ship deploy would count them as live. Let ship deploy ship them, or adopt ${before.sha.slice(0, 7)}`);
      return 'refused';
    }
    if (isInterrupted()) {
      d.out(`✗ ${dep.name}: interrupted before promoting; nothing changed`);
      return 'failed';
    }
    await cf.createDeployment(dep.worker, current.versions[0].version_id, `sha:${sha} adopt`);
    d.out(`✓ ${dep.name}: version ${current.versions[0].version_id.slice(0, 8)} recorded as ${sha.slice(0, 7)} (was ${before.state === 'known' ? before.sha.slice(0, 7) : before.state})`);
    return 'ok';
  } catch (e) {
    d.out(`✗ ${dep.name}: adopt failed (${e.message})`);
    return 'failed';
  }
}

async function adoptPlan({ d, r, cf, chosen }) {
  const groups = new Map();
  for (const dep of chosen) {
    const [deployments, versions] = await Promise.all([cf.deployments(dep.worker), cf.versions(dep.worker)]);
    const live = resolveLive({ deployments, versions });
    if (live.state === 'none') {
      d.out(`· ${dep.name}: not deployed yet`);
      continue;
    }
    if (live.state === 'known' && (await hasCommit(r.mirror, live.sha)) && (await isAncestor(r.mirror, live.sha, r.mainSha))) {
      d.out(`· ${dep.name}: live commit already known (${live.sha.slice(0, 7)}); nothing to adopt`);
      continue;
    }
    if (!live.versionId) {
      d.out(`? ${dep.name}: the current deployment splits traffic; adopt refuses that — put one version at 100% first`);
      continue;
    }
    // The code version: the live one, or the version below a chain of secret changes.
    let v = versions.find((x) => x.id === live.versionId);
    while (v?.annotations?.['workers/triggered_by'] === 'secret') {
      const below = v.number - 1;
      v = versions.find((x) => x.number === below);
    }
    if (!v) {
      d.out(`? ${dep.name}: its code version is older than the history ship reads — name the commit yourself`);
      continue;
    }
    if (madeBySecretPut(v)) {
      d.out(`? ${dep.name}: its live version was made by \`wrangler versions secret put\` — name the commit yourself`);
      continue;
    }
    const base = await lastCommitBefore(r.mirror, `refs/heads/${r.mainBranch}`, v.metadata.created_on);
    if (!base) {
      d.out(`? ${dep.name}: no ${r.mainBranch} commit before ${timeOr(v.metadata.created_on)}`);
      continue;
    }
    const later = await commitsTouching(r.mirror, base, r.mainSha, dep.paths);
    d.out(`· ${dep.name}: code uploaded ${timeOr(v.metadata.created_on)}; ${r.mainBranch} then: ${base.slice(0, 7)}; ${later.length} later commit(s) touch it${later.length ? ` (${later.slice(0, 3).map((c) => c.subject.slice(0, 60)).join(' | ')})` : ''}`);
    groups.set(base, [...(groups.get(base) ?? []), dep.name]);
  }
  if (groups.size > 0) {
    d.out('Suggested (each asks for permission; a later commit makes the deployable pending, and the next ship deploy ships it):');
    for (const [sha, list] of groups) d.out(`  ship adopt --at ${sha.slice(0, 12)} ${list.join(' ')}`);
  }
  return 0;
}

// Which non-versioned Worker settings differ between the two commits, or why that cannot be told.
async function settingsBetween({ r, tree, dep, targetSha, liveSha }) {
  let cfgPath = null;
  try {
    cfgPath = await wranglerConfigPath(tree.wt, dep);
    for (const sha of [targetSha, liveSha]) {
      if (!(await hasCommit(r.mirror, sha))) return { cfgPath, error: `commit ${sha.slice(0, 7)} is not in ${r.repo}` };
    }
    const target = await showFile(r.mirror, targetSha, cfgPath);
    const live = await showFile(r.mirror, liveSha, cfgPath);
    return { cfgPath, changed: changedSettings(target, live, cfgPath) };
  } catch (e) {
    return { cfgPath, error: firstLine(e.message) };
  }
}

const withoutRequest = (message) => message.replace(/^Cloudflare [A-Z]+ [^\s:]+: /, '');

export async function runRollback({ cwd, name, to = null, revertSecrets = false, deps = {} }) {
  const d = { ...deployDeps(), ...deps };
  const targeted = to !== null;
  if (!name) throw new UsageError('missing deployable name');
  if (revertSecrets && !targeted) throw new UsageError('--revert-secrets needs --to <version>');
  if (targeted && !/^[0-9a-f-]{6,36}$/i.test(to)) throw new UsageError(`--to ${to}: give a version id (at least 6 hex digits; the first 8 are enough)`);
  // Without --to nothing changes: the owner sees the target and runs the printed command, whose
  // permission prompt then names the exact version.
  return withRepo({ cwd, d, lock: targeted ? 'rollback' : null, fn: async ({ r, tree, config, cf }) => {
    const [dep] = findDeployables(config, [name]);
    const [deployments, versions] = await Promise.all([cf.deployments(dep.worker), cf.versions(dep.worker)]);
    const live = resolveLive({ deployments, versions });
    if (live.state === 'none') {
      d.out(`✗ ${dep.name}: ${dep.worker} has no deployment; nothing to roll back`);
      return 1;
    }
    let target;
    if (targeted) {
      const hits = versions.filter((v) => v.id.startsWith(to.toLowerCase()));
      if (hits.length !== 1) {
        d.out(`✗ --to ${to}: ${hits.length ? 'ambiguous' : 'no such version'} among the last ${versions.length} versions`);
        return 2;
      }
      const code = codeSha(hits[0].id, { deployments, versions });
      if (!code.sha) {
        d.out(`✗ version ${hits[0].id.slice(0, 8)}: ${code.reason}`);
        return 1;
      }
      target = { versionId: hits[0].id, sha: code.sha, created_on: hits[0].metadata.created_on,
        deployed: deployments.some((x) => x.versions.some((v) => v.version_id === hits[0].id)) };
    } else {
      target = live.state === 'known' ? previousCode({ deployments, versions }, live) : null;
      if (!target) {
        d.out(live.state === 'known'
          ? `✗ ${dep.name}: no earlier version with a known commit — name one with --to <version>`
          : `✗ ${dep.name}: live unknown (${live.reason}); name the version to roll back to with --to <version>`);
        return 1;
      }
    }
    if (target.versionId === live.versionId) {
      d.out(`✗ ${dep.name}: ${target.versionId.slice(0, 8)} is already live`);
      return 1;
    }
    const describe = async (sha, versionId, when) => `${sha.slice(0, 7)} ${(await subject(r.mirror, sha)) ?? '(commit not in the repo)'} · ${versionId.slice(0, 8)} · ${timeOr(when)}`;
    d.out(live.state === 'known' ? `▸ ${dep.name} now: ${await describe(live.sha, live.versionId, deployments[0].created_on)}` : `▸ ${dep.name} now: live unknown (${live.reason ?? live.state})`);
    d.out(`▸ ${dep.name} back to: ${await describe(target.sha, target.versionId, target.created_on)}${target.deployed ? '' : ' (never the live version as far as the history shows)'}`);
    if (live.state !== 'known') {
      d.out('! live commit unknown: Worker settings and Durable Object migrations cannot be compared between the two versions');
    } else {
      const { cfgPath, changed, error } = await settingsBetween({ r, tree, dep, targetSha: target.sha, liveSha: live.sha });
      if (error) {
        d.out(`! could not compare the Worker config between the two commits (${cfgPath ? `${cfgPath}: ` : ''}${error}); check triggers, routes and Durable Object migrations yourself`);
      } else if (changed.includes('migrations')) {
        d.out('✗ a Durable Object migration changed between the two; Cloudflare refuses this rollback — fix forward');
        return 1;
      } else if (changed.length > 0) {
        d.out(`! a rollback does not restore ${changed.join(', ')}: they stay as deployed now`);
      }
    }
    const secrets = live.versionId ? secretChangesBetween(versions, live.versionId, target.versionId) : null;
    if (secrets === null) d.out('! secret changes between the two could not be counted; if Cloudflare refuses with 10220, add --revert-secrets');
    else if (secrets.length > 0) d.out(`! this also undoes ${secrets.length} secret change(s), the first at ${timeOr(secrets.at(-1).metadata.created_on)}`);
    if (config.migrations) d.out('! database migrations are not rolled back');
    const short = target.versionId.slice(0, 8);
    if (!targeted) {
      d.out(`To roll back, run: ship rollback ${dep.name} --to ${short}${secrets?.length > 0 ? ' --revert-secrets' : ''}`);
      return 0;
    }
    // The hold goes first: if the promote's outcome is unknown, or ship dies after it, nothing
    // else may deploy over the rolled-back Worker.
    const before = await readHold(d.stateRoot, r.repo, dep.name);
    await writeHold(d.stateRoot, r.repo, dep.name, { reason: `rolled back to ${target.sha.slice(0, 7)} with ship rollback`, versionId: target.versionId, sha: target.sha });
    // When nothing was promoted, the hold state goes back to what it was; '' or why it could not be.
    const restoreHold = async () => {
      try {
        if (before) await writeHold(d.stateRoot, r.repo, dep.name, before);
        else await clearHold(d.stateRoot, r.repo, dep.name);
        return '';
      } catch (err) {
        return `; the hold could not be put back (${firstLine(err.message)}) — ship unhold ${dep.name}`;
      }
    };
    try {
      if (isInterrupted()) {
        d.out(`✗ ${dep.name}: interrupted before promoting; nothing changed${await restoreHold()}`);
        return 1;
      }
      await cf.createDeployment(dep.worker, target.versionId, `sha:${target.sha} rollback`, { force: revertSecrets });
    } catch (e) {
      if (!(e instanceof CloudflareError)) {
        // A network error or a timeout: the deployment may have been made. The hold stays.
        d.out(`✗ ${dep.name}: rollback outcome unknown (${e.message}); the hold stays — ship status`);
        return 1;
      }
      // A definite refusal: nothing changed on Cloudflare.
      const restoreFailure = await restoreHold();
      if (e.codes.includes(10220)) {
        const hint = revertSecrets ? ' (even with --revert-secrets)' : `. If reverting those secrets is intended: ship rollback ${dep.name} --to ${short} --revert-secrets`;
        d.out(`✗ Cloudflare refuses: ${withoutRequest(e.message)}${hint}${restoreFailure}`);
      } else {
        d.out(`✗ ${dep.name}: rollback failed (${e.message}); nothing changed${restoreFailure}`);
      }
      return 1;
    }
    d.out(`✓ ${dep.name}: ${short} is live; hold set (ship unhold ${dep.name} once the fix is merged)`);
    if (dep.probes.length === 0) return 0;
    await warm(dep.liveHost, dep.warmup, { fetchImpl: d.fetch });
    const probed = await probeAll(dep.liveHost, dep.probes, probeOptions(d));
    d.out(probed.ok ? `✓ ${dep.name}: live probes` : `✗ ${dep.name}: live probes: ${describeProbes(probed.results)}`);
    return probed.ok ? 0 : 1;
  } });
}

// Works from the state directory alone (no network), so a hold can be cleared whatever else is down.
export async function runUnhold({ cwd, name, deps = {} }) {
  const d = { ...deployDeps(), ...deps };
  if (!name) throw new UsageError('missing deployable name');
  if (!DEPLOYABLE_NAME.test(name)) throw new UsageError(`${JSON.stringify(name)} is not a deployable name`);
  const repo = await repoFromCwd(cwd);
  const hold = await readHold(d.stateRoot, repo, name);
  if (!hold) {
    const others = Object.keys(await listHolds(d.stateRoot, repo));
    d.out(`· ${name}: no hold${others.length > 0 ? ` (held: ${others.join(', ')})` : ''}`);
    return 0;
  }
  await clearHold(d.stateRoot, repo, name);
  const since = timeOr(hold.at, null);
  d.out(`✓ ${name}: hold cleared (was: ${hold.reason}${since ? `, since ${since}` : ''})`);
  return 0;
}

export async function runAck({ cwd, files, deps = {} }) {
  const d = { ...deployDeps(), ...deps };
  if (files.length === 0) throw new UsageError('missing migration file names');
  return withRepo({ cwd, d, lock: null, cloud: false, fn: async ({ r, config }) => {
    if (!config.migrations) {
      d.out(`✗ ${r.repo} has no migrations in ship.config.mjs`);
      return 2;
    }
    const all = (await listTree(r.mirror, r.mainSha)).filter((f) => matchesAny(f, config.migrations.paths));
    const resolved = [];
    for (const arg of files) {
      const f = arg.replace(/^\.\//, '');
      const exact = all.filter((p) => p === f);
      const hits = exact.length > 0 ? exact : all.filter((p) => p.split('/').pop() === f);
      if (hits.length !== 1) {
        d.out(`✗ ${arg}: ${hits.length ? 'ambiguous (give the path)' : `not a migration on ${r.mainBranch}`}; nothing recorded`);
        return 2;
      }
      resolved.push(hits[0]);
    }
    const added = await addAcks(d.stateRoot, r.repo, resolved);
    d.out(`✓ cleared for deploy: ${added.length ? added.join(', ') : '(already cleared)'}`);
    return 0;
  } });
}

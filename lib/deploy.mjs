import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ownerInfo } from './lock.mjs';
import { everyMinute, lockWithCleanup, newLogFile, repoKeyOf, runSteps, withLane } from './shared.mjs';
import { deployDeps, openTree, prRefs, repoFromCwd, syncMirror } from './repo.mjs';
import { ICON, planDeploy, propagate } from './plan.mjs';
import { cloudflare } from './cloudflare.mjs';
import { readAcks } from './state.mjs';
import { commitsTouching, listTree, showFile } from './git.mjs';
import { matchesAny } from './glob.mjs';
import { deployOne } from './adapters/workers.mjs';
import { ensurePrivateDir } from './paths.mjs';
import { stopStrays } from './proc.mjs';
import { isInterrupted } from './interrupt.mjs';
import { duration, localTime } from './report.mjs';

const OK = new Set(['live', 'deployed', 'dry-run']);

export async function runDeploy({ cwd, names = [], dryRun = false, redeploy = false, deps = {} }) {
  const d = { ...deployDeps(), ...deps };
  if (redeploy && names.length === 0) {
    d.out('usage: ship deploy --redeploy <deployable>… (names are required)');
    return 2;
  }
  await ensurePrivateDir(d.tmpRoot);
  const repo = await repoFromCwd(cwd);
  const releaseLock = await lockWithCleanup(join(d.tmpRoot, 'locks', `deploy-${repoKeyOf(repo)}`), await ownerInfo({ repo, command: 'deploy' }), {
    pollMs: d.pollMs,
    onWait: everyMinute((h) => d.out(`… waiting for the deploy lock of ${repo}: ${h?.command ?? '?'} since ${h?.since ? localTime(h.since) : '?'} (pid ${h?.pid ?? '?'})`)),
  });
  try {
    // After the lock: whoever held it may have merged and deployed meanwhile.
    const r = await syncMirror({ repo, d });
    const tree = await openTree({ d, r, sha: r.mainSha, label: 'd' });
    try {
      return await deployTree({ d, r, tree, names, dryRun, redeploy });
    } finally {
      try {
        // A background process a build or setup step left running would outlive ship and stack
        // with the next heavy build; and one still writing into the worktree could make its
        // removal fail. So they are stopped first.
        // Not when interrupted: the unwind has stopped the group, and its own helpers run in it now.
        const stray = isInterrupted() ? 0 : await stopStrays().catch(() => 0);
        if (stray > 0) d.out(`! ${stray} background process(es) started by the deploy were still running — stopped`);
      } finally {
        await tree.close();
      }
    }
  } finally {
    await releaseLock();
  }
}

async function deployTree({ d, r, tree, names, dryRun, redeploy }) {
  const { config, wt } = tree;
  const target = r.mainSha;
  const t7 = target.slice(0, 7);
  if (config.deployables.length === 0) {
    d.out(`✗ ${r.repo}: no deployables in ship.config.mjs`);
    return 2;
  }
  const unknown = names.filter((n) => !config.deployables.some((x) => x.name === n));
  if (unknown.length > 0) {
    d.out(`✗ unknown deployable: ${unknown.join(', ')} (known: ${config.deployables.map((x) => x.name).join(', ')})`);
    return 2;
  }
  const selected = new Set(names.length > 0 ? names : config.deployables.map((x) => x.name));
  const creds = await d.readCredentials(config.credentials);
  const cf = cloudflare({ token: creds.CLOUDFLARE_API_TOKEN, accountId: creds.CLOUDFLARE_ACCOUNT_ID, fetchImpl: d.fetch });
  d.out(`▸ ${r.repo} deploy ${r.mainBranch}@${t7}${dryRun ? ' (dry run)' : ''}`);
  const entries = await planDeploy({ r, config, selected, target, cf, stateRoot: d.stateRoot, wt, redeploy: redeploy ? selected : new Set() });
  for (const e of entries.filter((x) => x.selected)) d.out(`${ICON[e.status]} ${e.dep.name}: ${e.reason}`);
  const pending = () => entries.filter((e) => e.selected && e.status === 'pending');
  if (pending().length === 0) return summary(d, entries);

  if (config.migrations) {
    const acked = await readAcks(d.stateRoot, r.repo);
    const migrations = (await listTree(r.mirror, target)).filter((f) => matchesAny(f, config.migrations.paths));
    const unacked = migrations.filter((f) => !acked.has(f));
    if (unacked.length > 0) {
      // `ship migrations ack` takes a bare file name only while it is unambiguous among the
      // migrations on main; otherwise the hint carries the path.
      const bare = (f) => f.split('/').pop();
      const count = new Map();
      for (const f of migrations) count.set(bare(f), (count.get(bare(f)) ?? 0) + 1);
      d.out(`✗ migrations not cleared for deploy: ${unacked.join(', ')}`);
      d.out(`  the owner applies them (or decides they go after the deploy) and runs: ship migrations ack ${unacked.map((f) => (count.get(bare(f)) > 1 ? f : bare(f))).join(' ')}`);
      return 1;
    }
  }
  for (const req of config.requires) {
    const state = await requiredState({ d, req });
    if (state !== 'live') {
      d.out(`✗ requires ${req.repo} ${req.deployable}: ${state} — deploy that first`);
      return 1;
    }
    d.out(`✓ requires ${req.repo} ${req.deployable}: live at its main`);
  }

  const logFile = await newLogFile(d.logRoot, r.repo, `deploy-${t7}`);
  if (config.deploySetup.length > 0) {
    const setup = await withLane({ d, lane: 'heavy', owner: { repo: r.repo, command: 'deploy setup' },
      fn: () => runSteps({ label: 'setup', steps: config.deploySetup, cwd: wt, logFile, out: d.out }) });
    if (!setup.ok) return 1;
  }
  const files = [...new Set(pending().flatMap((e) => e.files))];
  for (const group of config.checks.filter((c) => c.onDeploy)) {
    const steps = [...(group.install ? [{ run: group.install, env: {} }] : []), ...group.steps];
    const res = await withLane({ d, lane: group.lane, owner: { repo: r.repo, command: `deploy check ${group.name}` },
      fn: () => runSteps({ label: group.name, steps, cwd: join(wt, group.cwd), env: { ...group.env, ...group.stubEnv, SHIP_CHANGED_FILES: files.join('\n') }, logFile, timeoutMin: group.timeoutMin, out: d.out }) });
    if (!res.ok) {
      d.out(`✗ deploy-time check ${group.name} is red on ${r.mainBranch}@${t7}; nothing deployed`);
      return 1;
    }
  }

  const nonce = randomBytes(3).toString('hex');
  for (const e of entries) {
    if (!(e.selected && e.status === 'pending')) continue;
    const started = Date.now();
    let note = '';
    let res;
    try {
      const subjects = e.live.state === 'known' ? (await commitsTouching(r.mirror, e.live.sha, target, e.dep.paths)).map((c) => c.subject) : [];
      note = prRefs(subjects);
      d.out(`▸ ${e.dep.name}: ${e.dep.mode} ${e.live.state === 'known' ? e.live.sha.slice(0, 7) : 'new'} → ${t7}${note ? ` (${note})` : ''}`);
      res = await deployOne({ d, r, wt, dep: e.dep, entry: e, cf, creds, target, nonce, note, logFile, dryRun, readAt: (sha, p) => showFile(r.mirror, sha, p) });
    } catch (err) {
      // An interrupt ends the run (the caller reports it); it is not a failure of this deployable.
      if (err?.aborted || isInterrupted()) throw err;
      // Before any promote (deployOne turns later errors into a hold): this one failed, the run goes on.
      res = { outcome: 'failed', detail: `ship error: ${String(err.message).split('\n')[0]}` };
    }
    e.status = res.outcome;
    e.reason = res.outcome === 'deployed' ? `${res.versionId.slice(0, 8)} live at ${t7}${note ? ` (${note})` : ''} · ${duration(Date.now() - started)}` : res.detail;
    d.out(`${ICON[e.status]} ${e.dep.name}: ${e.reason}`);
    const before = new Set(entries.filter((x) => x.status === 'skipped').map((x) => x.dep.name));
    propagate(entries, config.deployables);
    for (const x of entries.filter((y) => y.status === 'skipped' && !before.has(y.dep.name))) d.out(`! ${x.dep.name}: ${x.reason}`);
  }
  return summary(d, entries);
}

function summary(d, entries) {
  const bad = entries.filter((e) => e.selected && !OK.has(e.status));
  d.out(bad.length > 0 ? `✗ ship deploy: ${bad.map((e) => `${e.dep.name} ${e.status}`).join(', ')}` : '✓ ship deploy: everything selected is live');
  return bad.length > 0 ? 1 : 0;
}

// A deployable of another repo this one depends on must be live at that repo's main.
async function requiredState({ d, req }) {
  const r = await syncMirror({ repo: req.repo, d });
  const tree = await openTree({ d, r, sha: r.mainSha, label: 'q' });
  try {
    const dep = tree.config.deployables.find((x) => x.name === req.deployable);
    if (!dep) return `no deployable ${req.deployable} in its ship.config.mjs`;
    const creds = await d.readCredentials(tree.config.credentials);
    const cf = cloudflare({ token: creds.CLOUDFLARE_API_TOKEN, accountId: creds.CLOUDFLARE_ACCOUNT_ID, fetchImpl: d.fetch });
    const [e] = await planDeploy({ r, config: { ...tree.config, deployables: [{ ...dep, after: [] }] }, selected: new Set([dep.name]), target: r.mainSha, cf, stateRoot: d.stateRoot });
    return e.status === 'live' ? 'live' : `${e.status} (${e.reason})`;
  } finally {
    await tree.close();
  }
}

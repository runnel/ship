import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ownerInfo } from './lock.mjs';
import { UsageError, clearHint, everyMinute, firstLine, lockWithCleanup, newLogFile, repoKeyOf, runSteps, withLane } from './shared.mjs';
import { deployDeps, openTree, prRefs, repoFromCwd, shipsText, syncMirror } from './repo.mjs';
import { ICON, planDeploy, propagate, recheckHolds } from './plan.mjs';
import { cloudflareFor } from './cloudflare.mjs';
import { readAcks } from './state.mjs';
import { commitsTouching, hasCommit, isAncestor, listTree, showFile } from './git.mjs';
import { matchesAny } from './glob.mjs';
import { deployOne } from './adapters/workers.mjs';
import { ensurePrivateDir } from './paths.mjs';
import { stopStrays } from './proc.mjs';
import { isInterrupted, onInterrupt } from './interrupt.mjs';
import { duration, localTime } from './report.mjs';
import { NO_LEADER, enterDeploy, followDeploy } from './intake.mjs';

const OK = new Set(['live', 'deployed', 'dry-run']);
// A deployable in one of these will not be deployed, and what waits for it will not either.
export const NOT_RUNNABLE = new Set(['held', 'blocked', 'skipped']);
const t7 = (sha) => sha.slice(0, 7);

// The work in the slot is bounded: the heavy lane is the machine's, and a fetch that hangs there
// would stall every check and deploy. What is left running when the time is up only reads.
function within(ms = 90_000, promise, what) {
  let timer;
  promise.catch(() => {});
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms < 1000 ? `${ms} ms` : duration(ms)}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export async function runDeploy({ cwd, names = [], dryRun = false, redeploy = false, floors = {}, deps = {} }) {
  const d = { ...deployDeps(), ...deps, requiresFloors: floors };
  if (redeploy && names.length === 0) throw new UsageError('--redeploy needs deployable names');
  await ensurePrivateDir(d.tmpRoot);
  const repo = await repoFromCwd(cwd);
  // A dry run uploads nothing and is nobody's result: it neither joins nor is joined.
  if (dryRun) return await leadDeploy({ d, repo, names, dryRun, redeploy, lead: NO_LEADER });
  for (;;) {
    const entry = await enterDeploy({ d, repo, names, redeploy });
    if (entry.lead) return await leadDeploy({ d, repo, names, dryRun, redeploy, lead: entry.lead });
    const joined = await followDeploy({ d, repo, leader: entry.follow });
    if (joined.code !== null) return joined.code;
    d.out(`! the deploy this one joined ${joined.why}; deploying now`);
  }
}

// The deploy that runs for everyone who asked while it had not frozen what it ships: its output
// also goes to the registry, and its verdict ends there.
async function leadDeploy({ d: base, repo, names, dryRun, redeploy, lead }) {
  const d = lead === NO_LEADER ? base : { ...base, out: (line) => { base.out(line); lead.out(line); } };
  const off = onInterrupt(() => lead.end({ code: 130 }));
  let code;
  try {
    code = await lockedDeploy({ d, repo, names, dryRun, redeploy, lead });
  } catch (e) {
    await lead.end({ code: e?.aborted || isInterrupted() ? 130 : 1, error: firstLine(e?.message) }).catch(() => {});
    throw e;
  } finally {
    if (!isInterrupted()) off();
  }
  await lead.end({ code }).catch(() => {});
  return code;
}

async function lockedDeploy({ d, repo, names, dryRun, redeploy, lead }) {
  const releaseLock = await lockWithCleanup(join(d.tmpRoot, 'locks', `deploy-${repoKeyOf(repo)}`), await ownerInfo({ repo, command: 'deploy' }), {
    pollMs: d.pollMs,
    onWait: everyMinute((h) => d.out(`… waiting for the deploy lock of ${repo}: ${h?.command ?? '?'} since ${h?.since ? localTime(h.since) : '?'} (pid ${h?.pid ?? '?'})`)),
  });
  try {
    // After the lock: whoever held it may have merged and deployed meanwhile.
    const r = await syncMirror({ repo, d });
    // The deploy may move to a later main while it waits for its slot, and then to another tree.
    const holder = { tree: await openTree({ d, r, sha: r.mainSha, label: 'd' }) };
    try {
      return await deployTree({ d, r, holder, names, dryRun, redeploy, lead });
    } finally {
      try {
        // A background process a build or setup step left running would outlive ship and stack
        // with the next heavy build; and one still writing into the worktree could make its
        // removal fail. So they are stopped first.
        // Not when interrupted: the unwind has stopped the group, and its own helpers run in it now.
        const stray = isInterrupted() ? 0 : await stopStrays().catch(() => 0);
        if (stray > 0) d.out(`! ${stray} background process(es) started by the deploy were still running — stopped`);
      } finally {
        await holder.tree.close();
      }
    }
  } finally {
    await releaseLock();
  }
}

const namesProblem = (config, names) => {
  const unknown = names.filter((n) => !config.deployables.some((x) => x.name === n));
  return unknown.length > 0 ? `unknown deployable: ${unknown.join(', ')} (known: ${config.deployables.map((x) => x.name).join(', ')})` : null;
};

// What deploying `sha` would do: the tree's config, the credentials, one entry per deployable,
// and for the pending ones the commits they would ship. Prints nothing.
async function planAt({ d, r, tree, sha, names, redeploy }) {
  const { config } = tree;
  const selected = new Set(names.length > 0 ? names : config.deployables.map((x) => x.name));
  const { creds, cf } = await cloudflareFor(d, config.credentials);
  const entries = await planDeploy({ r, config, selected, target: sha, cf, stateRoot: d.stateRoot, wt: tree.wt, redeploy: redeploy ? selected : new Set() });
  for (const e of entries.filter((x) => x.selected)) {
    if (e.status === 'pending' && e.live.state === 'known') e.commits = await commitsTouching(r.mirror, e.live.sha, sha, e.dep.paths);
  }
  return { tree, config, wt: tree.wt, sha, selected, creds, cf, entries };
}

const headerLine = (r, sha, dryRun) => `▸ ${r.repo} deploy ${r.mainBranch}@${t7(sha)}${dryRun ? ' (dry run)' : ''}`;

function planLines(d, s) {
  for (const e of s.entries.filter((x) => x.selected)) {
    d.out(`${ICON[e.status]} ${e.dep.name}: ${e.reason}${e.commits?.length ? ` · ${shipsText(e.commits.map((c) => c.subject))}` : ''}`);
  }
}

// What the build that follows will ship, as the last line before it: one list for every deployable.
function finalLine(r, s) {
  const subjects = new Map();
  for (const e of s.entries) {
    if (e.selected && e.status === 'pending') for (const c of e.commits ?? []) subjects.set(c.sha, c.subject);
  }
  return `▸ building ${r.mainBranch}@${t7(s.sha)}${subjects.size > 0 ? ` · ${shipsText([...subjects.values()])}` : ''}`;
}

// The migration files of `sha` that the owner has not cleared for deploy.
export async function unclearedMigrations({ d, r, config, sha }) {
  const acked = await readAcks(d.stateRoot, r.repo);
  const migrations = (await listTree(r.mirror, sha)).filter((f) => matchesAny(f, config.migrations.paths));
  return { migrations, unacked: migrations.filter((f) => !acked.has(f)) };
}

async function deployTree({ d, r, holder, names, dryRun, redeploy, lead = NO_LEADER }) {
  const first = holder.tree;
  if (first.config.deployables.length === 0) {
    d.out(`✗ ${r.repo}: no deployables in ship.config.mjs`);
    return 2;
  }
  const problem = namesProblem(first.config, names);
  if (problem) throw new UsageError(problem);
  d.out(headerLine(r, r.mainSha, dryRun));
  let s = await planAt({ d, r, tree: first, sha: r.mainSha, names, redeploy });
  planLines(d, s);
  const pending = () => s.entries.filter((e) => e.selected && e.status === 'pending');
  if (pending().length === 0) return summary(d, s.entries, dryRun);

  if (s.config.migrations) {
    const { migrations, unacked } = await unclearedMigrations({ d, r, config: s.config, sha: s.sha });
    if (unacked.length > 0) {
      d.out(`✗ migrations not cleared for deploy: ${unacked.join(', ')}`);
      for (const l of clearHint(unacked, migrations, s.config.migrations.apply)) d.out(l);
      return 1;
    }
  }
  for (const req of s.config.requires) {
    const floor = d.requiresFloors?.[req.repo] ?? null;
    const state = await requiredState({ d, req, floor });
    if (state !== 'live') {
      d.out(`✗ requires ${req.repo} ${req.deployable}: ${state} — deploy that first`);
      return 1;
    }
    d.out(`✓ requires ${req.repo} ${req.deployable}: ${floor ? `live at or past ${floor.slice(0, 7)}` : 'live at its main'}`);
  }

  // The deploy now waits for the heavy lane, which can take long, and main goes on meanwhile. What
  // it ships is therefore decided when the slot arrives (settle), before any command runs in a tree.
  let logFile;
  const settled = async () => {
    s = await settle({ d, r, holder, s, names, redeploy, dryRun, lead });
    logFile = await newLogFile(d.logRoot, r.repo, `deploy-${t7(s.sha)}`);
    if (pending().length > 0) d.out(finalLine(r, s));
  };
  const runSetup = () => runSteps({ label: 'setup', steps: s.config.deploySetup, cwd: s.wt, logFile, out: d.out });
  const inSlot = (fn) => withLane({ d, lane: 'heavy', owner: { repo: r.repo, command: 'deploy setup' }, fn });
  let setup = { ok: true };
  if (s.config.deploySetup.length > 0) {
    // The setup's slot is the first the deploy waits for: what it ships is fixed in it.
    setup = await inSlot(async () => {
      await settled();
      return pending().length > 0 ? runSetup() : { ok: true };
    });
  } else {
    await settled(); // no slot to wait for here: main was read moments ago
    if (pending().length > 0 && s.config.deploySetup.length > 0) setup = await inSlot(runSetup); // the head it moved to has a setup
  }
  if (!setup.ok) return 1;
  if (pending().length === 0) return summary(d, s.entries, dryRun);

  const { config, wt, sha: target, creds, cf, entries } = s;
  const files = [...new Set(pending().flatMap((e) => e.files))];
  for (const group of config.checks.filter((c) => c.onDeploy)) {
    const steps = [...(group.install ? [{ run: group.install, env: {} }] : []), ...group.steps];
    const res = await withLane({ d, lane: group.lane, owner: { repo: r.repo, command: `deploy check ${group.name}`, log: logFile },
      fn: () => runSteps({ label: group.name, steps, cwd: join(wt, group.cwd), env: { ...group.env, ...group.stubEnv, SHIP_CHANGED_FILES: files.join('\n') }, logFile, timeoutMin: group.timeoutMin, out: d.out }) });
    if (!res.ok) {
      d.out(`✗ deploy-time check ${group.name} is red on ${r.mainBranch}@${t7(target)}; nothing deployed`);
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
      const subjects = (e.commits ?? (e.live.state === 'known' ? await commitsTouching(r.mirror, e.live.sha, target, e.dep.paths) : [])).map((c) => c.subject);
      note = prRefs(subjects);
      d.out(`▸ ${e.dep.name}: ${e.dep.mode} ${e.live.state === 'known' ? e.live.sha.slice(0, 7) : 'new'} → ${t7(target)}${note ? ` (${note})` : ''}`);
      res = await deployOne({ d, r, wt, dep: e.dep, entry: e, cf, creds, target, nonce, note, logFile, dryRun, readAt: (sha, p) => showFile(r.mirror, sha, p) });
    } catch (err) {
      // An interrupt ends the run (the caller reports it); it is not a failure of this deployable.
      if (err?.aborted || isInterrupted()) throw err;
      // Before any promote (deployOne turns later errors into a hold): this one failed, the run goes on.
      res = { outcome: 'failed', detail: `ship error: ${String(err.message).split('\n')[0]}` };
    }
    e.status = res.outcome;
    e.reason = res.outcome === 'deployed' ? `${res.versionId.slice(0, 8)} live at ${t7(target)}${note ? ` (${note})` : ''} · ${duration(Date.now() - started)}` : res.detail;
    d.out(`${ICON[e.status]} ${e.dep.name}: ${e.reason}`);
    const before = new Set(entries.filter((x) => x.status === 'skipped').map((x) => x.dep.name));
    propagate(entries, config.deployables);
    for (const x of entries.filter((y) => y.status === 'skipped' && !before.has(y.dep.name))) d.out(`! ${x.dep.name}: ${x.reason}`);
  }
  return summary(d, entries, dryRun);
}

// Fixes what the deploy ships, once it holds the slot it waited for. From the freeze on nobody
// joins it; then main is read again. If it moved, the deploy moves with it, unless that is not
// safe, and then it ships the head it planned and says why. Never past an uncleared migration.
// Returns the plan to go on with (the one it was given, or the one for the later main).
async function settle({ d, r, holder, s, names, redeploy, dryRun, lead }) {
  await lead.freeze();
  const skipped = new Set(s.entries.filter((x) => x.status === 'skipped').map((x) => x.dep.name));
  for (const e of await recheckHolds({ entries: s.entries, deployables: s.config.deployables, stateRoot: d.stateRoot, repo: r.repo })) {
    d.out(`${ICON[e.status]} ${e.dep.name}: ${e.reason}`);
  }
  for (const x of s.entries.filter((y) => y.status === 'skipped' && !skipped.has(y.dep.name))) d.out(`! ${x.dep.name}: ${x.reason}`);

  let fresh;
  try {
    fresh = await within(d.settleMs, syncMirror({ repo: r.repo, d }), `reading ${r.mainBranch} again`);
  } catch (e) {
    if (e?.aborted || isInterrupted()) throw e;
    lead.disown(); // whatever a follower merged since the plan may be in main, and this deploy cannot tell
    d.out(`! could not re-read ${r.mainBranch} (${firstLine(e.message)}): deploying ${r.mainBranch}@${t7(s.sha)} as planned`);
    return s;
  }
  if (fresh.mainSha === s.sha) return s;

  const keep = (why) => {
    lead.disown(); // main has what its followers merged, and this deploy does not ship it
    d.out(`! ${r.mainBranch} moved to ${t7(fresh.mainSha)} while the deploy waited, but ${why}: deploying ${r.mainBranch}@${t7(s.sha)} as planned`);
    return s;
  };
  let tree = null;
  try {
    if (!(await isAncestor(r.mirror, s.sha, fresh.mainSha))) return keep(`${t7(s.sha)} is not an ancestor of it`);
    const added = await commitsTouching(r.mirror, s.sha, fresh.mainSha, () => true);
    tree = await openTree({ d, r: fresh, sha: fresh.mainSha, label: 'd' });
    const verdict = await within(d.settleMs, judgeMove({ d, r, fresh, tree, s, names, redeploy }), 'judging the later head');
    if (verdict.why) return keep(verdict.why);
    // Nothing has run in the old tree yet; the new one is the deploy's from here.
    const old = holder.tree;
    holder.tree = tree;
    tree = null;
    await old.close().catch(() => {}); // its removal is retried by the final close
    d.out(`↻ ${r.mainBranch} moved while the deploy waited: ${t7(s.sha)} → ${t7(fresh.mainSha)} (${added.length} new commit(s)); the deploy moves with it`);
    d.out(headerLine(r, fresh.mainSha, dryRun));
    planLines(d, verdict.plan);
    return verdict.plan;
  } catch (e) {
    if (e?.aborted || isInterrupted()) throw e;
    return keep(`it could not be judged (${firstLine(e.message)})`);
  } finally {
    await tree?.close();
  }
}

// Whether the deploy may move to `fresh.mainSha` (whose tree is open): { plan } if so, else { why }.
// The deploy-time checks run after this, in the tree it ends up in, so they see the files it ships.
async function judgeMove({ d, r, fresh, tree, s, names, redeploy }) {
  const { config } = tree;
  if (config.deployables.length === 0) return { why: 'it has no deployables' };
  const problem = namesProblem(config, names);
  if (problem) return { why: `at that commit: ${problem}` };
  // The migration files of either head's config count: a later config that narrows or drops them
  // must not let files the planned one watched go through.
  const migrationPaths = [...(s.config.migrations?.paths ?? []), ...(config.migrations?.paths ?? [])];
  if (migrationPaths.length > 0) {
    const { unacked } = await unclearedMigrations({ d, r: fresh, config: { migrations: { paths: migrationPaths } }, sha: fresh.mainSha });
    if (unacked.length > 0) {
      return { why: `it brings migrations that are not cleared for deploy (${unacked.join(', ')}) — the owner clears them (ship migrations ${s.config.migrations?.apply || config.migrations?.apply ? 'apply' : 'ack'} …), and the next ship deploy carries them` };
    }
  }
  // A requirement the planned head already passed is not asked again; one the later head adds is.
  for (const req of config.requires) {
    if (s.config.requires.some((x) => x.repo === req.repo && x.deployable === req.deployable)) continue;
    const state = await requiredState({ d, req, floor: d.requiresFloors?.[req.repo] ?? null });
    if (state !== 'live') return { why: `it requires ${req.repo} ${req.deployable}: ${state}` };
  }
  const plan = await planAt({ d, r: fresh, tree, sha: fresh.mainSha, names, redeploy });
  // A hold and a block that were there already stopped the same deployable in the old plan.
  const stopped = new Set(s.entries.filter((e) => NOT_RUNNABLE.has(e.status)).map((e) => e.dep.name));
  const worse = plan.entries.filter((e) => e.selected && NOT_RUNNABLE.has(e.status) && !stopped.has(e.dep.name));
  if (worse.length > 0) return { why: worse.map((e) => `${e.dep.name} would be ${e.status} there (${e.reason})`).join('; ') };
  return { plan };
}

function summary(d, entries, dryRun = false) {
  const bad = entries.filter((e) => e.selected && !OK.has(e.status));
  const dry = dryRun && entries.some((e) => e.selected && e.status === 'dry-run');
  d.out(bad.length > 0
    ? `✗ ship deploy: ${bad.map((e) => `${e.dep.name} ${e.status}`).join(', ')}`
    : dry ? '✓ ship deploy --dry-run: every pending deployable built and passed its checks; nothing was uploaded'
      : '✓ ship deploy: everything selected is live');
  return bad.length > 0 ? 1 : 0;
}

// A deployable of another repository this one depends on must be live at that repository's main.
// With a `floor` (only ship land passes one: the required repository's main when the pull request
// merged) it must be live at that commit or past it instead, so a busy hour of merges there does
// not hold this deploy back. A floor is met when the deployable's files as of the floor are live,
// even if the live commit is older than the floor.
export async function requiredState({ d, req, floor = null }) {
  const r = await syncMirror({ repo: req.repo, d });
  const tree = await openTree({ d, r, sha: r.mainSha, label: 'q' });
  try {
    const dep = tree.config.deployables.find((x) => x.name === req.deployable);
    if (!dep) return `no deployable ${req.deployable} in its ship.config.mjs`;
    const { cf } = await cloudflareFor(d, tree.config.credentials);
    const [e] = await planDeploy({ r, config: { ...tree.config, deployables: [{ ...dep, after: [] }] }, selected: new Set([dep.name]), target: r.mainSha, cf, stateRoot: d.stateRoot });
    if (floor === null) return e.status === 'live' ? 'live' : `${e.status} (${e.reason})`;
    if (e.status === 'held' || e.status === 'blocked') return `${e.status} (${e.reason})`;
    if (e.live.state !== 'known') return e.live.state === 'none' ? 'not deployed yet' : `live unknown (${e.live.reason})`;
    if (!(await hasCommit(r.mirror, floor))) return `${floor.slice(0, 7)} is not in ${req.repo}`;
    if (!(await isAncestor(r.mirror, floor, r.mainSha))) return `${floor.slice(0, 7)} is not on the main of ${req.repo}`;
    if (await isAncestor(r.mirror, floor, e.live.sha)) return 'live';
    // Later commits that leave the deployable's files alone keep its live commit behind the floor:
    // what the floor has of it is live when nothing it changed since is pending.
    const [atFloor] = await planDeploy({ r, config: { ...tree.config, deployables: [{ ...dep, after: [] }] }, selected: new Set([dep.name]), target: floor, cf, stateRoot: d.stateRoot });
    return atFloor.status === 'live' ? 'live' : `live at ${e.live.sha.slice(0, 7)}, before ${floor.slice(0, 7)}`;
  } finally {
    await tree.close();
  }
}

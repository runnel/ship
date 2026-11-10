import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { addedIn, changedFiles, commitTimeMs, commitsTouching, hasCommit, isAncestor, listTree, mirrorPath } from './git.mjs';
import { matchesAny, pendingFile } from './glob.mjs';
import { ownerInfo, tryLock } from './lock.mjs';
import { openTree, prRefs, syncMirror } from './repo.mjs';
import { cloudflareFor } from './cloudflare.mjs';
import { planDeploy } from './plan.mjs';
import { localTime, timeOr } from './report.mjs';
import { readAcks, readHold } from './state.mjs';
import { unclearedMigrations } from './deploy.mjs';
import { clearHint, firstLine } from './shared.mjs';
import { isInterrupted } from './interrupt.mjs';
import { iso, landDir, lineEmpty, lineState, readJson, writeJsonAtomic } from './land-line.mjs';
import { deployRunning, readDeploys } from './land-deploy.mjs';

// What a merge brings, read from the merge commit itself: its config, the deployables it touches (a
// pending file in the merge commit's own diff) and the migration files it adds.
export async function landedChanges({ d, r, mergeSha }) {
  const tree = await openTree({ d, r, sha: mergeSha, label: 'l' });
  try {
    const { config } = tree;
    const files = await changedFiles(r.mirror, `${mergeSha}^`, mergeSha);
    const touched = config.deployables.filter((dep) => files.some(pendingFile(dep, config.docsOnly))).map((dep) => dep.name);
    let added = [];
    if (config.migrations) {
      const present = new Set(await listTree(r.mirror, mergeSha));
      added = files.filter((f) => matchesAny(f, config.migrations.paths) && present.has(f));
    }
    return { config, touched, added };
  } finally {
    await tree.close();
  }
}

// What is live in a repository, for every land that waits there: one file, refreshed by whichever
// land holds the small refresh lock, and read by the others. A poll makes no Cloudflare calls of its
// own: reading a repository's deployables costs dozens of paginated API calls.
const cacheFile = (d, repo) => join(landDir(d, repo), 'live.json');

export const readLiveCache = (d, repo) => readJson(cacheFile(d, repo));

// When the oldest commit on main that a deployable has not shipped was made: the deploy deadline
// counts from it. Only a deployable the plan calls pending counts. One a deploy would not run (held,
// blocked, or skipped because it waits for one that is) has a backlog that waits for the owner, and
// counting it would put every deadline in the past while that lasts. One the plan calls live has
// commits but nothing to ship (a change and its revert): the plan judges by the tree, not the commits.
async function oldestUnlive({ r, config, entries }) {
  let oldest = null;
  for (const e of entries) {
    if (e.live.state !== 'known' || e.status !== 'pending' || !(await hasCommit(r.mirror, e.live.sha))) continue;
    const pending = await commitsTouching(r.mirror, e.live.sha, r.mainSha, pendingFile(e.dep, config.docsOnly));
    if (pending.length === 0) continue;
    const at = await commitTimeMs(r.mirror, pending.at(-1).sha);
    oldest = oldest === null ? at : Math.min(oldest, at);
  }
  return oldest;
}

export async function refreshLiveCache({ d, repo }) {
  const release = await tryLock(join(landDir(d, repo), 'refresh'), await ownerInfo({ repo, command: 'land live read' }));
  if (!release) return null;
  try {
    // Stamped before anything is read: a refresh that was under way when a deploy ended may show what
    // was live before it, so it must count as older than that end.
    const readAt = new Date(d.now()).toISOString();
    const r = await syncMirror({ repo, d });
    const tree = await openTree({ d, r, sha: r.mainSha, label: 'v' });
    try {
      const { config } = tree;
      const deployables = {};
      let entries = [];
      if (config.deployables.length > 0) {
        const { cf } = await cloudflareFor(d, config.credentials);
        entries = await planDeploy({ r, config, selected: new Set(config.deployables.map((x) => x.name)), target: r.mainSha, cf, stateRoot: d.stateRoot, wt: tree.wt });
        for (const e of entries) deployables[e.dep.name] = { state: e.live.state, sha: e.live.sha ?? null, status: e.status, reason: e.live.reason ?? null };
      }
      const cache = { readAt, mainSha: r.mainSha, oldestUnliveAtMs: await oldestUnlive({ r, config, entries }), deployables };
      await writeJsonAtomic(cacheFile(d, repo), cache);
      return cache;
    } finally {
      await tree.close();
    }
  } finally {
    await release();
  }
}

// The cache, read again first when it is older than `liveCacheMs` or than `staleBeforeMs` (a deploy
// that ended after it was read). A refresh another land is making is not waited for: an old file
// will do, unless it was read before `staleBeforeMs`: judging by what was live before a deploy would
// call a deploy that worked a failure. Then the caller's tick waits (`notYet`).
export async function liveFor({ d, repo, staleBeforeMs = 0 }) {
  const cache = await readLiveCache(d, repo);
  const readAt = cache ? Date.parse(cache.readAt) : -Infinity;
  if (readAt >= staleBeforeMs && d.now() - readAt < d.liveCacheMs) return cache;
  const fresh = await refreshLiveCache({ d, repo });
  if (fresh) return fresh;
  const current = await readLiveCache(d, repo);
  if (current && Date.parse(current.readAt) >= staleBeforeMs) return current;
  const why = current ? 'is being read again after a deploy' : 'has not been read yet';
  throw Object.assign(new Error(`what is live in ${repo} ${why}; waiting for it`), { notYet: true });
}

// Whether `sha` has `ancestor` in its history. A commit the mirror lacks (main's newest, deployed by
// another land since this one fetched) is fetched for once.
export async function contains({ d, repo, mirror, ancestor, sha }) {
  if (!(await hasCommit(mirror, sha))) await syncMirror({ repo, d });
  if (!(await hasCommit(mirror, sha)) || !(await hasCommit(mirror, ancestor))) return false;
  return isAncestor(mirror, ancestor, sha);
}

// What a land does at one tick after its merge (spec §7), from what it found out (`facts`), in the
// spec's order. Pure: everything it needs is in its arguments. `facts.deployedOk` is `{ tip }` of the
// newest deploy that ended with code 0, or null. The land waits for the live cache only when that tip
// is `facts.tip`, the current main tip; an ok deploy of any other tip says nothing about this merge,
// so `gather` must pass the tip the deploy record names and must not filter it by time alone.
// `facts.oldestUnliveAtMs` null means no backlog: the deadline then counts from `facts.tipAtMs`.
export function decide({ facts, pr, mergeSha, touched, added, land, nowMs, quietSinceMs }) {
  const m7 = mergeSha.slice(0, 7);
  const isLive = (n) => facts.live[n]?.contains === true && !facts.live[n].blocked && !facts.holds[n];
  if (touched.every(isLive) && facts.uncleared.length === 0) {
    const what = [...touched.map((n) => `${n} at ${facts.live[n].sha.slice(0, 7)}`), ...(added.length ? [`${added.length} migration(s) cleared`] : [])];
    return { done: 0, line: `✓ PR #${pr} is live (merged as ${m7}): ${what.join(', ')}` };
  }
  const notLive = `✗ PR #${pr} merged as ${m7} but not live:`;
  // A deploy that ended, not 0, for a tip with this merge: nobody starts another for that tip.
  if (facts.failed) return { done: 3, line: `${notLive} the deploy of main@${facts.failed.tip.slice(0, 7)} ended with exit ${facts.failed.code} (output: ${facts.failed.log}) — the owner decides; ship status` };
  if (facts.tipUncleared.length > 0) return { wait: 'migration' };
  const held = touched.find((n) => facts.holds[n]);
  if (held) return { done: 3, line: `${notLive} ${held} is held since ${timeOr(facts.holds[held].at)}: ${facts.holds[held].reason} — the owner decides; ship status` };
  const unmet = facts.requires.find((q) => !q.met);
  if (unmet) return { wait: 'requires', line: `… waiting for ${unmet.repo} ${unmet.deployable} to be live at or past ${unmet.floor.slice(0, 7)} (${unmet.now})` };
  if (facts.deployRunning) return { wait: 'deploying', line: '… a deploy of this repository is running; waiting for it to end' };
  if (facts.deployedOk?.tip === facts.tip) return { wait: 'live', line: `… the deploy of main@${facts.deployedOk.tip.slice(0, 7)} ended ok; waiting for it to show as live` };
  const quiet = facts.lineEmpty && nowMs - Math.max(facts.tipAtMs, quietSinceMs) >= land.debounceSec * 1000;
  if (quiet) return { deploy: true, why: `the land line has been quiet for ${land.debounceSec} s` };
  const deadline = (facts.oldestUnliveAtMs ?? facts.tipAtMs) + land.deployAfterMin * 60_000;
  if (nowMs >= deadline) return { deploy: true, why: `a merge has waited ${land.deployAfterMin} min` };
  return { wait: 'debounce', line: `… merged as ${m7}; the deploy starts once the land line has been quiet for ${land.debounceSec} s, or by ${localTime(new Date(deadline).toISOString())}` };
}

// The floors a land recorded at its merge, one file per merge commit: a deploy of a tip carries every
// merge below it, so it must meet the newest floor among them, not only the floor of the land that
// happens to start it. Records older than a day decide nothing any more and are removed.
const floorsDir = (d, repo) => join(landDir(d, repo), 'floors');
const FLOORS_KEEP_MS = 24 * 60 * 60_000;

export async function recordFloors({ d, repo, mergeSha, floors }) {
  await writeJsonAtomic(join(floorsDir(d, repo), `${mergeSha}.json`), { mergeSha, floors, at: iso(d) });
}

// Per required repository, the newest floor among the recorded merges that `tip` carries, and this
// land's own. Newest is the one the others are ancestors of; floors that diverge (a force-push) go to
// the later record, so the pick is the same whichever land looks.
async function combinedFloors({ d, repo, tip, mirror, own }) {
  const dir = floorsDir(d, repo);
  const records = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const rec = await readJson(join(dir, name));
    if (!rec) continue;
    if (d.now() - Date.parse(rec.at) > FLOORS_KEEP_MS) await rm(join(dir, name), { force: true });
    else records.push(rec);
  }
  if (!records.some((x) => x.mergeSha === own.mergeSha)) records.push({ ...own, at: iso(d) });
  records.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const out = {};
  for (const rec of records) {
    if (!(await contains({ d, repo, mirror, ancestor: rec.mergeSha, sha: tip }))) continue;
    for (const [req, floor] of Object.entries(rec.floors ?? {})) {
      if (!floor) continue;
      if (!out[req] || !(await contains({ d, repo: req, mirror: mirrorPath(req, d.mirrorRoot), ancestor: floor, sha: out[req] }))) out[req] = floor;
    }
  }
  return out;
}

// The floor of each requirement, read before the merge while the land holds the slot: the required
// repositories' main now (spec §7.4). The requirements of main and of the head are both read, as the
// merged config is not known yet. Throws when one cannot be read: then nothing is merged.
export async function requiredFloors({ d, r, head }) {
  const repos = new Set();
  for (const sha of [r.mainSha, head]) {
    const tree = await openTree({ d, r, sha, label: 'f' });
    try {
      for (const req of tree.config.requires) repos.add(req.repo);
    } finally {
      await tree.close();
    }
  }
  const floors = {};
  for (const repo of [...repos].sort()) floors[repo] = (await syncMirror({ repo, d })).mainSha;
  return floors;
}

// A land with no floor for a required repository (none recorded) holds it to the required
// repository's main now: the strict rule.
const floorOf = async ({ d, req, floors }) => floors[req.repo] ?? (await syncMirror({ repo: req.repo, d })).mainSha;

// Spec §7.4: the required deployable live at or past the floor (the required repository's main when
// this PR merged), read from that repository's own live cache.
async function requirement({ d, req, floor }) {
  const base = { repo: req.repo, deployable: req.deployable, floor };
  const cache = await liveFor({ d, repo: req.repo });
  const e = cache.deployables[req.deployable];
  if (!e) return { ...base, met: false, now: `no deployable ${req.deployable} there` };
  const hold = await readHold(d.stateRoot, req.repo, req.deployable);
  if (hold) return { ...base, met: false, now: `held: ${hold.reason}` };
  if (e.state !== 'known') return { ...base, met: false, now: e.state === 'none' ? 'not deployed yet' : 'live unknown' };
  const met = await contains({ d, repo: req.repo, mirror: mirrorPath(req.repo, d.mirrorRoot), ancestor: floor, sha: e.sha });
  return { ...base, met, now: `live at ${e.sha.slice(0, 7)}` };
}

// Everything one tick decides on (see decide), from the mirror, the state on disk and the live
// caches. No Cloudflare call unless a cache is due for a refresh. `seen` is this land's memory across
// ticks: whether a deploy ran at the last tick, and when it saw one end. A deploy ship land did not
// start (a manual ship deploy) leaves no record; the deploy lock going free is how its end is seen.
async function gather({ d, repo, pr, mergeSha, mergedAtMs, changes, floors, seen }) {
  const { config, touched, added } = changes;
  const r = await syncMirror({ repo, d });
  const has = (ancestor, sha) => contains({ d, repo, mirror: r.mirror, ancestor, sha });
  const deploys = await readDeploys({ d, repo });
  const running = await deployRunning({ d, repo });
  const recordEnd = Math.max(-Infinity, ...deploys.ended.map((x) => Date.parse(x.endedAt)).filter(Number.isFinite));
  // A deploy that ended without a record (a manual ship deploy) is seen as the lock going free. When a
  // record ended since the last tick, its own time is the end, so lands do not all refresh the cache.
  if (seen.running && !running && !(recordEnd > seen.recordEndMs)) seen.endedAtMs = d.now();
  seen.running = running;
  seen.recordEndMs = recordEnd;
  // What is live is judged only by a cache read at or after the latest deploy end this land knows of.
  const lastEnd = Math.max(seen.endedAtMs, recordEnd);
  const cache = await liveFor({ d, repo, staleBeforeMs: lastEnd });
  // A change with no net effect (a change and its revert) leaves the live commit where it was: the
  // plan calls it live, and a cache planned against a main that has the merge says so.
  const cacheSawMerge = await has(mergeSha, cache.mainSha);
  const live = {};
  const holds = {};
  for (const name of touched) {
    const e = cache.deployables[name];
    if (e?.state === 'known') {
      const byAncestry = await has(mergeSha, e.sha);
      live[name] = { sha: e.sha, blocked: e.status === 'blocked', contains: byAncestry || (e.status === 'live' && cacheSawMerge) };
    } else {
      live[name] = { sha: null, blocked: false, contains: false };
    }
    const hold = await readHold(d.stateRoot, repo, name);
    if (hold) holds[name] = hold;
  }
  const acked = await readAcks(d.stateRoot, repo);
  let migrations = [];
  const tipUncleared = [];
  if (config.migrations) {
    const u = await unclearedMigrations({ d, r, config, sha: r.mainSha });
    migrations = u.migrations;
    for (const file of u.unacked) {
      const ours = added.includes(file);
      tipUncleared.push({ file, ours, by: ours ? `#${pr}` : (prRefs([(await addedIn(r.mirror, r.mainSha, file))?.subject ?? '']) || null) });
    }
  }
  const requires = [];
  for (const req of config.requires) requires.push(await requirement({ d, req, floor: await floorOf({ d, req, floors }) }));
  // Only a deploy that ended after this merge can have been meant to ship it; one that stopped at a
  // migration nobody had cleared is the migration gate's, not a failure.
  let failed = null;
  let deployedOk = null;
  for (const x of deploys.ended) {
    if (x.code === 0) {
      if (x.tip === r.mainSha) deployedOk = { tip: x.tip };
    } else if (!x.migrationsWaiting && Date.parse(x.endedAt) >= mergedAtMs && (await has(mergeSha, x.tip))) {
      failed = x;
    }
  }
  return {
    tip: r.mainSha, live, holds, uncleared: added.filter((f) => !acked.has(f)), tipUncleared, migrations, requires,
    deployRunning: running,
    failed,
    deployedOk,
    lineEmpty: lineEmpty(await lineState(d, repo)),
    tipAtMs: await commitTimeMs(r.mirror, r.mainSha),
    // The deadline counts from the older of this merge and the oldest pending backlog (never
    // Math.min(x, null), which is 0).
    oldestUnliveAtMs: Math.min(mergedAtMs, cache.oldestUnliveAtMs ?? Infinity),
  };
}

// Starts the deploy, unless another land is deciding right now (it starts one, or has), a deploy runs,
// or one ended for this tip already (ok: it is shipped, failed: the owner decides). The deploy is given
// the newest floor of every merge it carries, and waits when one of them is not met.
async function maybeDeploy({ d, repo, cwd, tip, mergeSha, floors, config, say, why }) {
  const release = await tryLock(join(landDir(d, repo), 'deciding'), await ownerInfo({ repo, command: 'land deploy decision' }));
  if (!release) return;
  try {
    if (await deployRunning({ d, repo })) return;
    if ((await readDeploys({ d, repo })).ended.some((x) => x.tip === tip && (x.code === 0 || !x.migrationsWaiting))) return;
    const carried = await combinedFloors({ d, repo, tip, mirror: mirrorPath(repo, d.mirrorRoot), own: { mergeSha, floors } });
    for (const req of config.requires) {
      const q = await requirement({ d, req, floor: await floorOf({ d, req, floors: carried }) });
      if (!q.met) {
        say(`… waiting for ${q.repo} ${q.deployable} to be live at or past ${q.floor.slice(0, 7)} (${q.now}) before deploying main@${tip.slice(0, 7)}, which carries a merge that needs it`);
        return;
      }
    }
    d.out(`▸ deploying ${repo} main@${tip.slice(0, 7)} (${why}), detached`);
    const started = await d.startDeploy({ d, repo, cwd, tip, floors: { ...floors, ...carried } });
    d.out(`  its output: ${started.log}`);
  } finally {
    await release();
  }
}

// The PR that added a migration says how to clear it; every other land says what it waits for.
function sayMigrations({ say, facts, pr, apply }) {
  const ours = facts.tipUncleared.filter((x) => x.ours).map((x) => x.file);
  if (ours.length > 0) {
    say(`! PR #${pr} added migration(s) not cleared for deploy: ${ours.join(', ')}; ship land waits until they are`);
    for (const line of clearHint(ours, facts.migrations, apply)) say(line);
  }
  for (const x of facts.tipUncleared.filter((y) => !y.ours)) say(`… waiting for migration ${x.file} (${x.by ?? 'no PR number'})`);
}

// Spec §7: after the merge, every `liveTickMs` until the PR is live (0) or cannot be (3).
export async function waitLive({ d, repo, cwd, pr, mergeSha, mergedAtMs, changes, floors = {} }) {
  const { config } = changes;
  const said = new Set();
  const say = (line) => {
    if (said.has(line)) return;
    said.add(line);
    d.out(line);
  };
  let busySeenMs = 0;
  const seen = { running: false, endedAtMs: 0 };
  for (;;) {
    let stage = 'could not read what is live';
    try {
      const facts = await gather({ d, repo, pr, mergeSha, mergedAtMs, changes, floors, seen });
      stage = 'could not decide or start the deploy';
      if (!facts.lineEmpty) busySeenMs = d.now();
      const next = decide({ facts, pr, mergeSha, touched: changes.touched, added: changes.added, land: config.land, nowMs: d.now(), quietSinceMs: busySeenMs });
      if (next.done !== undefined) {
        d.out(next.line);
        return next.done;
      }
      if (next.wait === 'migration') sayMigrations({ say, facts, pr, apply: config.migrations?.apply ?? null });
      else if (next.deploy) await maybeDeploy({ d, repo, cwd, tip: facts.tip, mergeSha, floors, config, say, why: next.why });
      else say(next.line);
    } catch (e) {
      if (e?.aborted || isInterrupted()) throw e;
      say(`! ${stage} (${firstLine(e.message)}); trying again every ${d.liveTickMs / 1000} s`);
    }
    if (d.now() - mergedAtMs >= config.land.liveWaitHours * 3_600_000) {
      d.out(`✗ PR #${pr} merged as ${mergeSha.slice(0, 7)} but not live after ${config.land.liveWaitHours} h — ship status`);
      return 3;
    }
    await d.sleep(d.liveTickMs);
  }
}

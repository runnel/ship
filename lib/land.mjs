import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkDeps, checkOnce, readResult, settleHead, writeResult } from './check.mjs';
import { commitStatus, cutDescription, defaultBranch, mergedSha, prInfo } from './github.mjs';
import { judgeLandStatus, parseChecked, squashMerge } from './merge.mjs';
import { deployDeps, repoFromCwd, syncMirror } from './repo.mjs';
import { ownerInfo } from './lock.mjs';
import { abortedError, firstLine, LANE_PRIORITY, lockWithCleanup, lockWithin, once, ordinal, repoKeyOf } from './shared.mjs';
import { keepAwake } from './power.mjs';
import { isInterrupted, onInterrupt } from './interrupt.mjs';
import { capture } from './proc.mjs';
import { ensureMirror, fetchCommit, hasCommit, isAncestor } from './git.mjs';
import { watchDoomed, whyDoomed } from './doomed.mjs';
import { ensurePrivateDir } from './paths.mjs';
import { localTime } from './report.mjs';
import { alreadyLanding, headLockDir, iso, slotDir } from './land-line.mjs';
export { iso };
import { landedChanges, waitLive } from './land-live.mjs';
import { startDetachedDeploy } from './land-deploy.mjs';

// The deps of a land: a check's and a deploy's, and the limits a land keeps while it holds the slot,
// so that nothing it waits for can freeze the line.
export function landDeps() {
  return {
    ...checkDeps(),
    ...deployDeps(),
    ghTimeoutMs: 60_000,
    fetchTimeoutMs: 120_000,
    mergeTimeoutMs: 60_000,
    mergeReadForMs: 120_000, // after gh pr merge failed: how long the PR is read for the outcome
    mergeShaWaitMs: 120_000, // after the merge: how long GitHub may take to name the merge commit
    mirrorWaitMs: 120_000, // and the mirror to show it on main
    mergePollMs: 5000,
    maxRechecks: 2, // checks again after main moved outside the queue, then gives up
    lockWaitMs: 5 * 60_000, // the longest a land waits for the mirror or merge lock (then exit 4)
    liveCacheMs: 5 * 60_000, // the live cache is read again after this long
    liveTickMs: 30_000, // how often a merged land looks at what is live
    startDeploy: (args) => startDetachedDeploy(args),
    keepAwake: () => keepAwake(),
  };
}

// A green result is reused only when ship's own result for exactly this head and main is green and
// GitHub still shows that same success on the head. Anything else is checked again. GitHub keeps a
// description to 140 characters, so the result's description is compared as GitHub stores it.
export function reusable({ cached, status, mainSha }) {
  if (!cached || cached.state !== 'success' || cached.exitCode !== 0 || cached.mainSha !== mainSha) return false;
  if (!status || status.state !== 'success' || status.bot || status.description !== cutDescription(String(cached.description ?? ''))) return false;
  const checked = parseChecked(status.description);
  return checked !== null && mainSha.startsWith(checked.sha);
}

// The land's check of the head merged with `mainSha`: a reused green, or a fresh land check.
// → { ok: true } | { code, line? } (1 red, 2 a conflict or stopped by the PR, 4 an error)
async function checkAt({ d, repo, info, main, mainSha, mirror }) {
  const cached = await readResult(d, repo, info.headSha);
  const status = cached ? await commitStatus({ repo, sha: info.headSha, gh: d.gh, timeoutMs: d.ghTimeoutMs }) : null;
  if (reusable({ cached, status, mainSha })) {
    d.out(`✓ local-ci success: ${cached.description} (reused: this head was checked against this main)`);
    return { ok: true };
  }
  const awake = d.keepAwake();
  let result;
  try {
    result = await checkOnce({ d, repo, info, main, mainSha, mirror, land: true });
  } finally {
    awake.stop();
  }
  await writeResult(d, repo, info.headSha, result, mainSha);
  const n = info.number;
  if (isInterrupted()) throw abortedError(); // first: an interrupt never goes on to merge; the CLI makes it 130
  if (result.state === 'success') return { ok: true };
  if (result.state === 'stopped') return { code: 2, line: `✗ not landing PR #${n}: ${result.description}` };
  if (result.conflict) return { code: 2, line: `✗ not landing PR #${n}: a merge conflict with ${main}@${mainSha.slice(0, 7)}; merge ${main} into the branch, push, and land again` };
  if (result.state === 'failure') return { code: 1 };
  return { code: 4, line: `✗ PR #${n} not merged: ${result.description}; landing again is safe` };
}

// Says so when the pull request is no longer open at the head that was checked, or no longer aimed at
// `main` (a read of it just made); true when it did.
function movedOn(d, info, main, now) {
  const n = info.number;
  if (now.state !== 'OPEN') {
    d.out(`✗ not landing PR #${n}: it is ${String(now.state).toLowerCase()}`);
    return true;
  }
  if (now.base !== main) {
    d.out(`✗ not landing PR #${n}: it now targets ${now.base}; only PRs into ${main} are landed`);
    return true;
  }
  if (now.headSha !== info.headSha) {
    d.out(`✗ not landing PR #${n} @ ${info.headSha.slice(0, 7)}: a new head ${now.headSha.slice(0, 7)} was pushed; land that one`);
    return true;
  }
  return false;
}

// What a failed gh pr merge means for the land: 5 unknown, 2 the PR moved on, 4 still open.
function mergeFailure(d, info, main, res) {
  const n = info.number;
  const noAnswer = `no answer within ${d.mergeTimeoutMs / 1000}s`;
  if (!res.now) {
    d.out(`✗ PR #${n}: the merge outcome is unknown: gh pr merge failed (${res.killed ? noAnswer : res.why}) and the PR could not be read — check gh pr view ${n}`);
    return 5;
  }
  if (movedOn(d, info, main, res.now)) return 2;
  d.out(`✗ PR #${n} not merged: gh pr merge ${res.killed ? `gave ${noAnswer}` : `refused (${res.why})`} and the PR is still open; landing again is safe`);
  return 4;
}

// Under the merge lock: main must still be the commit that was checked, the PR still open at the
// checked head, its local-ci that check's success; then the merge, pinned to that same head.
// → { moved: <new main> } (check again), { code }, or { merged: { sha, mainSha } }.
async function premerge({ d, repo, info, main, mainSha, keepBranch, rechecks }) {
  const n = info.number;
  const headSha = info.headSha;
  const release = await lockWithin(join(d.tmpRoot, 'locks', `merge-${repoKeyOf(repo)}`), await ownerInfo({ repo, pr: n, land: true }), {
    pollMs: d.pollMs,
    waitMs: d.lockWaitMs,
    what: `the merge lock of ${repo}`,
    onWait: once(() => d.out(`… a ship merge of ${repo} is running — waiting for it`)),
  });
  try {
    const tip = (await syncMirror({ repo, d, mainBranch: main })).mainSha;
    if (tip !== mainSha) {
      if (rechecks >= d.maxRechecks) {
        d.out(`✗ not landing PR #${n}: ${main} kept moving outside the queue (now ${main}@${tip.slice(0, 7)} after ${rechecks} more checks); land again`);
        return { code: 2 };
      }
      d.out(`! ${main} moved outside the queue (${mainSha.slice(0, 7)} → ${tip.slice(0, 7)}): checking again against it`);
      return { moved: tip };
    }
    const now = await prInfo({ repo, pr: String(n), gh: d.gh, timeoutMs: d.ghTimeoutMs });
    if (movedOn(d, info, main, now)) return { code: 2 };
    // The status is read at the head the merge is pinned to.
    const verdict = judgeLandStatus(await commitStatus({ repo, sha: headSha, gh: d.gh, timeoutMs: d.ghTimeoutMs }), { pr: n, headSha, main, mainSha });
    if (!verdict.ok) {
      d.out(`✗ PR #${n} not merged: ${verdict.reason}`); // the reason ends "run ship land --pr <n>"
      return { code: 4 };
    }
    const res = await squashMerge({ d, repo, number: n, headSha, keepBranch, readForMs: d.mergeReadForMs, readEveryMs: d.mergePollMs });
    if (!res.merged) return { code: mergeFailure(d, info, main, res) };
    if (res.now && res.now.headSha !== headSha) {
      // gh failed, and the PR shows as merged at another head: that merge is not this land's.
      d.out(`✗ not landing PR #${n} @ ${headSha.slice(0, 7)}: it was merged by someone else at ${res.now.headSha.slice(0, 7)}`);
      return { code: 2 };
    }
    if (res.why !== null) d.out(`! gh reported ${res.killed ? `no answer after ${d.mergeTimeoutMs / 1000}s` : res.why}, but PR #${n} is merged`);
    return { merged: { sha: res.sha, mainSha } };
  } finally {
    await release();
  }
}

// What a land does while it holds the slot (spec §6): check (or reuse) against the main of the moment,
// then merge if main is still that commit, else check again, at most `maxRechecks` more times.
export async function landInSlot({ d, repo, info, main, mirror, keepBranch = false }) {
  try {
    let mainSha = (await syncMirror({ repo, d, mainBranch: main })).mainSha;
    for (let rechecks = 0; ; rechecks++) {
      const checked = await checkAt({ d, repo, info, main, mainSha, mirror });
      if (!checked.ok) {
        if (checked.line) d.out(checked.line);
        return { code: checked.code };
      }
      const pre = await premerge({ d, repo, info, main, mainSha, keepBranch, rechecks });
      if (!pre.moved) return pre;
      mainSha = pre.moved;
    }
  } catch (e) {
    if (e?.aborted || isInterrupted()) throw e;
    d.out(`✗ PR #${info.number} not merged: ${firstLine(e.message)}; landing again is safe`);
    return { code: 4 };
  }
}

// One line per land in `~/.ship/land/<owner>__<repo>.jsonl` (durable state, not the logs, which are
// pruned after 14 days), to compare the line's waits and outcomes with what came before: every land
// writes one, whatever its outcome (a refusal, an error, an interrupt). Lines are only appended; a
// reader skips a line it cannot parse; nothing rotates the file. A land with no repository (it could
// not be read from the clone) writes to `unknown.jsonl`. Losing a line loses nothing else.
async function recordLanding(d, repo, entry) {
  try {
    const dir = join(d.stateRoot, 'land');
    await ensurePrivateDir(dir);
    await appendFile(join(dir, `${repo ? repoKeyOf(repo) : 'unknown'}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (e) {
    d.out(`! could not write the land ledger: ${firstLine(e.message)}`);
  }
}

// Whether the ledger can be written, said at the start so that the warning does not come after the
// land's last line (which names the PR and the merge commit). → false (and told) when it cannot.
async function ledgerWritable(d) {
  try {
    await ensurePrivateDir(join(d.stateRoot, 'land'));
    return true;
  } catch (e) {
    d.out(`! could not write the land ledger: ${firstLine(e.message)}`);
    return false;
  }
}

// The wait in the land line: said when it starts, when the place changes, and once a minute.
function lineReporter(d, repo) {
  let said = { position: 0, at: 0 };
  return (holder, line) => {
    const position = line?.position ?? 0;
    if (position === said.position && Date.now() - said.at < 60_000) return;
    said = { position, at: Date.now() };
    const who = holder ? `PR #${holder.pr ?? '?'} @ ${String(holder.headSha ?? '').slice(0, 7)} has the slot since ${holder.since ? localTime(holder.since) : '?'}` : 'the slot is changing hands';
    d.out(`… waiting in the land line of ${repo}${line ? ` (${ordinal(line.position)} in line)` : ''}: ${who}`);
  };
}

// The pull request as ship check resolves it, with its head in the mirror. → { info, main, mirror } or { code: 2 }.
async function prepare({ d, repo, ref }) {
  const refuse = (why) => { d.out(`✗ not landing: ${why}`); return { code: 2 }; };
  let info = await prInfo({ repo, pr: ref, gh: d.gh, timeoutMs: d.ghTimeoutMs });
  if (info.fork) return refuse(`PR #${info.number} comes from a fork — ship never merges another account's code`);
  if (info.state !== 'OPEN') return refuse(`PR #${info.number} is ${String(info.state).toLowerCase()}`);
  const main = await defaultBranch({ repo, gh: d.gh, timeoutMs: d.ghTimeoutMs });
  if (info.base !== main) return refuse(`PR #${info.number} targets ${info.base}; only PRs into ${main} are landed`);
  const releaseMirror = await lockWithin(join(d.tmpRoot, 'locks', `mirror-${repoKeyOf(repo)}`), await ownerInfo({ repo }), {
    pollMs: d.pollMs, waitMs: d.lockWaitMs, what: `the mirror lock of ${repo}`,
  });
  let mirror;
  try {
    mirror = await ensureMirror(repo, { root: d.mirrorRoot, url: d.remoteUrl(repo), fetchTimeoutMs: d.fetchTimeoutMs });
    await fetchCommit(mirror, info.headSha, info.number, { timeoutMs: d.fetchTimeoutMs });
  } finally {
    await releaseMirror();
  }
  const settled = await settleHead({ d, repo, ref, info, mirror });
  if (settled.lagging) return refuse(`GitHub still shows ${info.headSha.slice(0, 7)} as the head of #${info.number} after ${d.headWaitMs / 1000} s, the branch is at ${settled.tip.slice(0, 7)}; land again in a minute`);
  info = settled.info;
  return { info, main, mirror };
}

// GitHub can take a moment to name the merge commit, and the mirror to show it. The slot is given up
// once the mirror's main contains it, so that the next land checks against a main that has it.
async function seeMerge({ d, repo, main, number, sha }) {
  const named = Date.now();
  while (!sha && Date.now() - named < d.mergeShaWaitMs) {
    await d.sleep(d.mergePollMs);
    sha = await mergedSha({ repo, pr: number, gh: d.gh, timeoutMs: d.ghTimeoutMs }).catch(() => null);
  }
  if (!sha) return { sha: null, r: null, seen: false }; // nothing to wait for the mirror to show: do not hold the slot
  const until = Date.now() + d.mirrorWaitMs;
  for (;;) {
    const r = await syncMirror({ repo, d, mainBranch: main }).catch(() => null);
    if (r && (await hasCommit(r.mirror, sha)) && (await isAncestor(r.mirror, sha, r.mainSha))) return { sha, r, seen: true };
    if (Date.now() >= until) return { sha, r, seen: false };
    await d.sleep(d.mergePollMs);
  }
}

// After the merge (spec §7): a PR that touches no deployable and adds no migration is done.
// Otherwise it waits until the merge is live, starting the deploy when that is due.
async function afterMerge({ d, repo, cwd, info, seen, mergedAtMs }) {
  const n = info.number;
  if (!seen.sha) {
    d.out(`✗ PR #${n} merged, but GitHub has not named the merge commit after ${d.mergeShaWaitMs / 1000} s: ship land cannot tell when it is live — ship status`);
    return 3;
  }
  const m7 = seen.sha.slice(0, 7);
  if (!seen.seen) {
    d.out(`✗ PR #${n} merged as ${m7}, but the mirror does not show it on main after ${d.mirrorWaitMs / 1000} s: ship land cannot tell when it is live — ship status`);
    return 3;
  }
  const changes = await landedChanges({ d, r: seen.r, mergeSha: seen.sha });
  if (changes.touched.length === 0 && changes.added.length === 0) {
    d.out(`✓ PR #${n} landed as ${m7}: it touches no deployable and adds no migration, so it is done at the merge`);
    return 0;
  }
  // The floor of each requirement: the required repository's main at this merge (spec §7.4).
  const floors = {};
  for (const req of changes.config.requires) floors[req.repo] = (await syncMirror({ repo: req.repo, d })).mainSha;
  d.out(`▸ PR #${n} merged as ${m7}; waiting until it is live (${[...changes.touched, ...changes.added].join(', ')})`);
  return await waitLive({ d, repo, cwd, pr: n, mergeSha: seen.sha, mergedAtMs, changes, floors });
}

async function land({ d, repo, ref, cwd, keepBranch, times, state }) {
  const start = await prepare({ d, repo, ref });
  if (start.code !== undefined) return start.code;
  const { info, main, mirror } = start;
  state.info = info;
  const sha7 = info.headSha.slice(0, 7);
  d.out(`▸ ${repo} PR #${info.number} ${info.headRef} @ ${sha7}: landing`);
  const twin = await alreadyLanding(d, repo, { pr: info.number, headSha: info.headSha });
  if (twin) {
    d.out(`✗ not landing: ${twin}`);
    return 2;
  }
  const me = { repo, pr: info.number, headSha: info.headSha, land: true };
  // While it waits, only the pull request can end a land: closed, retargeted, or a new head seen twice.
  const watch = watchDoomed({
    intervalMs: d.doomedPollMs,
    probe: () => whyDoomed({ d, repo, pr: info.number, headSha: info.headSha, main, mainSha: null, recheck: [], again: 'ship land', timeoutMs: d.ghTimeoutMs }),
  });
  const held = [];
  const giveBack = async () => { while (held.length > 0) await held.pop()(); };
  try {
    let duplicate = null;
    const waitingForLand = once((holder) => d.out(`… a land of PR #${holder.pr ?? '?'} holds the head lock of ${sha7} — waiting for it`));
    const optional = once(() => d.out(`… an optional ship check of ${sha7} is running — ship land waits for it, then joins the line`));
    try {
      held.push(await lockWithCleanup(headLockDir(d, repo, info.headSha), await ownerInfo(me), {
        pollMs: d.pollMs,
        isAborted: () => duplicate !== null || watch.reason() !== null,
        onWait: (holder) => {
          // A land of this PR that won the lock between alreadyLanding's look and ours is a duplicate. A land
          // of another PR with the same head (two PRs can share one) is waited for, and named as what it is.
          if (holder?.land && Number(holder.pr) === info.number) duplicate = `PR #${info.number} @ ${sha7} is already landing (pid ${holder.pid ?? '?'})`;
          else if (holder?.land) waitingForLand(holder);
          else if (holder) optional();
        },
      }));
      times.joinedAt = iso(d);
      const arrivedAt = Date.now();
      held.push(await lockWithCleanup(slotDir(d, repo), await ownerInfo({ ...me, arrivedAt }), {
        pollMs: d.pollMs,
        priority: LANE_PRIORITY.land,
        arrivedAt,
        isAborted: () => watch.reason() !== null,
        onWait: lineReporter(d, repo),
      }));
    } catch (e) {
      if (!e?.aborted || isInterrupted()) throw e;
      d.out(`✗ not landing PR #${info.number} @ ${sha7}: ${duplicate ?? watch.reason()}`);
      return 2;
    }
    watch.stop();
    times.slotAt = iso(d);
    const out = await landInSlot({ d, repo, info, main, mirror, keepBranch });
    if (out.code !== undefined) return out.code;
    state.merged = true;
    const mergedAtMs = d.now();
    times.mergedAt = iso(d);
    const seen = await seeMerge({ d, repo, main, number: info.number, sha: out.merged.sha });
    await giveBack();
    return await afterMerge({ d, repo, cwd, info, seen, mergedAtMs });
  } finally {
    watch.stop();
    await giveBack();
  }
}

// ship land: check, merge and deploy one pull request through the repository's
// serial line. Exit codes: spec §4.
export async function runLand({ cwd, pr = null, keepBranch = false, deps = {} }) {
  const d = { ...landDeps(), ...deps };
  const times = { joinedAt: null, slotAt: null, mergedAt: null };
  const state = { info: null, merged: false };
  let repo = null;
  let ref = pr;
  let code;
  let ledger = true;
  let recorded = false;
  const recordOnce = async (outcome) => {
    if (recorded) return;
    recorded = true;
    if (!ledger) return;
    await recordLanding(d, repo, {
      pr: state.info?.number ?? (/^\d+$/.test(ref ?? '') ? Number(ref) : null),
      branch: /^\d+$/.test(ref ?? '') ? null : ref,
      head: state.info?.headSha ?? null, ...times, endedAt: iso(d), code: outcome,
    });
  };
  // First registered, so the last to run in an interrupt's unwind (after the locks and the status),
  // and before the process exits: the main flow only sees the interrupt after its next poll.
  const off = onInterrupt(() => recordOnce(130));
  try {
    ledger = await ledgerWritable(d);
    await ensurePrivateDir(d.tmpRoot);
    repo = await repoFromCwd(cwd);
    if (!ref) {
      ref = (await capture('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      if (ref === 'HEAD') {
        d.out('✗ detached HEAD — run: ship land --pr <number>');
        code = 2;
      }
    }
    code ??= await land({ d, repo, ref, cwd, keepBranch, times, state });
  } catch (e) {
    if (e?.aborted || isInterrupted()) {
      await recordOnce(130);
      throw e;
    }
    const why = firstLine(e.message);
    d.out(state.merged
      ? `✗ PR #${state.info.number} merged, but ship failed after the merge (${why}) — ship status`
      : state.info ? `✗ PR #${state.info.number} not merged: ${why}; landing again is safe`
        : ref ? `✗ PR ${ref} not merged: ${why}; landing again is safe` : `✗ not landed: ${why}`);
    code = state.merged ? 3 : 4;
  }
  await recordOnce(code);
  if (!isInterrupted()) off();
  return code;
}

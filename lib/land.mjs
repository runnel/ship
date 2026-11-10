import { join } from 'node:path';
import { checkDeps, checkOnce, readResult, writeResult } from './check.mjs';
import { commitStatus, cutDescription, prInfo } from './github.mjs';
import { judgeLandStatus, parseChecked, squashMerge } from './merge.mjs';
import { deployDeps, syncMirror } from './repo.mjs';
import { ownerInfo } from './lock.mjs';
import { firstLine, lockWithin, once, repoKeyOf } from './shared.mjs';
import { keepAwake } from './power.mjs';
import { isInterrupted } from './interrupt.mjs';

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
  if (result.state === 'success') return { ok: true };
  if (result.state === 'stopped') return { code: 2, line: `✗ not landing PR #${n}: ${result.description}` };
  if (result.conflict) return { code: 2, line: `✗ not landing PR #${n}: a merge conflict with ${main}@${mainSha.slice(0, 7)}; merge ${main} into the branch, push, and land again` };
  if (result.state === 'failure') return { code: 1 };
  return { code: 4, line: `✗ PR #${n} not merged: ${result.description}; landing again is safe` };
}

// Says so when the pull request is no longer open at the head that was checked (a read of it just
// made); true when it did.
function movedOn(d, info, now) {
  const n = info.number;
  if (now.state !== 'OPEN') {
    d.out(`✗ not landing PR #${n}: it is ${String(now.state).toLowerCase()}`);
    return true;
  }
  if (now.headSha !== info.headSha) {
    d.out(`✗ not landing PR #${n} @ ${info.headSha.slice(0, 7)}: a new head ${now.headSha.slice(0, 7)} was pushed; land that one`);
    return true;
  }
  return false;
}

// What a failed gh pr merge means for the land: 5 unknown, 2 the PR moved on, 4 still open.
function mergeFailure(d, info, res) {
  const n = info.number;
  const noAnswer = `no answer within ${d.mergeTimeoutMs / 1000}s`;
  if (!res.now) {
    d.out(`✗ PR #${n}: the merge outcome is unknown: gh pr merge failed (${res.killed ? noAnswer : res.why}) and the PR could not be read — check gh pr view ${n}`);
    return 5;
  }
  if (movedOn(d, info, res.now)) return 2;
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
    if (movedOn(d, info, now)) return { code: 2 };
    // The status is read at the head the merge is pinned to.
    const verdict = judgeLandStatus(await commitStatus({ repo, sha: headSha, gh: d.gh, timeoutMs: d.ghTimeoutMs }), { pr: n, headSha, main, mainSha });
    if (!verdict.ok) {
      d.out(`✗ PR #${n} not merged: ${verdict.reason}`); // the reason ends "run ship land --pr <n>"
      return { code: 4 };
    }
    const res = await squashMerge({ d, repo, number: n, headSha, keepBranch, readForMs: d.mergeReadForMs, readEveryMs: d.mergePollMs });
    if (!res.merged) return { code: mergeFailure(d, info, res) };
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

import { join } from 'node:path';
import { capture } from './proc.mjs';
import { revParse, changedFiles, isAncestor } from './git.mjs';
import { prInfo, commitStatus, mergedSha } from './github.mjs';
import { matchesAny } from './glob.mjs';
import { deployDeps, openTree, repoFromCwd, syncMirror } from './repo.mjs';
import { ensurePrivateDir } from './paths.mjs';
import { firstLine, lockWithCleanup, once, repoKeyOf } from './shared.mjs';
import { ownerInfo } from './lock.mjs';

// What a successful local-ci description says about the main it checked against: `vs main@52d4c19`
// is written by every verdict that ran against a main (the docs-only one is just that and nothing
// else). `sha` is the abbreviation as written.
const VS_MAIN = /\bvs (\S+)@([0-9a-f]{7,40})(?![0-9a-f])/;
const DOCS_ONLY = /^docs-only · vs \S+@[0-9a-f]{7,40}$/;

export function parseChecked(description) {
  const m = String(description ?? '').match(VS_MAIN);
  if (!m) return null;
  return { docsOnly: DOCS_ONLY.test(description), branch: m[1], sha: m[2] };
}

// Whether the local-ci status of the pull request head allows a merge at all:
// { ok: false, reason } or { ok: true, docsOnly, branch, sha } (the main it was checked against).
export function judgeStatus(status, { pr, headSha, command = 'ship check' }) {
  const sha7 = headSha.slice(0, 7);
  const again = `run ${command} --pr ${pr}`;
  if (!status) return { ok: false, reason: `no local-ci status on ${sha7}; ${again}` };
  if (status.state !== 'success') return { ok: false, reason: `local-ci is ${status.state} on ${sha7} (${status.description}); ${again}` };
  // Only ship check posts it, with the owner's login. A workflow's token can post a status too.
  if (status.bot) return { ok: false, reason: `local-ci on ${sha7} was posted by ${status.postedBy ?? 'a bot'}, not by ship check; ${again}` };
  const checked = parseChecked(status.description);
  if (!checked) return { ok: false, reason: `cannot tell which main local-ci checked ("${status.description}"); ${again} again` };
  return { ok: true, ...checked };
}

// The files main gained since the check that force a fresh one.
export const staleFiles = ({ changed, recheck }) => changed.filter((f) => matchesAny(f, recheck));

export const fileList = (files) => (files.length > 5 ? `${files.slice(0, 5).join(', ')} +${files.length - 5} more` : files.join(', '));

export function staleReason({ files, branch, sha, pr }) {
  return `${branch} gained ${fileList(files)} since the check (vs ${branch}@${sha}); run ship check --pr ${pr} again`;
}

// Merges a pull request that `ship check` passed, unless main has changed since in a way the
// config says voids that check (`recheckOnMainChange`). Never bypasses branch protection and never
// posts a status. Exit codes: 0 merged, 1 failed, 2 refused. Two merges of one repository on this
// machine take turns, so the second one fetches the main the first one made.
export async function runMerge({ cwd, pr, keepBranch = false, deps = {} }) {
  const d = { mergeTimeoutMs: 120_000, ...deployDeps(), ...deps };
  await ensurePrivateDir(d.tmpRoot);
  const repo = await repoFromCwd(cwd);
  const release = await lockWithCleanup(join(d.tmpRoot, 'locks', `merge-${repoKeyOf(repo)}`), await ownerInfo({ repo, pr: Number(pr) }), {
    pollMs: d.pollMs,
    onWait: once(() => d.out(`… another ship merge of ${repo} is running — waiting for it`)),
  });
  try {
    return await mergeLocked({ d, repo, pr, keepBranch });
  } finally {
    await release();
  }
}

async function mergeLocked({ d, repo, pr, keepBranch }) {
  const refuse = (reason) => { d.out(`✗ ${reason}`); return 2; };
  const info = await prInfo({ repo, pr, gh: d.gh });
  if (info.fork) return refuse(`PR #${info.number} comes from a fork — ship never merges another account's code`);
  if (info.state !== 'OPEN') return refuse(`PR #${info.number} is ${String(info.state).toLowerCase()}`);

  const verdict = judgeStatus(await commitStatus({ repo, sha: info.headSha, gh: d.gh }), { pr: info.number, headSha: info.headSha });
  if (!verdict.ok) return refuse(verdict.reason);

  // Main is read as late as possible: the check's verdict is judged against it.
  const r = await syncMirror({ repo, d });
  if (info.base !== r.mainBranch) return refuse(`PR #${info.number} targets ${info.base}; only PRs into ${r.mainBranch} are gated`);
  if (verdict.branch !== r.mainBranch) return refuse(`local-ci checked against ${verdict.branch}, not ${r.mainBranch}; run ship check --pr ${info.number} again`);
  // `gh pr view` can answer with the previous head for a while after a push; the fetched branch cannot.
  const tip = await revParse(r.mirror, `refs/heads/${info.headRef}`).catch(() => null);
  if (tip && tip !== info.headSha) {
    return refuse(`the branch of #${info.number} is at ${tip.slice(0, 7)} but local-ci passed ${info.headSha.slice(0, 7)}; run ship check --pr ${info.number}`);
  }

  // A docs-only verdict ran nothing that main could have made stale: it is never held back.
  if (!verdict.docsOnly) {
    const checkedSha = await revParse(r.mirror, verdict.sha).catch(() => null);
    if (!checkedSha) return refuse(`${verdict.branch}@${verdict.sha}, the main that local-ci checked, is not in ${repo}; run ship check --pr ${info.number} again`);
    // A main that was rewound or rewritten no longer contains what was checked, and a diff from
    // the merge base would list too little.
    if (!(await isAncestor(r.mirror, checkedSha, r.mainSha))) {
      return refuse(`${r.mainBranch} no longer contains ${verdict.branch}@${verdict.sha}, the main that local-ci checked; run ship check --pr ${info.number} again`);
    }
    const changed = await changedFiles(r.mirror, checkedSha, r.mainSha);
    if (changed.length > 0) {
      // The config is main's own (a function config reads its tree), and only needed when main moved.
      const tree = await openTree({ d, r, sha: r.mainSha, label: 'm' });
      let recheck;
      try {
        recheck = tree.config.recheckOnMainChange;
      } finally {
        await tree.close();
      }
      const files = staleFiles({ changed, recheck });
      if (files.length > 0) return refuse(staleReason({ files, branch: verdict.branch, sha: verdict.sha, pr: info.number }));
      d.out(`· ${r.mainBranch} gained ${changed.length} file(s) since the check, none of them in recheckOnMainChange`);
    }
  }

  const res = await squashMerge({ d, repo, number: info.number, headSha: info.headSha, keepBranch });
  if (res.merged) {
    if (res.why === null) d.out(`✓ merged PR #${info.number} into ${r.mainBranch}${res.sha ? ` as ${res.sha}` : ' (GitHub has not reported the merge commit yet)'}`);
    else d.out(`✓ merged PR #${info.number} into ${r.mainBranch}${res.sha ? ` as ${res.sha}` : ''}, but gh reported: ${res.killed ? `no answer after ${d.mergeTimeoutMs / 1000}s` : res.why}`);
    return 0;
  }
  if (!res.now) d.out(`✗ gh pr merge failed for PR #${info.number} (${res.why}) and its state could not be read: the outcome is unknown, check gh pr view ${info.number}`);
  else if (res.killed) d.out(`✗ gh pr merge gave no answer for PR #${info.number} within ${d.mergeTimeoutMs / 1000}s; it is still open — check gh pr view ${info.number} before merging again`);
  else d.out(`✗ gh pr merge refused PR #${info.number}: ${res.why}`);
  return 1;
}

// What ship land asks of the status on the head right before it merges: what judgeStatus asks, and
// that the check ran against exactly `mainSha` (the description's abbreviation is a prefix of it).
export function judgeLandStatus(status, { pr, headSha, main, mainSha }) {
  const verdict = judgeStatus(status, { pr, headSha, command: 'ship land' });
  if (!verdict.ok) return verdict;
  if (verdict.branch !== main || !mainSha.startsWith(verdict.sha)) {
    return { ok: false, reason: `local-ci on ${headSha.slice(0, 7)} checked ${verdict.branch}@${verdict.sha}, not ${main}@${mainSha.slice(0, 7)}, the main ship land merges onto; run ship land --pr ${pr}` };
  }
  return verdict;
}

// The squash merge of a pull request, pinned to `headSha` (a push in between makes GitHub refuse
// rather than merge an unchecked head), and what became of it. No --admin, ever. gh can fail after
// the merge landed (deleting the branch), and a timeout or a dropped connection leaves the outcome
// unknown, so a failure is followed by a look at the pull request: once, or with `readForMs` > 0,
// every `readEveryMs` until it is no longer open at that head or the time is up.
export async function squashMerge({ d, repo, number, headSha, keepBranch = false, readForMs = 0, readEveryMs = 10_000 }) {
  const args = ['pr', 'merge', String(number), '--repo', repo, '--squash', '--match-head-commit', headSha, ...(keepBranch ? [] : ['--delete-branch'])];
  const sha = () => mergedSha({ repo, pr: number, gh: d.gh, timeoutMs: d.ghTimeoutMs ?? 0 }).catch(() => null);
  try {
    await capture(d.gh, args, { timeout: d.mergeTimeoutMs, killSignal: 'SIGKILL' });
  } catch (e) {
    const why = firstLine(e.stderr) || firstLine(e.message);
    const killed = Boolean(e.killed);
    const now = await prAfter({ d, repo, number, headSha, readForMs, readEveryMs });
    if (now?.state === 'MERGED') return { merged: true, sha: await sha(), why, killed };
    return { merged: false, now, why, killed };
  }
  return { merged: true, sha: await sha(), why: null, killed: false };
}

// The pull request after a merge attempt failed: the last answer GitHub gave, or null when none came.
async function prAfter({ d, repo, number, headSha, readForMs, readEveryMs }) {
  const started = Date.now();
  let last = null;
  for (;;) {
    const now = await prInfo({ repo, pr: String(number), gh: d.gh, timeoutMs: d.ghTimeoutMs ?? 0 }).catch(() => null);
    if (now) last = now;
    if ((now && (now.state !== 'OPEN' || now.headSha !== headSha)) || Date.now() - started >= readForMs) return last;
    await d.sleep(readEveryMs);
  }
}

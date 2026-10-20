import { capture } from './proc.mjs';
import { revParse, changedFiles } from './git.mjs';
import { prInfo, commitStatus, mergedSha } from './github.mjs';
import { matchesAny } from './glob.mjs';
import { deployDeps, openTree, repoFromCwd, syncMirror } from './repo.mjs';
import { ensurePrivateDir } from './paths.mjs';
import { firstLine } from './shared.mjs';

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
export function judgeStatus(status, { pr, headSha }) {
  const sha7 = headSha.slice(0, 7);
  const again = `run ship check --pr ${pr}`;
  if (!status) return { ok: false, reason: `no local-ci status on ${sha7}; ${again}` };
  if (status.state !== 'success') return { ok: false, reason: `local-ci is ${status.state} on ${sha7} (${status.description}); ${again}` };
  const checked = parseChecked(status.description);
  if (!checked) return { ok: false, reason: `cannot tell which main local-ci checked ("${status.description}"); ${again} again` };
  return { ok: true, ...checked };
}

// The files main gained since the check that force a fresh one.
export const staleFiles = ({ changed, recheck }) => changed.filter((f) => matchesAny(f, recheck));

export function staleReason({ files, branch, sha, pr }) {
  const list = files.length > 5 ? `${files.slice(0, 5).join(', ')} +${files.length - 5} more` : files.join(', ');
  return `${branch} gained ${list} since the check (vs ${branch}@${sha}); run ship check --pr ${pr} again`;
}

// Merges a pull request that `ship check` passed, unless main has changed since in a way the
// config says voids that check (`recheckOnMainChange`). Never bypasses branch protection and never
// posts a status. Exit codes as for check: 0 merged, 1 failed, 2 refused.
export async function runMerge({ cwd, pr, keepBranch = false, deps = {} }) {
  const d = { ...deployDeps(), ...deps };
  await ensurePrivateDir(d.tmpRoot);
  const refuse = (reason) => { d.out(`✗ ${reason}`); return 2; };
  const repo = await repoFromCwd(cwd);
  const info = await prInfo({ repo, pr, gh: d.gh });
  if (info.fork) return refuse(`PR #${info.number} comes from a fork — ship never merges another account's code`);
  if (info.state !== 'OPEN') return refuse(`PR #${info.number} is ${String(info.state).toLowerCase()}`);

  const verdict = judgeStatus(await commitStatus({ repo, sha: info.headSha, gh: d.gh }), { pr: info.number, headSha: info.headSha });
  if (!verdict.ok) return refuse(verdict.reason);

  // Main is read as late as possible: the check's verdict is judged against it.
  const r = await syncMirror({ repo, d });
  if (info.base !== r.mainBranch) return refuse(`PR #${info.number} targets ${info.base}; only PRs into ${r.mainBranch} are gated`);
  // `gh pr view` can answer with the previous head for a while after a push; the fetched branch cannot.
  const tip = await revParse(r.mirror, `refs/heads/${info.headRef}`).catch(() => null);
  if (tip && tip !== info.headSha) {
    return refuse(`the branch of #${info.number} is at ${tip.slice(0, 7)} but local-ci passed ${info.headSha.slice(0, 7)}; run ship check --pr ${info.number}`);
  }

  // A docs-only verdict ran nothing that main could have made stale: it is never held back.
  if (!verdict.docsOnly) {
    const checkedSha = await revParse(r.mirror, verdict.sha).catch(() => null);
    if (!checkedSha) return refuse(`${verdict.branch}@${verdict.sha}, the main that local-ci checked, is not in ${repo}; run ship check --pr ${info.number} again`);
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

  // --match-head-commit: a push between the status read and now makes GitHub refuse, not merge the
  // unchecked head. No --admin, ever.
  const args = ['pr', 'merge', String(info.number), '--repo', repo, '--squash', '--match-head-commit', info.headSha, ...(keepBranch ? [] : ['--delete-branch'])];
  try {
    await capture(d.gh, args);
  } catch (e) {
    d.out(`✗ gh pr merge refused PR #${info.number}: ${firstLine(e.stderr) || firstLine(e.message)}`);
    return 1;
  }
  const sha = await mergedSha({ repo, pr: info.number, gh: d.gh }).catch(() => null);
  d.out(`✓ merged PR #${info.number} into ${r.mainBranch}${sha ? ` as ${sha}` : ' (GitHub has not reported the merge commit yet)'}`);
  return 0;
}

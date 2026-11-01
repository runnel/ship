import { prInfo } from './github.mjs';
import { changedFiles } from './git.mjs';
import { syncMirror } from './repo.mjs';
import { staleFiles, fileList } from './merge.mjs';

// A check is doomed when whatever it finds out can no longer be used: its pull request is gone, its
// head is not the head being checked, or main gained a file that `ship merge` would refuse the result
// for (recheckOnMainChange). A main that moved in any other way does not void it.
//
// Returns the reason as one sentence, or null when the result is still good. A look that fails
// (GitHub unreachable, the mirror busy) says nothing: the check goes on.
export async function whyDoomed({ d, repo, pr, headSha, main, mainSha, recheck }) {
  const now = await prInfo({ repo, pr: String(pr), gh: d.gh });
  if (now.state !== 'OPEN') return `PR #${pr} was ${String(now.state).toLowerCase()}`;
  if (now.headSha !== headSha) return `the head of PR #${pr} moved to ${now.headSha.slice(0, 7)}; run ship check --pr ${pr} for it`;
  if (recheck.length === 0) return null; // nothing main can gain voids this check: no need to fetch
  const r = await syncMirror({ repo, d, mainBranch: main });
  if (r.mainSha === mainSha) return null;
  const files = staleFiles({ changed: await changedFiles(r.mirror, mainSha, r.mainSha), recheck });
  if (files.length === 0) return null;
  return `${main} gained ${fileList(files)} since this check began (vs ${main}@${mainSha.slice(0, 7)}), so ship merge would refuse the result; run ship check --pr ${pr} again`;
}

// Looks with `probe` every `intervalMs` while the check waits and runs; the first reason it finds
// stays. `onDoomed(reason)` is awaited once, by the look that found it (the check stops what is
// running there). `now(maxAgeMs)` asks for an answer at this moment, or from a look that finished
// less than `maxAgeMs` ago. A look that has not finished after `lookTimeoutMs` (a hung `gh`, a
// stuck fetch) says nothing: the check must not wait for it, least of all while it holds a lane.
export function watchDoomed({ probe, intervalMs, onDoomed = async () => {}, lookTimeoutMs = 30_000 }) {
  let reason = null;
  let running = null;
  let lastAt = 0;
  const bounded = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('look timed out')), lookTimeoutMs);
    timer.unref();
    probe().then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const look = () => {
    running ??= (async () => {
      try {
        const why = await bounded();
        lastAt = Date.now();
        if (why && reason === null) {
          reason = why;
          await onDoomed(why);
        }
      } catch { /* cannot tell: the check goes on */ }
    })().finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(look, intervalMs);
  timer.unref();
  return {
    reason: () => reason,
    async now(maxAgeMs = 0) {
      if (reason === null && running) await running;
      if (reason === null && Date.now() - lastAt >= maxAgeMs) await look();
      return reason;
    },
    stop: () => clearInterval(timer),
  };
}

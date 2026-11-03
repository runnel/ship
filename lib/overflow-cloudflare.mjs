import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { checkRuns } from './github.mjs';
import { fetchBranchTip, forcePush, overlayCommit, setRef, showFile } from './git.mjs';
import { ownerInfo } from './lock.mjs';
import { isInterrupted } from './interrupt.mjs';
import { capture } from './proc.mjs';
import { firstLine } from './shared.mjs';
import { takePlace } from './overflow.mjs';

// A check that would wait long for the heavy lane can run on Cloudflare Workers Builds instead. ship
// pushes a commit to a private runner repository that a Worker is connected to; Cloudflare builds it,
// and the build command runs the check groups (lib/cloudflare-run.sh). The result is read off the check
// run the build leaves on that commit. ship has no Cloudflare credential and needs none: it only pushes
// with git and reads with gh. See docs/overflow.md, "Overflow to Cloudflare Workers Builds".

// The GitHub App that runs Workers Builds. A check run counts only if this app made it.
export const BUILD_APP = 'cloudflare-workers-and-pages';
export const OVERLAY_DIR = '.ship-run';
// The ref in the mirror that keeps the runner branch's chain of commits: the last one pushed.
export const tipRef = (branch) => `refs/ship/cloudflare/tip/${branch}`;

// Decides whether this check goes to Cloudflare, with the interface of overflowGate (overflow.mjs):
// `ask(line)` is what the wait for the lane polls, `claim()` skips the look at the line. When either is
// true the check holds a place until `release()`. There are no minutes to count: ship has nothing to
// read Cloudflare's usage with, so the only limits are the places and the line.
export function cloudflareGate({ d, owner, cloudflare }) {
  let askedAt = 0;
  let said = null;
  let place = null;
  const stay = (kind, why) => {
    if (kind !== said) d.out(`· Cloudflare: ${why}`);
    said = kind;
    return false;
  };
  const claim = async () => {
    let free;
    try {
      free = await takePlace(d, cloudflare.maxRunning, await ownerInfo(owner), 'cloudflare');
    } catch (e) {
      return stay('unread', `no place could be taken (${firstLine(e.message)})`);
    }
    if (!free) return stay('places', `${cloudflare.maxRunning} run(s) going already`);
    place = free;
    d.out('▸ running on Cloudflare Workers Builds instead');
    return true;
  };
  return {
    claim,
    ask: async (line) => {
      if (!line || line.ahead.length < cloudflare.minAhead) return false;
      if (Date.now() - askedAt < d.overflowAskMs) return false;
      askedAt = Date.now();
      return claim();
    },
    get place() { return place; },
    release: async () => {
      const held = place;
      place = null;
      if (held) await held.release().catch(() => {});
    },
  };
}

// What the build may see of this check, as { file name: content }. All of it comes from this machine
// and from main, never from the pull request's tree: the config and the setup script are main's. The
// nonce is read by nobody: it makes every commit change a file, so that checking the same tree again is
// not a commit Workers Builds may skip for changing nothing it watches.
export function overlayFiles({ run, config, groups, files, shipSha, env, setup, nonce }) {
  return {
    'run.sh': run,
    'config.mjs': config,
    groups: `${groups.join(',')}\n`,
    'changed-files': files.map((f) => `${f}\n`).join(''),
    'ship-sha': `${shipSha}\n`,
    nonce: `${nonce}\n`,
    // Only the groups that run, so that the file says what this build uses.
    'env.json': `${JSON.stringify(Object.fromEntries(groups.filter((g) => Object.hasOwn(env, g)).map((g) => [g, env[g]])))}\n`,
    ...(setup === null ? {} : { 'setup.sh': setup }),
  };
}

// The answer of the build in the check runs of its commit: { done: false } while there is none,
// { done: true, ok: true, url } for green, { done: true, ok: false, conclusion, url } for any other end.
// Only a run that this app made, on this commit, under this name counts: another app's run, a run on
// another commit and a run of another name are all somebody else's say, and can neither pass nor fail
// the check. Only a completed run is read. Green is a completed run that succeeded, with no completed run
// of ours on that commit that did not: a failure beside a success (a build run again) is not green.
export function buildVerdict(runs, { sha, checkName }) {
  const over = runs.filter((r) => r?.head_sha === sha && r.app?.slug === BUILD_APP && r.name === checkName && r.status === 'completed');
  const bad = over.find((r) => r.conclusion !== 'success');
  if (bad) return { done: true, ok: false, conclusion: bad.conclusion, url: bad.html_url ?? null };
  if (over.length > 0) return { done: true, ok: true, url: over[0].html_url ?? null };
  return { done: false };
}

// The check as a build on Cloudflare. Green is the only answer taken from it: { ok: true, url } (the
// check run's page), or { ok: false, why, url } for everything else, which the caller answers by checking
// here. Once `isStopped()` is true, or ship is interrupted, the wait ends; the build itself runs on, as it
// cannot be cancelled without a Cloudflare credential, and its result is ignored. `onStarted({ url })` is
// told the commit as soon as it is pushed.
export async function runOnCloudflare({ d, mirror, mainSha, tree, groups, files, config, cloudflare, label, place, isStopped = () => false, onStarted }) {
  const ref = `refs/ship/cloudflare/${randomBytes(6).toString('hex')}`; // the branch's tip, for this call alone
  let sha;
  try {
    const treeSha = (await capture('git', ['-C', tree, 'rev-parse', 'HEAD^{tree}'])).trim();
    // main's copy of the script, like main's config: a pull request cannot change what runs first.
    const setup = cloudflare.setup === null ? null : await showFile(mirror, mainSha, cloudflare.setup);
    if (cloudflare.setup !== null && setup === null) return { ok: false, why: `the setup script ${cloudflare.setup} is not on main` };
    const remote = d.remoteUrl(cloudflare.repo);
    // The branch's tip is the parent, so that the push sends only what is new.
    const parent = await fetchBranchTip(mirror, remote, cloudflare.branch, ref);
    const overlay = overlayFiles({
      run: await readFile(new URL('./cloudflare-run.sh', import.meta.url)),
      config, groups, files, shipSha: await d.shipSha(), env: cloudflare.env, setup, nonce: randomBytes(12).toString('hex'),
    });
    const made = await overlayCommit(mirror, { tree: treeSha, dir: OVERLAY_DIR, files: overlay, parent, message: `ship check ${label}` });
    if (isInterrupted()) return { ok: false, why: 'interrupted' };
    if (isStopped()) return { ok: false, why: 'stopped', stopped: true };
    await forcePush(mirror, remote, made.commit, cloudflare.branch);
    sha = made.commit;
    // The chain stays reachable, so that git does not prune it and the next fetch does not bring it
    // again. Best effort: checks at once each set it to their own commit, and the last one stays.
    await setRef(mirror, tipRef(cloudflare.branch), sha).catch(() => {});
  } catch (e) {
    return { ok: false, why: `the Cloudflare run could not be started (${firstLine(e.stderr) || firstLine(e.message)})` };
  } finally {
    await capture('git', ['--git-dir', mirror, 'update-ref', '-d', ref]).catch(() => {});
  }
  const commitUrl = `https://github.com/${cloudflare.repo}/commit/${sha}`;
  d.out(`· Cloudflare run: ${commitUrl}`);
  await writeFile(join(place.dir, 'run.json'), JSON.stringify({ url: commitUrl, startedAt: new Date().toISOString() })).catch(() => {});
  await onStarted({ url: commitUrl });

  const begun = Date.now();
  const give = (why, url = commitUrl) => ({ ok: false, why, url });
  let answered = Date.now();
  for (;;) {
    if (isInterrupted()) return give('interrupted');
    if (isStopped()) return { ...give('stopped'), stopped: true };
    await d.sleep(d.cloudflarePollMs);
    const now = Date.now();
    let runs;
    try {
      runs = await checkRuns({ repo: cloudflare.repo, sha, gh: d.gh });
      answered = Date.now();
    } catch (e) {
      if (now - answered >= d.cloudflareBlindMs) return give(`GitHub has not answered for ${Math.round(d.cloudflareBlindMs / 60_000)} min (${firstLine(e.stderr) || firstLine(e.message)})`);
      continue;
    }
    const v = buildVerdict(runs, { sha, checkName: cloudflare.checkName });
    if (v.done) {
      if (v.ok) return { ok: true, url: v.url ?? commitUrl };
      return give(v.conclusion === 'failure' ? 'the Cloudflare build was red' : `the Cloudflare build ended as ${v.conclusion}`, v.url ?? commitUrl);
    }
    // Only a completed run is read: while the build is queued or running there is no check run, or one that
    // is not over, and either way ship waits. The only limit is the time.
    if (now - begun >= cloudflare.timeoutMin * 60_000) return give(`the Cloudflare build had no result after ${cloudflare.timeoutMin} min`);
  }
}

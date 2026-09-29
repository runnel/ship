import { capture } from './proc.mjs';

export function parseRepoFromUrl(url) {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) throw new Error(`not a GitHub remote: ${url.trim()}`);
  return `${m[1]}/${m[2]}`;
}

const ghJson = async (gh, args) => JSON.parse(await capture(gh, args));

export async function prInfo({ repo, pr, gh = 'gh' }) {
  const j = await ghJson(gh, ['pr', 'view', String(pr), '--repo', repo, '--json',
    'number,headRefOid,headRefName,baseRefName,isCrossRepository,state']);
  return { number: j.number, headSha: j.headRefOid, headRef: j.headRefName, base: j.baseRefName, fork: j.isCrossRepository, state: j.state };
}

export async function defaultBranch({ repo, gh = 'gh' }) {
  return (await ghJson(gh, ['repo', 'view', repo, '--json', 'defaultBranchRef'])).defaultBranchRef.name;
}

export async function postStatus({ repo, sha, state, description, context = 'local-ci', gh = 'gh' }) {
  const desc = description.length > 140 ? `${description.slice(0, 139)}…` : description;
  await capture(gh, ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`,
    '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${desc}`]);
}

export async function nightlyFailures({ repo, branch, gh = 'gh' }) {
  const runs = await ghJson(gh, ['run', 'list', '--repo', repo, '--branch', branch, '--event', 'schedule',
    '--limit', '20', '--json', 'workflowName,conclusion,createdAt,url']);
  const latest = new Map();
  for (const r of runs) if (!latest.has(r.workflowName)) latest.set(r.workflowName, r); // newest first
  return [...latest.values()].filter((r) => r.conclusion === 'failure');
}

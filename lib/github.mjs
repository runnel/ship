import { capture } from './proc.mjs';

export function parseRepoFromUrl(url) {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) throw new Error(`not a GitHub remote: ${url.trim()}`);
  return `${m[1]}/${m[2]}`;
}

const ghJson = async (gh, args, opts) => JSON.parse(await capture(gh, args, opts));
const deadline = (timeoutMs) => ({ timeout: timeoutMs, killSignal: 'SIGKILL' });

export async function prInfo({ repo, pr, gh = 'gh' }) {
  const j = await ghJson(gh, ['pr', 'view', String(pr), '--repo', repo, '--json',
    'number,headRefOid,headRefName,baseRefName,isCrossRepository,state']);
  return { number: j.number, headSha: j.headRefOid, headRef: j.headRefName, base: j.baseRefName, fork: j.isCrossRepository, state: j.state };
}

// The newest status of one context on a commit as { state, description, postedBy, bot }, or null
// when the commit has none. The list answers newest first and, unlike the combined status, says who
// posted each one.
export async function commitStatus({ repo, sha, context = 'local-ci', gh = 'gh' }) {
  const list = await ghJson(gh, ['api', `repos/${repo}/commits/${sha}/statuses?per_page=100`]);
  const s = list.find((x) => x.context === context);
  return s ? { state: s.state, description: s.description ?? '', postedBy: s.creator?.login ?? null, bot: s.creator?.type === 'Bot' } : null;
}

// The commit a merged pull request made on its base branch, or null while GitHub has none to show.
export async function mergedSha({ repo, pr, gh = 'gh' }) {
  return (await ghJson(gh, ['pr', 'view', String(pr), '--repo', repo, '--json', 'mergeCommit'])).mergeCommit?.oid ?? null;
}

// The files every open pull request changes, as [{ number, files }].
export async function openPrFiles({ repo, gh = 'gh' }) {
  const list = await ghJson(gh, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,files']);
  return list.map((p) => ({ number: p.number, files: (p.files ?? []).map((f) => f.path) }));
}

export async function defaultBranch({ repo, gh = 'gh' }) {
  return (await ghJson(gh, ['repo', 'view', repo, '--json', 'defaultBranchRef'])).defaultBranchRef.name;
}

// timeoutMs > 0: a call that has not finished by then is killed; so is one whose `signal` (an
// AbortSignal) is aborted. A POST that hangs (a captive portal, a half-open connection) would
// otherwise hold up whoever waits for it.
export async function postStatus({ repo, sha, state, description, context = 'local-ci', targetUrl = null, gh = 'gh', timeoutMs = 0, signal }) {
  const desc = description.length > 140 ? `${description.slice(0, 139)}…` : description;
  await capture(gh, ['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`,
    '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${desc}`, ...(targetUrl ? ['-f', `target_url=${targetUrl}`] : [])],
  { killSignal: 'SIGKILL', ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}), ...(signal ? { signal } : {}) });
}

export async function nightlyFailures({ repo, branch, gh = 'gh' }) {
  const runs = await ghJson(gh, ['run', 'list', '--repo', repo, '--branch', branch, '--event', 'schedule',
    '--limit', '20', '--json', 'workflowName,conclusion,createdAt,url']);
  const latest = new Map();
  for (const r of runs) if (!latest.has(r.workflowName)) latest.set(r.workflowName, r); // newest first
  return [...latest.values()].filter((r) => r.conclusion === 'failure');
}

// This calendar month's usage report of the account (year, month in UTC, as GitHub counts them).
export const billingUsage = ({ owner, year, month, gh = 'gh', timeoutMs = 20_000 }) =>
  ghJson(gh, ['api', `/users/${owner}/settings/billing/usage?year=${year}&month=${month}`], deadline(timeoutMs));

// Starts the copy of a workflow that is on `ref`. Returns { runId, url }.
export async function dispatchWorkflow({ repo, workflow, ref, inputs, gh = 'gh', timeoutMs = 30_000 }) {
  const fields = Object.entries(inputs).flatMap(([k, v]) => ['-f', `inputs[${k}]=${v}`]);
  const j = await ghJson(gh, ['api', '-X', 'POST', `repos/${repo}/actions/workflows/${workflow}/dispatches`,
    '-f', `ref=${ref}`, '-F', 'return_run_details=true', ...fields], deadline(timeoutMs));
  if (!j.workflow_run_id) throw new Error('GitHub did not say which run it started');
  return { runId: j.workflow_run_id, url: j.html_url };
}

export const workflowRun = ({ repo, runId, gh = 'gh', timeoutMs = 20_000 }) =>
  ghJson(gh, ['api', `repos/${repo}/actions/runs/${runId}`], deadline(timeoutMs));

export const cancelRun = ({ repo, runId, gh = 'gh', timeoutMs = 20_000 }) =>
  capture(gh, ['api', '-X', 'POST', `repos/${repo}/actions/runs/${runId}/cancel`], deadline(timeoutMs));

// What a red run says about itself: the step that failed and the `✗ …` line the job printed, or null
// where GitHub does not say.
export async function redStep({ repo, runId, gh = 'gh', timeoutMs = 20_000 }) {
  const { jobs = [] } = await ghJson(gh, ['api', `repos/${repo}/actions/runs/${runId}/jobs`], deadline(timeoutMs));
  const job = jobs.find((x) => x.conclusion === 'failure');
  if (!job) return { step: null, line: null };
  const step = (job.steps ?? []).find((x) => x.conclusion === 'failure')?.name ?? null;
  const log = await capture(gh, ['api', `repos/${repo}/actions/jobs/${job.id}/logs`], deadline(timeoutMs)).catch(() => '');
  const line = log.split('\n').find((l) => l.includes('✗ '))?.replace(/^.*?✗ /, '').trim() ?? null;
  return { step, line };
}

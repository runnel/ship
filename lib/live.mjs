// Which commit is live on a Worker, read from the `sha:` annotations ship writes on every deploy,
// adopt and rollback.
export const SHA_MESSAGE = /^sha:([0-9a-f]{40})(?![0-9a-f])/;

export const parseSha = (message) => (typeof message === 'string' ? message.match(SHA_MESSAGE)?.[1] ?? null : null);
const messageOf = (x) => x?.annotations?.['workers/message'];
const newestFirst = (deployments) => [...deployments].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
const single = (d) => d.versions.length === 1 && d.versions[0].percentage === 100;
const MAX_SECRET_CHAIN = 50;

export function codeSha(versionId, { deployments, versions }, depth = 0) {
  if (depth > MAX_SECRET_CHAIN) return { sha: null, reason: 'too many secret changes in a row to follow' };
  for (const d of newestFirst(deployments)) {
    if (single(d) && d.versions[0].version_id === versionId) {
      const s = parseSha(messageOf(d));
      if (s) return { sha: s };
    }
  }
  const v = versions.find((x) => x.id === versionId);
  if (!v) return { sha: null, reason: `version ${versionId.slice(0, 8)} is older than the history ship reads` };
  const own = parseSha(messageOf(v));
  if (own) return { sha: own };
  if (v.annotations?.['workers/triggered_by'] === 'secret') {
    const before = versions.find((x) => x.number === v.number - 1);
    if (!before) return { sha: null, reason: `version ${versionId.slice(0, 8)} is a secret change on a version older than the history ship reads` };
    return codeSha(before.id, { deployments, versions }, depth + 1);
  }
  const m = messageOf(v);
  return { sha: null, reason: `version ${versionId.slice(0, 8)} was made outside ship (${m ? JSON.stringify(m.slice(0, 40)) : 'no message'})` };
}

export function resolveLive({ deployments, versions }) {
  const current = newestFirst(deployments)[0];
  if (!current) return { state: 'none' };
  if (!single(current)) return { state: 'unknown', reason: 'the current deployment splits traffic between versions' };
  const versionId = current.versions[0].version_id;
  const own = parseSha(messageOf(current));
  if (own) return { state: 'known', sha: own, versionId };
  const code = codeSha(versionId, { deployments, versions });
  return code.sha ? { state: 'known', sha: code.sha, versionId } : { state: 'unknown', reason: code.reason, versionId };
}

export const newestVersion = (versions) => [...versions].sort((a, b) => b.number - a.number)[0] ?? null;

// The rollback target: the newest earlier deployment whose code is known and differs from live;
// failing that, the newest older version with such code.
export function previousCode({ deployments, versions }, live) {
  for (const d of newestFirst(deployments).slice(1)) {
    if (!single(d) || d.versions[0].version_id === live.versionId) continue;
    const sha = parseSha(messageOf(d)) ?? codeSha(d.versions[0].version_id, { deployments, versions }).sha;
    if (sha && sha !== live.sha) return { versionId: d.versions[0].version_id, sha, created_on: d.created_on, deployed: true };
  }
  // A target need not have been deployed through a recorded deployment: the history pages end, or
  // it was only ever reached through secret changes. Older versions whose code is known count too.
  const liveNumber = versions.find((v) => v.id === live.versionId)?.number ?? Infinity;
  for (const v of [...versions].sort((a, b) => b.number - a.number)) {
    if (v.number >= liveNumber || v.annotations?.['workers/triggered_by'] === 'secret') continue;
    const sha = codeSha(v.id, { deployments, versions }).sha;
    if (sha && sha !== live.sha) {
      const deployed = deployments.some((d) => d.versions.some((x) => x.version_id === v.id));
      return { versionId: v.id, sha, created_on: v.metadata.created_on, deployed };
    }
  }
  return null;
}

// A version `wrangler versions secret put` makes: a copy of the newest version at that moment, so
// its upload time says when the secret changed, not when the code was uploaded.
export const madeBySecretPut = (version) => /^Updated secret\b/.test(messageOf(version) ?? '');

// Secret changes a rollback from `fromVersionId` to `toVersionId` would undo; null when either
// version is outside the history that was read, so they cannot be counted.
export function secretChangesBetween(versions, fromVersionId, toVersionId) {
  const from = versions.find((v) => v.id === fromVersionId);
  const to = versions.find((v) => v.id === toVersionId);
  if (!from || !to) return null;
  return versions.filter((v) => v.annotations?.['workers/triggered_by'] === 'secret' && v.number > to.number && v.number <= from.number);
}

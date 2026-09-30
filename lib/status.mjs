import { deployDeps, openTree, prRefs, repoFromCwd, syncMirror } from './repo.mjs';
import { ICON, planDeploy } from './plan.mjs';
import { cloudflare } from './cloudflare.mjs';
import { commitsTouching, listTree, subject } from './git.mjs';
import { readAcks } from './state.mjs';
import { ackCommand } from './shared.mjs';
import { newestVersion } from './live.mjs';
import { matchesAny } from './glob.mjs';
import { ensurePrivateDir } from './paths.mjs';
import { timeOr } from './report.mjs';

export async function runStatus({ cwd, deps = {} }) {
  const d = { ...deployDeps(), ...deps };
  await ensurePrivateDir(d.tmpRoot);
  const r = await syncMirror({ repo: await repoFromCwd(cwd), d });
  const tree = await openTree({ d, r, sha: r.mainSha, label: 's' });
  try {
    const { config } = tree;
    d.out(`▸ ${r.repo} ${r.mainBranch}@${r.mainSha.slice(0, 7)}`);
    if (config.deployables.length === 0) {
      d.out('· no deployables in ship.config.mjs');
      return 0;
    }
    const creds = await d.readCredentials(config.credentials);
    const cf = cloudflare({ token: creds.CLOUDFLARE_API_TOKEN, accountId: creds.CLOUDFLARE_ACCOUNT_ID, fetchImpl: d.fetch });
    const entries = await planDeploy({ r, config, selected: new Set(config.deployables.map((x) => x.name)), target: r.mainSha, cf, stateRoot: d.stateRoot });
    for (const e of entries) {
      const parts = [];
      let inMirror = false; // the plan does not check a held deployable's live commit against the repository
      if (e.live.state === 'known') {
        const subj = await subject(r.mirror, e.live.sha);
        inMirror = subj !== null;
        parts.push(`live ${e.live.sha.slice(0, 7)}${subj === null ? '' : ` ${prRefs([subj]) || JSON.stringify(subj.slice(0, 50))}`}`);
      } else {
        parts.push(e.live.state === 'none' ? 'not deployed yet' : `live unknown (${e.live.reason})`);
      }
      const pendingSince = inMirror && (e.status === 'pending' || e.status === 'held' || e.status === 'skipped');
      if (pendingSince) {
        const commits = await commitsTouching(r.mirror, e.live.sha, r.mainSha, e.dep.paths);
        if (commits.length > 0) {
          const refs = prRefs(commits.map((c) => c.subject));
          parts.push(`pending: ${commits.length} commit(s)${refs ? ` ${refs}` : ''}`);
        }
      }
      if (e.live.state === 'unknown') parts.push(`to adopt: ship adopt --plan, then ship adopt --at <sha> ${e.dep.name}`);
      if (e.status === 'held' || (e.status === 'blocked' && e.live.state === 'known') || e.status === 'skipped') parts.push(e.reason);
      const newest = newestVersion(e.history.versions);
      if (newest && e.live.versionId && newest.id !== e.live.versionId && newest.number > (e.history.versions.find((v) => v.id === e.live.versionId)?.number ?? 0)) {
        parts.push(`newest version ${newest.id.slice(0, 8)} (${timeOr(newest.metadata?.created_on)}) is not deployed — secret put fails until it is`);
      }
      d.out(`${ICON[e.status] ?? '·'} ${e.dep.name}: ${parts.join(' · ')}`);
    }
    if (config.migrations) {
      const acked = await readAcks(d.stateRoot, r.repo);
      const migrations = (await listTree(r.mirror, r.mainSha)).filter((f) => matchesAny(f, config.migrations.paths));
      const unacked = migrations.filter((f) => !acked.has(f));
      if (unacked.length === 0) {
        d.out('✓ migrations: all cleared');
      } else {
        d.out(`! migrations not cleared for deploy: ${unacked.join(', ')}`);
        d.out(`  the owner applies them (or decides they go after the deploy) and runs: ${ackCommand(unacked, migrations)}`);
      }
    }
    return 0;
  } finally {
    await tree.close();
  }
}

import { changedFiles, listTree } from './git.mjs';
import { matchesAny, pendingFile } from './glob.mjs';
import { openTree } from './repo.mjs';

// What a merge brings, read from the merge commit itself: its config, the deployables it touches (a
// pending file in the merge commit's own diff) and the migration files it adds.
export async function landedChanges({ d, r, mergeSha }) {
  const tree = await openTree({ d, r, sha: mergeSha, label: 'l' });
  try {
    const { config } = tree;
    const files = await changedFiles(r.mirror, `${mergeSha}^`, mergeSha);
    const touched = config.deployables.filter((dep) => files.some(pendingFile(dep, config.docsOnly))).map((dep) => dep.name);
    let added = [];
    if (config.migrations) {
      const present = new Set(await listTree(r.mirror, mergeSha));
      added = files.filter((f) => matchesAny(f, config.migrations.paths) && present.has(f));
    }
    return { config, touched, added };
  } finally {
    await tree.close();
  }
}

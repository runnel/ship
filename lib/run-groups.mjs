import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, showFile } from './git.mjs';
import { loadConfigSource } from './config.mjs';
import { runGroups } from './shared.mjs';

// What a run on GitHub executes (README, "Overflow to GitHub Actions"): the named groups of the config
// on main, by the same code a check uses here, on the merged tree in `cwd`. It posts nothing: the only
// answer it gives is its exit code. 0 passed, 1 failed, 2 the arguments do not fit that config.
export async function runGroupsHere({ cwd, groups, mainSha, headSha, logFile = join(process.env.RUNNER_TEMP ?? tmpdir(), 'ship-groups.log'), out = (l) => process.stdout.write(`${l}\n`) }) {
  const gitDir = join(cwd, '.git');
  const source = await showFile(gitDir, mainSha, 'ship.config.mjs');
  if (!source) { out(`✗ no ship.config.mjs on ${mainSha}`); return 2; }
  const config = await loadConfigSource(source, { root: cwd });
  const unknown = groups.filter((g) => !config.checks.some((c) => c.name === g));
  if (groups.length === 0 || unknown.length > 0) { out(`✗ not check groups of that config: ${unknown.join(', ') || '(none given)'}`); return 2; }
  const r = await runGroups({ config, groups, root: cwd, files: await changedFiles(gitDir, mainSha, headSha), logFile, out });
  return r.ok ? 0 : 1;
}

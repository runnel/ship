import { parseArgs } from 'node:util';
import { runCheck } from './check.mjs';
import { isInterrupted } from './interrupt.mjs';

const DEPLOY_USAGE = '  ship deploy [<deployable>…] [--dry-run] [--redeploy]   deploy what changed on main since it went live';
const USAGE = `usage:
  ship check [--pr <number>]                              check a pull request and post the local-ci commit status
${DEPLOY_USAGE}
  ship leak <mode>                                        leak guard for this repository (see README)`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'check') {
      const { values } = parseArgs({ args: rest, options: { pr: { type: 'string' } } });
      return await runCheck({ cwd: process.cwd(), pr: values.pr ?? null });
    }
    if (cmd === 'deploy') {
      let parsed;
      try {
        parsed = parseArgs({ args: rest, allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, redeploy: { type: 'boolean' } } });
      } catch {
        process.stdout.write(`${DEPLOY_USAGE.trimStart()}\n`); // an unknown flag is a usage error, not a failed deploy
        return 2;
      }
      const { runDeploy } = await import('./deploy.mjs');
      return await runDeploy({ cwd: process.cwd(), names: parsed.positionals, dryRun: Boolean(parsed.values['dry-run']), redeploy: Boolean(parsed.values.redeploy) });
    }
    if (cmd === 'leak') {
      const { runLeak } = await import('./leak.mjs');
      return await runLeak(rest);
    }
    process.stdout.write(`${USAGE}\n`);
    return cmd ? 2 : 0;
  } catch (e) {
    if (e?.aborted || isInterrupted()) return 130; // an interrupt made this fail; the unwind reports it
    process.stderr.write(`✗ ship ${cmd}: ${e.message}\n`);
    return 1;
  }
}

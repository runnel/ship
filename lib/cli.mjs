import { parseArgs } from 'node:util';
import { runCheck } from './check.mjs';
import { isInterrupted } from './interrupt.mjs';
import { UsageError } from './shared.mjs';

// One row per command: the syntax padded to a common width, then what it does.
const WIDTH = 65;
const row = (syntax, what) => `  ${syntax.padEnd(WIDTH)}${what}`;
const CHECK_USAGE = row('ship check [--pr <number>]', 'check a pull request and post the local-ci commit status');
const DEPLOY_USAGE = row('ship deploy [<deployable>…] [--dry-run] [--redeploy]', 'deploy what changed on main since it went live');
const STATUS_USAGE = row('ship status', 'live commit, pending changes, holds per deployable');
const ADOPT_USAGE = row('ship adopt --at <sha> (<deployable>…|--all) | --plan', 'record what is live as a main commit (--plan suggests it)');
const ROLLBACK_USAGE = row('ship rollback <deployable> [--to <version> [--revert-secrets]]', 'show the rollback target; with --to, hold and promote it');
const UNHOLD_USAGE = row('ship unhold <deployable>', 'clear the hold of a deployable');
const ACK_USAGE = row('ship migrations ack <file>…', 'mark migration files as cleared for deploy');
const LEAK_USAGE = row('ship leak <mode>', 'leak guard for this repository (see README)');
const USAGE = `usage:
${[CHECK_USAGE, DEPLOY_USAGE, STATUS_USAGE, ADOPT_USAGE, ROLLBACK_USAGE, UNHOLD_USAGE, ACK_USAGE, LEAK_USAGE].join('\n')}`;

// A bad flag or argument is a usage error, not a failed command: say which, then how it is used.
function usageError(cmd, usage, message) {
  process.stderr.write(`✗ ship ${cmd}: ${message}\n`);
  process.stdout.write(`${usage.trimStart()}\n`);
  return 2;
}

// A command that refuses its arguments after it has started (a name it cannot know before it has
// read the repository) reports it like the parser does.
const withUsage = async (cmd, usage, run) => {
  try {
    return await run();
  } catch (e) {
    if (e instanceof UsageError) return usageError(cmd, usage, e.message);
    throw e;
  }
};

// { parsed } or { code: 2 } once the usage error has been printed.
function parseOrUsage(cmd, usage, args, options, { allowPositionals = false, positionals = null } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals, options });
  } catch (e) {
    return { code: usageError(cmd, usage, e.message) };
  }
  if (positionals !== null && parsed.positionals.length > positionals) {
    return { code: usageError(cmd, usage, `unexpected argument: ${parsed.positionals[positionals]}`) };
  }
  return { parsed };
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'check') {
      const { parsed, code } = parseOrUsage(cmd, CHECK_USAGE, rest, { pr: { type: 'string' } });
      if (!parsed) return code;
      return await runCheck({ cwd: process.cwd(), pr: parsed.values.pr ?? null });
    }
    if (cmd === 'deploy') {
      const { parsed, code } = parseOrUsage(cmd, DEPLOY_USAGE, rest, { 'dry-run': { type: 'boolean' }, redeploy: { type: 'boolean' } }, { allowPositionals: true });
      if (!parsed) return code;
      const { runDeploy } = await import('./deploy.mjs');
      return await withUsage(cmd, DEPLOY_USAGE, () => runDeploy({ cwd: process.cwd(), names: parsed.positionals, dryRun: Boolean(parsed.values['dry-run']), redeploy: Boolean(parsed.values.redeploy) }));
    }
    if (cmd === 'status') {
      const { parsed, code } = parseOrUsage(cmd, STATUS_USAGE, rest, {});
      if (!parsed) return code;
      const { runStatus } = await import('./status.mjs');
      return await runStatus({ cwd: process.cwd() });
    }
    if (cmd === 'adopt') {
      const { parsed, code } = parseOrUsage(cmd, ADOPT_USAGE, rest, { at: { type: 'string' }, all: { type: 'boolean' }, plan: { type: 'boolean' } }, { allowPositionals: true });
      if (!parsed) return code;
      const { runAdopt } = await import('./admin.mjs');
      return await withUsage(cmd, ADOPT_USAGE, () => runAdopt({ cwd: process.cwd(), at: parsed.values.at ?? null, names: parsed.positionals, all: Boolean(parsed.values.all), plan: Boolean(parsed.values.plan) }));
    }
    if (cmd === 'rollback') {
      const { parsed, code } = parseOrUsage(cmd, ROLLBACK_USAGE, rest, { to: { type: 'string' }, 'revert-secrets': { type: 'boolean' } }, { allowPositionals: true, positionals: 1 });
      if (!parsed) return code;
      const { runRollback } = await import('./admin.mjs');
      return await withUsage(cmd, ROLLBACK_USAGE, () => runRollback({ cwd: process.cwd(), name: parsed.positionals[0] ?? null, to: parsed.values.to ?? null, revertSecrets: Boolean(parsed.values['revert-secrets']) }));
    }
    if (cmd === 'unhold') {
      const { parsed, code } = parseOrUsage(cmd, UNHOLD_USAGE, rest, {}, { allowPositionals: true, positionals: 1 });
      if (!parsed) return code;
      const { runUnhold } = await import('./admin.mjs');
      return await withUsage(cmd, UNHOLD_USAGE, () => runUnhold({ cwd: process.cwd(), name: parsed.positionals[0] ?? null }));
    }
    if (cmd === 'migrations') {
      if (rest[0] !== 'ack') return usageError(cmd, ACK_USAGE, rest[0] === undefined ? 'expected: ack <file>…' : `unknown subcommand: ${rest[0]} (expected: ack <file>…)`);
      const { parsed, code } = parseOrUsage(`${cmd} ack`, ACK_USAGE, rest.slice(1), {}, { allowPositionals: true });
      if (!parsed) return code;
      const { runAck } = await import('./admin.mjs');
      return await withUsage('migrations ack', ACK_USAGE, () => runAck({ cwd: process.cwd(), files: parsed.positionals }));
    }
    if (cmd === 'leak') {
      const { runLeak } = await import('./leak.mjs');
      return await runLeak(rest);
    }
    if (cmd && !['--help', '-h', 'help'].includes(cmd)) process.stderr.write(`✗ ship ${cmd}: unknown command\n`);
    process.stdout.write(`${USAGE}\n`);
    return cmd ? 2 : 0;
  } catch (e) {
    if (e?.aborted || isInterrupted()) return 130; // an interrupt made this fail; the unwind reports it
    process.stderr.write(`✗ ship ${cmd}: ${e.message}\n`);
    return 1;
  }
}

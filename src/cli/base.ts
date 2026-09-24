import { Command } from 'commander';
import type { McpSession } from '../connector.js';
import type { ServerTarget } from '../types.js';
import { VERSION } from '../version.js';
import { contractCommand } from './commands/contract.js';
import { initCommand, type InitEdition } from './commands/init.js';
import { guard, type CliContext } from './shared.js';

/** Program with the commands both editions share: init and contract. */
export interface BaseDeps {
  connect?: (t: ServerTarget) => Promise<McpSession>;
}

export function buildBaseProgram(ctx: CliContext, edition: InitEdition, setExit: (code: number) => void, deps: BaseDeps = {}): Command {
  const program = new Command()
    .name('mcp-eval')
    .description(edition.pro ? 'Contract tests, record/replay and LLM evals for MCP servers' : 'Contract tests for MCP servers')
    .version(VERSION)
    .option('-c, --config <path>', 'path to mcp-eval.config.ts')
    // Set before any subcommand is added: Command.command() copies the exit callback from
    // the parent at that moment (copyInheritedSettings), so subcommands only throw
    // CommanderError instead of calling process.exit() directly if this runs first.
    .exitOverride();

  const init = program.command('init').description('create mcp-eval.config.ts' + (edition.pro ? ' and a sample scenario' : '')).option('--force', 'overwrite existing files');
  if (edition.pro) init.option('--ci', 'also write .github/workflows/mcp-eval.yml');
  init.action(async (o: { force?: boolean; ci?: boolean }) => setExit(await guard(ctx, () => initCommand(ctx, o, edition))));

  program
    .command('contract')
    .description('snapshot tool schemas, fail on breaking changes, lint descriptions')
    .option('-u, --update', 'accept the current schemas as the new snapshot')
    .option('--fail-on-lint', 'exit non-zero on lint errors')
    .action(async (o: { update?: boolean; failOnLint?: boolean }) => setExit(await contractCommand(ctx, { ...program.opts(), ...o }, deps)));

  return program;
}

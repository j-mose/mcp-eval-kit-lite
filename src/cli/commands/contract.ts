import type { McpSession } from '../../connector.js';
import { runContract } from '../../contract/run.js';
import { mergeReport } from '../../reports/store.js';
import { renderTerminal } from '../../reports/terminal.js';
import type { ServerTarget } from '../../types.js';
import { EXIT_FAILED, EXIT_OK, guard, loadCliConfig, type CliContext, type GlobalOptions } from '../shared.js';

export interface ContractCliOptions extends GlobalOptions {
  update?: boolean;
  failOnLint?: boolean;
}

export function contractCommand(ctx: CliContext, opts: ContractCliOptions, deps: { connect?: (t: ServerTarget) => Promise<McpSession> } = {}): Promise<number> {
  return guard(ctx, async () => {
    const config = await loadCliConfig(ctx, opts);
    const contract = await runContract(config, {
      ...(opts.update ? { update: true } : {}),
      ...(opts.failOnLint ? { failOnLint: true } : {}),
      ...(deps.connect ? { connect: deps.connect } : {}),
    });
    const report = await mergeReport(config.outDir, config.name, { contract });
    ctx.io.out(renderTerminal({ ...report, replay: undefined, eval: undefined } as typeof report));
    if (contract.breaking > 0) ctx.io.err('mcp-eval: breaking changes found. If they are intended, run "mcp-eval contract --update" and commit the snapshot.');
    return contract.passed ? EXIT_OK : EXIT_FAILED;
  });
}

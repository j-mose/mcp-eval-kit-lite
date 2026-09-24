import { connect as realConnect, type McpSession } from '../connector.js';
import type { ContractReport, ResolvedConfig, ServerTarget } from '../types.js';
import { diffSnapshots } from './diff.js';
import { lintSnapshot } from './lint.js';
import { readSnapshot, snapshotPath, takeSnapshot, writeSnapshot } from './snapshot.js';

export interface ContractOptions {
  /** Overwrite the stored snapshot with the current server state (accepts all changes). */
  update?: boolean;
  /** Treat lint errors as failures. */
  failOnLint?: boolean;
  connect?: (target: ServerTarget) => Promise<McpSession>;
}

export async function runContract(config: ResolvedConfig, opts: ContractOptions = {}): Promise<ContractReport> {
  const session = await (opts.connect ?? realConnect)(config.server);
  let current;
  try {
    current = await takeSnapshot(session, config.redact);
  } finally {
    await session.close();
  }
  const path = snapshotPath(config.snapshotDir, config.name);
  const stored = await readSnapshot(path);
  const lint = lintSnapshot(current, config.lint);
  const lintFails = opts.failOnLint === true && lint.some((i) => i.level === 'error');

  if (!stored || opts.update) {
    const changes = stored ? diffSnapshots(stored, current) : [];
    await writeSnapshot(path, current);
    return { snapshotPath: path, created: !stored, updated: Boolean(stored), changes, lint, breaking: 0, passed: !lintFails, lintFailed: lintFails };
  }
  const changes = diffSnapshots(stored, current);
  const breaking = changes.filter((c) => c.severity === 'breaking').length;
  return { snapshotPath: path, created: false, updated: false, changes, lint, breaking, passed: breaking === 0 && !lintFails, lintFailed: lintFails };
}

// Public API of the free edition (mcp-eval-kit-lite): config + contract.
export { defineConfig, loadConfig, resolveConfig, ConfigError, DEFAULT_MODEL } from './config.js';
export { connect, type McpSession, type ConnectOptions } from './connector.js';
export { takeSnapshot, readSnapshot, writeSnapshot, snapshotPath } from './contract/snapshot.js';
export { diffSnapshots, wordSimilarity } from './contract/diff.js';
export { lintSnapshot } from './contract/lint.js';
export { runContract, type ContractOptions } from './contract/run.js';
export { createRedactor } from './redact.js';
export type * from './types.js';

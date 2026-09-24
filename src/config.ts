import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { DEFAULT_LINT } from './contract/lint.js';
import { DEFAULT_REDACT_KEYS, DEFAULT_REDACT_PATTERNS } from './redact.js';
import type { McpEvalConfig, ModelPrice, ResolvedConfig } from './types.js';

export { DEFAULT_LINT };

export const CONFIG_FILENAMES = ['mcp-eval.config.ts', 'mcp-eval.config.mts', 'mcp-eval.config.js', 'mcp-eval.config.mjs'];

export const DEFAULT_MODEL = 'claude-sonnet-5';

/** Identity helper that gives users type checking in mcp-eval.config.ts. */
export function defineConfig(config: McpEvalConfig): McpEvalConfig {
  return config;
}

/** The file a record case's cassette is written to. Lives here so resolveConfig can reject collisions. */
export function cassetteFileName(name: string): string {
  return `${name.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function resolveConfig(input: McpEvalConfig, rootDir: string): ResolvedConfig {
  const server = input.server as McpEvalConfig['server'] | undefined;
  if (!server || typeof server !== 'object') throw new ConfigError('config.server is required');
  if (server.transport === 'stdio') {
    if (typeof server.command !== 'string' || server.command.length === 0) {
      throw new ConfigError('config.server.command is required for the stdio transport');
    }
  } else if (server.transport === 'http') {
    try {
      new URL(server.url);
    } catch {
      throw new ConfigError(`config.server.url is not a valid URL: ${String(server.url)}`);
    }
  } else {
    throw new ConfigError(`config.server.transport must be "stdio" or "http", got ${JSON.stringify((server as { transport?: unknown }).transport)}`);
  }
  const ev = input.eval ?? {};
  const trials = ev.trials ?? 3;
  const passThreshold = ev.passThreshold ?? 0.8;
  if (!Number.isInteger(trials) || trials < 1) throw new ConfigError('config.eval.trials must be an integer >= 1');
  if (passThreshold < 0 || passThreshold > 1) throw new ConfigError('config.eval.passThreshold must be between 0 and 1');
  const names = new Set<string>();
  // Case-insensitive, since macOS and Windows file systems are: "A" and "a" are one file there.
  const files = new Map<string, string>();
  for (const c of input.record?.cases ?? []) {
    if (names.has(c.name)) throw new ConfigError(`duplicate record case name: ${c.name}`);
    names.add(c.name);
    const file = cassetteFileName(c.name);
    const other = files.get(file.toLowerCase());
    if (other !== undefined) {
      throw new ConfigError(`record cases ${JSON.stringify(other)} and ${JSON.stringify(c.name)} would both be saved as cassette ${file}; rename one of them`);
    }
    files.set(file.toLowerCase(), c.name);
  }
  const abs = (p: string | undefined, dflt: string): string => resolve(rootDir, p ?? dflt);
  return {
    name: input.name ?? 'server',
    server,
    rootDir,
    snapshotDir: abs(input.snapshotDir, 'mcp-snapshots'),
    cassetteDir: abs(input.cassetteDir, 'mcp-cassettes'),
    scenarioDir: abs(input.scenarioDir, 'mcp-evals'),
    outDir: abs(input.outDir, 'mcp-eval-results'),
    redact: {
      keys: [...DEFAULT_REDACT_KEYS, ...(input.redact?.keys ?? [])],
      patterns: [...DEFAULT_REDACT_PATTERNS, ...(input.redact?.patterns ?? [])],
    },
    lint: { ...DEFAULT_LINT, ...input.lint },
    record: { cases: input.record?.cases ?? [] },
    replay: { matchers: input.replay?.matchers ?? [], ignoreKeys: input.replay?.ignoreKeys ?? [] },
    eval: {
      model: ev.model ?? DEFAULT_MODEL,
      trials,
      maxTurns: ev.maxTurns ?? 10,
      maxTokens: ev.maxTokens ?? 4096,
      passThreshold,
      source: ev.source ?? 'live',
      ...(ev.system !== undefined ? { system: ev.system } : {}),
      ...(ev.effort !== undefined ? { effort: ev.effort } : {}),
      pricing: (ev.pricing ?? {}) as Record<string, ModelPrice>,
    },
  };
}

export function findConfigFile(cwd: string): string | undefined {
  for (const f of CONFIG_FILENAMES) {
    const p = resolve(cwd, f);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Loads a config file (TS or JS, via jiti) and applies defaults. Paths resolve against the file's directory. */
export async function loadConfig(path?: string, cwd: string = process.cwd()): Promise<ResolvedConfig> {
  const file = path ? resolve(cwd, path) : findConfigFile(cwd);
  if (!file || !existsSync(file)) {
    throw new ConfigError(path ? `config file not found: ${path}` : `no config found in ${cwd} (looked for ${CONFIG_FILENAMES.join(', ')}); run "mcp-eval init"`);
  }
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const mod = await jiti.import<McpEvalConfig | undefined>(file, { default: true });
  if (!mod || typeof mod !== 'object') throw new ConfigError(`${file} must default-export a config object`);
  return resolveConfig(mod, dirname(file));
}

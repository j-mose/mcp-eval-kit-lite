import { CommanderError } from 'commander';
import { loadConfig } from '../config.js';
import type { ResolvedConfig } from '../types.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_ERROR = 2;

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export const processIO: CliIO = {
  out: (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
  err: (t) => process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
};

export interface CliContext {
  cwd: string;
  io: CliIO;
}

export interface GlobalOptions {
  config?: string;
}

export function loadCliConfig(ctx: CliContext, opts: GlobalOptions): Promise<ResolvedConfig> {
  return loadConfig(opts.config, ctx.cwd);
}

/** Runs a command body, turning thrown errors into a message plus exit code 2. */
export async function guard(ctx: CliContext, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (err) {
    ctx.io.err(`mcp-eval: ${(err as Error).message}`);
    return EXIT_ERROR;
  }
}

export function splitList(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Maps a commander parse error (thrown after `program.exitOverride()`) to the process
 * exit code: 0 for --help/--version (commander already printed and did nothing wrong),
 * 2 for everything else (unknown command/option, missing argument) since commander
 * already printed its own message to stderr.
 */
export function commanderExitCode(err: CommanderError): number {
  if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.exitCode === 0) return EXIT_OK;
  return EXIT_ERROR;
}

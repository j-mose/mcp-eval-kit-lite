import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { EXIT_ERROR, EXIT_OK, type CliContext } from '../shared.js';
import { configTemplate } from '../templates.js';

export interface InitOptions {
  force?: boolean;
  ci?: boolean;
}

export interface InitEdition {
  packageName: string;
  pro: boolean;
  /** Extra [relativePath, contents] files beyond the config (Pro: sample scenario, CI workflow). */
  extraFiles?: (opts: InitOptions) => [string, string][];
}

export async function initCommand(ctx: CliContext, opts: InitOptions, edition: InitEdition): Promise<number> {
  const files: [string, string][] = [['mcp-eval.config.ts', configTemplate(edition.packageName, edition.pro)], ...(edition.extraFiles?.(opts) ?? [])];
  const existing = files.filter(([f]) => existsSync(join(ctx.cwd, f))).map(([f]) => f);
  if (existing.length && !opts.force) {
    ctx.io.err(`mcp-eval: refusing to overwrite ${existing.join(', ')} (use --force)`);
    return EXIT_ERROR;
  }
  for (const [f, body] of files) {
    const path = join(ctx.cwd, f);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, 'utf8');
    ctx.io.out(`created ${relative(ctx.cwd, path)}`);
  }
  ctx.io.out('next: edit mcp-eval.config.ts, then run "npx mcp-eval contract"');
  return EXIT_OK;
}

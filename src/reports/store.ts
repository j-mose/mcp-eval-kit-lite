import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION } from '../version.js';
import type { RunReport } from '../types.js';

export const REPORT_FILE = 'report.json';

export async function readReport(outDir: string): Promise<RunReport | undefined> {
  try {
    return JSON.parse(await readFile(join(outDir, REPORT_FILE), 'utf8')) as RunReport;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Merges one section (contract / replay / eval) into outDir/report.json, keeping the
 * others, so `contract`, `replay` and `eval` can run as separate CI steps and `report`
 * renders all of them.
 */
export async function mergeReport(outDir: string, server: string, section: Partial<Pick<RunReport, 'contract' | 'replay' | 'eval'>>, now: Date = new Date()): Promise<RunReport> {
  const prev = await readReport(outDir);
  const next: RunReport = { ...(prev ?? {}), ...section, tool: 'mcp-eval-kit', version: VERSION, generatedAt: now.toISOString(), server };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, REPORT_FILE), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** True when every section present in the report passed. */
export function reportPassed(r: RunReport): boolean {
  return (r.contract?.passed ?? true) && (r.replay?.passed ?? true) && (r.eval?.passed ?? true);
}

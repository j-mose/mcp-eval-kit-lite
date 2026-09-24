import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { McpSession } from '../connector.js';
import { sortKeys, stableStringify } from '../json.js';
import { createRedactor } from '../redact.js';
import type { RedactOptions, Snapshot } from '../types.js';

const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name);

/**
 * Captures tools/prompts/resources into a deterministic snapshot: entries sorted by
 * name (resources by uri), object keys sorted, no timestamps. Key-based redaction
 * (authorization, api_key, token, password) and redaction patterns are applied so
 * secrets that leak into descriptions never reach disk. Key redaction only replaces
 * scalar values, so schemas of params named "token"/"password" (objects) are preserved.
 */
export async function takeSnapshot(session: McpSession, redact: RedactOptions): Promise<Snapshot> {
  const [tools, prompts, resources] = await Promise.all([session.listTools(), session.listPrompts(), session.listResources()]);
  const redactor = createRedactor(redact);
  const snap: Snapshot = {
    version: 1,
    server: session.serverInfo,
    tools: [...tools].sort(byName),
    prompts: [...prompts].sort(byName),
    resources: [...resources].sort((a, b) => a.uri.localeCompare(b.uri)),
  };
  return sortKeys(redactor(snap)) as Snapshot;
}

export function snapshotPath(snapshotDir: string, name: string): string {
  return join(snapshotDir, `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

export async function readSnapshot(path: string): Promise<Snapshot | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<Snapshot>;
  if (parsed.version !== 1 || !Array.isArray(parsed.tools)) {
    throw new Error(`${path} is not a version-1 mcp-eval-kit snapshot`);
  }
  return { prompts: [], resources: [], ...parsed } as Snapshot;
}

export async function writeSnapshot(path: string, snap: Snapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableStringify(snap), 'utf8');
}

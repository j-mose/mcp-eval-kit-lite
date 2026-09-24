import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { VERSION } from './version.js';
import type { PromptSnapshot, ResourceSnapshot, ServerTarget, ToolCallResult, ToolSnapshot } from './types.js';

export interface McpSession {
  serverInfo: { name: string; version: string };
  listTools(): Promise<ToolSnapshot[]>;
  listPrompts(): Promise<PromptSnapshot[]>;
  listResources(): Promise<ResourceSnapshot[]>;
  /** Never throws for tool-level failures: protocol errors become { isError: true } results. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Where child-process stderr goes for stdio servers. Default "inherit". */
  stderr?: 'inherit' | 'pipe' | 'ignore';
  timeoutMs?: number;
}

function makeTransport(target: ServerTarget, opts: ConnectOptions): Transport {
  if (target.transport === 'stdio') {
    return new StdioClientTransport({
      command: target.command,
      args: target.args ?? [],
      env: { ...getDefaultEnvironment(), ...target.env },
      ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
      stderr: opts.stderr ?? 'inherit',
    });
  }
  return new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: { headers: target.headers ?? {} },
  });
}

function describeTarget(t: ServerTarget): string {
  return t.transport === 'stdio' ? `stdio: ${[t.command, ...(t.args ?? [])].join(' ')}` : `http: ${t.url}`;
}

/**
 * tools/list is fetched with a lenient result schema instead of client.listTools(), whose
 * strict validation rejects the whole list when one tool breaks the spec (for example an
 * inputSchema without "type": "object"). The lint step reports those tools instead.
 */
const LenientToolsResult = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string() })),
  nextCursor: z.string().optional(),
});

type RawTool = z.infer<typeof LenientToolsResult>['tools'][number];

const optionalString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const optionalObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function toToolSnapshot(t: RawTool): ToolSnapshot {
  const title = optionalString(t.title);
  const description = optionalString(t.description);
  const outputSchema = optionalObject(t.outputSchema);
  const annotations = optionalObject(t.annotations);
  return {
    name: t.name,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    // Keep whatever the server sent (even if invalid) so lint can flag it.
    inputSchema: optionalObject(t.inputSchema) ?? {},
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(annotations !== undefined ? { annotations } : {}),
  };
}

/** Fetches every page of a cursor-paginated list. */
async function paginate<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string | undefined }>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const { items, nextCursor } = await fetchPage(cursor);
    all.push(...items);
    if (!nextCursor) return all;
    cursor = nextCursor;
  }
  throw new Error('pagination did not terminate after 1000 pages');
}

export async function connect(target: ServerTarget, opts: ConnectOptions = {}): Promise<McpSession> {
  const client = new Client({ name: 'mcp-eval-kit', version: VERSION });
  const reqOpts = { timeout: opts.timeoutMs ?? 60_000 };
  try {
    await client.connect(makeTransport(target, opts), reqOpts);
  } catch (err) {
    throw new Error(`could not connect to MCP server (${describeTarget(target)}): ${(err as Error).message}`, { cause: err });
  }
  const caps = client.getServerCapabilities() ?? {};
  const info = client.getServerVersion();

  return {
    serverInfo: { name: info?.name ?? 'unknown', version: info?.version ?? 'unknown' },

    async listTools() {
      if (!caps.tools) return [];
      const tools = await paginate(async (cursor) => {
        const r = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, LenientToolsResult, reqOpts);
        return { items: r.tools, nextCursor: r.nextCursor };
      });
      return tools.map(toToolSnapshot);
    },

    async listPrompts() {
      if (!caps.prompts) return [];
      const prompts = await paginate(async (cursor) => {
        const r = await client.listPrompts(cursor ? { cursor } : undefined, reqOpts);
        return { items: r.prompts, nextCursor: r.nextCursor };
      });
      return prompts.map((p) => ({
        name: p.name,
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
        arguments: (p.arguments ?? []).map((a) => ({
          name: a.name,
          ...(a.description !== undefined ? { description: a.description } : {}),
          required: a.required ?? false,
        })),
      }));
    },

    async listResources() {
      if (!caps.resources) return [];
      const resources = await paginate(async (cursor) => {
        const r = await client.listResources(cursor ? { cursor } : undefined, reqOpts);
        return { items: r.resources, nextCursor: r.nextCursor };
      });
      return resources.map((r) => ({
        name: r.name,
        uri: r.uri,
        ...(r.title !== undefined ? { title: r.title } : {}),
        ...(r.description !== undefined ? { description: r.description } : {}),
        ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
      }));
    },

    async callTool(name, args) {
      try {
        const r = await client.callTool({ name, arguments: args }, undefined, reqOpts);
        return {
          content: Array.isArray(r.content) ? (r.content as unknown[]) : [],
          ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
          isError: r.isError === true,
        };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    },

    async close() {
      await client.close();
    },
  };
}

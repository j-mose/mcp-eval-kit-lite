// Low-level MCP server used by connector tests: tools only (no prompts/resources
// capability), tools/list split across 4 pages, a tool that throws, and one tool whose
// inputSchema violates the spec.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = ['alpha', 'beta', 'gamma', 'delta', 'boom'].map((name) => ({
  name,
  description: `The ${name} tool`,
  inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
}));
TOOLS.push({ name: 'slow', description: 'Takes five seconds to answer', inputSchema: { type: 'object' } });
// Spec violation on purpose: no "type": "object". Strict clients reject the whole list.
TOOLS.push({ name: 'legacy', description: 'A tool with an old-style schema', inputSchema: { properties: { y: { type: 'string' } } } });

export function buildPagedServer(): Server {
  const server = new Server({ name: 'paged', version: '9.9.9' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const start = Number(req.params?.cursor ?? 0);
    const page = TOOLS.slice(start, start + 2);
    const next = start + 2 < TOOLS.length ? String(start + 2) : undefined;
    return { tools: page, ...(next ? { nextCursor: next } : {}) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'boom') throw new Error('kaboom');
    if (req.params.name === 'slow') await new Promise((r) => setTimeout(r, 5_000));
    return { content: [{ type: 'text', text: `${req.params.name}:${JSON.stringify(req.params.arguments ?? {})}` }] };
  });
  return server;
}

export async function startPagedHttp(token: string): Promise<{ url: string; close: () => Promise<void> }> {
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const server = buildPagedServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((r) => { http.closeAllConnections(); http.close(() => r()); }),
  };
}

if (process.argv[2] === '--stdio') {
  await buildPagedServer().connect(new StdioServerTransport());
}

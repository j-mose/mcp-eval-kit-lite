import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type McpSession } from '../src/connector.js';
import { startPagedHttp } from './fixtures/paged-server.js';

const fixture = fileURLToPath(new URL('./fixtures/paged-server.ts', import.meta.url));
const stdioTarget = { transport: 'stdio' as const, command: process.execPath, args: ['--import', 'tsx', fixture, '--stdio'] };

describe('connect over stdio', () => {
  let s: McpSession;
  beforeAll(async () => { s = await connect(stdioTarget, { stderr: 'pipe' }); });
  afterAll(async () => { await s.close(); });

  it('reports server info', () => {
    expect(s.serverInfo).toEqual({ name: 'paged', version: '9.9.9' });
  });

  it('follows nextCursor across every page', async () => {
    expect((await s.listTools()).map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma', 'delta', 'boom', 'slow', 'legacy']);
  });

  it('keeps tools whose inputSchema breaks the spec instead of rejecting the list', async () => {
    const legacy = (await s.listTools()).find((t) => t.name === 'legacy');
    expect(legacy?.inputSchema).toEqual({ properties: { y: { type: 'string' } } });
  });

  it('returns empty lists when the server lacks prompts/resources capabilities', async () => {
    expect(await s.listPrompts()).toEqual([]);
    expect(await s.listResources()).toEqual([]);
  });

  it('calls tools and turns thrown errors into isError results', async () => {
    expect(await s.callTool('alpha', { x: '1' })).toEqual({ content: [{ type: 'text', text: 'alpha:{"x":"1"}' }], isError: false });
    const boom = await s.callTool('boom', {});
    expect(boom.isError).toBe(true);
    expect(JSON.stringify(boom.content)).toContain('kaboom');
  });
});

describe('connect over Streamable HTTP', () => {
  let server: { url: string; close: () => Promise<void> };
  beforeAll(async () => { server = await startPagedHttp('s3cret'); });
  afterAll(async () => { await server.close(); });

  it('sends configured headers', async () => {
    const s = await connect({ transport: 'http', url: server.url, headers: { Authorization: 'Bearer s3cret' } });
    expect((await s.listTools())).toHaveLength(7);
    await s.close();
  });

  it('fails with a message naming the target when auth is wrong', async () => {
    await expect(connect({ transport: 'http', url: server.url, headers: { Authorization: 'Bearer nope' } }))
      .rejects.toThrow(/could not connect to MCP server \(http: http:\/\/127\.0\.0\.1/);
  });
});

describe('timeouts', () => {
  it('a hanging tool call becomes an isError result instead of blocking forever', async () => {
    const s = await connect(stdioTarget, { stderr: 'pipe', timeoutMs: 1500 });
    try {
      const r = await s.callTool('slow', {});
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toMatch(/timed out/i);
    } finally {
      await s.close();
    }
  });
});

describe('connect failures', () => {
  it('names the command when a stdio server cannot start', async () => {
    await expect(connect({ transport: 'stdio', command: '/nonexistent/server-binary' }, { stderr: 'pipe' }))
      .rejects.toThrow(/could not connect to MCP server \(stdio: \/nonexistent\/server-binary\)/);
  });
});

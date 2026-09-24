import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpSession } from '../../src/connector.js';
import { readSnapshot, snapshotPath, takeSnapshot, writeSnapshot } from '../../src/contract/snapshot.js';

const fakeSession = (): McpSession => ({
  serverInfo: { name: 'demo', version: '1.0.0' },
  listTools: async () => [
    { name: 'zeta', description: 'Uses key sk-live-ABCDEF123456', inputSchema: { type: 'object', properties: { token: { type: 'string', description: 'auth token' } } } },
    { name: 'alpha', description: 'First', inputSchema: { type: 'object' } },
  ],
  listPrompts: async () => [{ name: 'p', arguments: [] }],
  listResources: async () => [{ name: 'b', uri: 'x://b' }, { name: 'a', uri: 'x://a' }],
  callTool: async () => ({ content: [], isError: false }),
  close: async () => {},
});

describe('takeSnapshot', () => {
  it('sorts entries, keeps param schemas named like secrets, and redacts secret patterns', async () => {
    const s = await takeSnapshot(fakeSession(), { keys: [], patterns: ['sk-live-[A-Z0-9]+'] });
    expect(s.tools.map((t) => t.name)).toEqual(['alpha', 'zeta']);
    expect(s.resources.map((r) => r.uri)).toEqual(['x://a', 'x://b']);
    expect(s.tools[1]!.description).toBe('Uses key [REDACTED]');
    expect(s.tools[1]!.inputSchema).toEqual({ type: 'object', properties: { token: { type: 'string', description: 'auth token' } } });
    expect(s.server).toEqual({ name: 'demo', version: '1.0.0' });
  });

  it('applies key-based redaction only to scalar values, preserving parameter schemas', async () => {
    const session: McpSession = {
      serverInfo: { name: 'test', version: '1.0' },
      listTools: async () => [
        {
          name: 'secret_tool',
          description: 'Tool with secrets',
          inputSchema: {
            type: 'object',
            properties: {
              token: { type: 'string', description: 'API token' },
              password: { type: 'string' },
            },
          },
          _meta: { api_key: 'abc123' },
        } as any,
      ],
      listPrompts: async () => [],
      listResources: async () => [],
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
    };

    const s = await takeSnapshot(session, { keys: ['authorization', 'api_key', 'token', 'password'], patterns: [] });
    const tool = s.tools[0]!;

    // Property schemas must be preserved exactly
    expect(tool.inputSchema.properties).toEqual({
      token: { type: 'string', description: 'API token' },
      password: { type: 'string' },
    });

    // Scalar field with secret key should be redacted
    expect((tool as any)._meta.api_key).toBe('[REDACTED]');
  });
});

describe('snapshot files', () => {
  it('round-trips with stable, key-sorted JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mek-snap-'));
    const path = snapshotPath(dir, 'my server');
    expect(path).toBe(join(dir, 'my_server.json'));
    const s = await takeSnapshot(fakeSession(), { keys: [], patterns: [] });
    await writeSnapshot(path, s);
    const text = readFileSync(path, 'utf8');
    expect(text.indexOf('"prompts"')).toBeLessThan(text.indexOf('"tools"'));
    expect(await readSnapshot(path)).toEqual(s);
  });

  it('returns undefined for a missing file and rejects foreign JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mek-snap-'));
    expect(await readSnapshot(join(dir, 'none.json'))).toBeUndefined();
    writeFileSync(join(dir, 'bad.json'), '{"hello":1}');
    await expect(readSnapshot(join(dir, 'bad.json'))).rejects.toThrow(/not a version-1/);
  });
});

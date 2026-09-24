import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_MODEL, loadConfig, resolveConfig } from '../src/config.js';

const stdio = { transport: 'stdio' as const, command: 'node', args: ['server.js'] };

describe('resolveConfig', () => {
  it('applies defaults and absolute directories', () => {
    const c = resolveConfig({ server: stdio }, '/proj');
    expect(c.name).toBe('server');
    expect(c.snapshotDir).toBe('/proj/mcp-snapshots');
    expect(c.cassetteDir).toBe('/proj/mcp-cassettes');
    expect(c.scenarioDir).toBe('/proj/mcp-evals');
    expect(c.outDir).toBe('/proj/mcp-eval-results');
    expect(c.eval.model).toBe(DEFAULT_MODEL);
    expect(c.eval.trials).toBe(3);
    expect(c.eval.passThreshold).toBe(0.8);
    expect(c.eval.source).toBe('live');
    expect(c.redact.keys).toEqual(expect.arrayContaining(['authorization', 'api_key', 'token', 'password']));
  });

  it('appends user redact keys and patterns to the defaults', () => {
    const c = resolveConfig({ server: stdio, redact: { keys: ['session_id'], patterns: ['sk-[a-z0-9]+'] } }, '/p');
    expect(c.redact.keys).toContain('session_id');
    expect(c.redact.keys).toContain('password');
    expect(c.redact.patterns).toContain('sk-[a-z0-9]+');
  });

  it('rejects a missing server, bad transport, bad URL and bad trials', () => {
    expect(() => resolveConfig({} as never, '/p')).toThrow(ConfigError);
    expect(() => resolveConfig({ server: { transport: 'ws' } } as never, '/p')).toThrow(/stdio" or "http/);
    expect(() => resolveConfig({ server: { transport: 'http', url: 'not a url' } }, '/p')).toThrow(/valid URL/);
    expect(() => resolveConfig({ server: { transport: 'stdio', command: '' } }, '/p')).toThrow(/command is required/);
    expect(() => resolveConfig({ server: stdio, eval: { trials: 0 } }, '/p')).toThrow(/trials/);
  });

  it('rejects duplicate record case names', () => {
    const cases = [{ name: 'a', tool: 't' }, { name: 'a', tool: 'u' }];
    expect(() => resolveConfig({ server: stdio, record: { cases } }, '/p')).toThrow(/duplicate record case name: a/);
  });

  it('rejects record case names that map to the same cassette file', () => {
    const cases = [{ name: 'a b', tool: 't' }, { name: 'a_b', tool: 'u' }];
    expect(() => resolveConfig({ server: stdio, record: { cases } }, '/p')).toThrow(ConfigError);
    expect(() => resolveConfig({ server: stdio, record: { cases } }, '/p')).toThrow('record cases "a b" and "a_b" would both be saved as cassette a_b.json');
    expect(() => resolveConfig({ server: stdio, record: { cases: [{ name: 'List', tool: 't' }, { name: 'list', tool: 't' }] } }, '/p')).toThrow(/"List" and "list"/);
    expect(() => resolveConfig({ server: stdio, record: { cases: [{ name: 'a b', tool: 't' }, { name: 'a-b', tool: 't' }] } }, '/p')).not.toThrow();
  });
});

describe('loadConfig', () => {
  it('loads a TypeScript config and resolves paths against its directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mek-config-'));
    writeFileSync(
      join(dir, 'mcp-eval.config.ts'),
      `const port: number = 3000;\nexport default { name: 'demo', server: { transport: 'http', url: 'http://localhost:' + port + '/mcp' }, snapshotDir: 'snaps' };\n`,
    );
    const c = await loadConfig(undefined, dir);
    expect(c.name).toBe('demo');
    expect(c.snapshotDir).toBe(join(dir, 'snaps'));
    expect(c.server).toEqual({ transport: 'http', url: 'http://localhost:3000/mcp' });
  });

  it('explains how to fix a missing config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mek-config-'));
    await expect(loadConfig(undefined, dir)).rejects.toThrow(/mcp-eval init/);
  });
});

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.js';
import type { McpSession } from '../../src/connector.js';
import { runContract } from '../../src/contract/run.js';
import type { ToolSnapshot } from '../../src/types.js';

const v1: ToolSnapshot = {
  name: 'create_note',
  description: 'Create a note with a title and a body.',
  inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Title' } }, required: ['title'] },
};
const v2: ToolSnapshot = {
  ...v1,
  inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Title' }, folder: { type: 'string', description: 'Folder' } }, required: ['title', 'folder'] },
};

const sessionWith = (tools: ToolSnapshot[]) => async (): Promise<McpSession> => ({
  serverInfo: { name: 'notes', version: '1' },
  listTools: async () => tools,
  listPrompts: async () => [],
  listResources: async () => [],
  callTool: async () => ({ content: [], isError: false }),
  close: async () => {},
});

const config = () => resolveConfig({ name: 'notes', server: { transport: 'stdio', command: 'unused' } }, mkdtempSync(join(tmpdir(), 'mek-run-')));

describe('runContract', () => {
  it('creates the snapshot on first run and passes', async () => {
    const c = config();
    const r = await runContract(c, { connect: sessionWith([v1]) });
    expect(r).toMatchObject({ created: true, updated: false, breaking: 0, passed: true, changes: [] });
    expect(existsSync(r.snapshotPath)).toBe(true);
  });

  it('fails on a breaking change and does not touch the snapshot', async () => {
    const c = config();
    await runContract(c, { connect: sessionWith([v1]) });
    const r = await runContract(c, { connect: sessionWith([v2]) });
    expect(r.passed).toBe(false);
    expect(r.breaking).toBe(1);
    expect(r.changes[0]).toMatchObject({ kind: 'param-required-added', path: 'folder' });
    const again = await runContract(c, { connect: sessionWith([v2]) });
    expect(again.breaking).toBe(1);
  });

  it('--update accepts the change, reports it, and later runs pass', async () => {
    const c = config();
    await runContract(c, { connect: sessionWith([v1]) });
    const r = await runContract(c, { connect: sessionWith([v2]), update: true });
    expect(r).toMatchObject({ updated: true, passed: true, breaking: 0 });
    expect(r.changes).toHaveLength(1);
    expect((await runContract(c, { connect: sessionWith([v2]) })).passed).toBe(true);
  });

  it('fails on lint errors only when failOnLint is set', async () => {
    const noDesc = { ...v1, description: '' };
    expect((await runContract(config(), { connect: sessionWith([noDesc]) })).passed).toBe(true);
    const failed = await runContract(config(), { connect: sessionWith([noDesc]), failOnLint: true });
    expect(failed.passed).toBe(false);
    expect(failed.lintFailed).toBe(true);
    expect((await runContract(config(), { connect: sessionWith([noDesc]) })).lintFailed).toBe(false);
  });
});

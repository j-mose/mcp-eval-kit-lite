import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBaseProgram } from '../../src/cli/base.js';
import type { CliContext } from '../../src/cli/shared.js';
import type { McpSession } from '../../src/connector.js';

async function runLite(dir: string, argv: string[], connect?: () => Promise<McpSession>) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = { cwd: dir, io: { out: (t) => out.push(t), err: (t) => err.push(t) } };
  let code = -1;
  const p = buildBaseProgram(ctx, { packageName: 'mcp-eval-kit-lite', pro: false }, (c) => { code = c; }, connect ? { connect } : {});
  p.exitOverride();
  await p.parseAsync(argv, { from: 'user' });
  return { code, out: out.join('\n'), err: err.join('\n'), program: p };
}

describe('lite CLI', () => {
  it('has only init and contract; init writes only the config importing mcp-eval-kit-lite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mek-lite-'));
    const r = await runLite(dir, ['init']);
    expect(r.code).toBe(0);
    expect(r.program.commands.map((c) => c.name())).toEqual(['init', 'contract']);
    const config = readFileSync(join(dir, 'mcp-eval.config.ts'), 'utf8');
    expect(config).toContain("from 'mcp-eval-kit-lite'");
    expect(config).toContain('lint: { minDescriptionLength: 20 }');
    // record/replay/eval do nothing in lite, so the template does not scaffold them.
    expect(config).not.toMatch(/record:|replay:|eval:/);
    expect(existsSync(join(dir, 'mcp-evals'))).toBe(false);
    expect(existsSync(join(dir, '.github'))).toBe(false);
  });

  it('contract exits 1 on a removed tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mek-lite-'));
    writeFileSync(join(dir, 'mcp-eval.config.ts'), `export default { name: 'x', server: { transport: 'stdio', command: 'unused' } };\n`);
    let names = ['a_tool', 'b_tool'];
    const connect = async (): Promise<McpSession> => ({
      serverInfo: { name: 'x', version: '1' },
      listTools: async () => names.map((name) => ({ name, description: 'A tool that does something useful.', inputSchema: { type: 'object' } })),
      listPrompts: async () => [],
      listResources: async () => [],
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
    });
    expect((await runLite(dir, ['contract'], connect)).code).toBe(0);
    names = ['a_tool'];
    const r = await runLite(dir, ['contract'], connect);
    expect(r.code).toBe(1);
    expect(r.out).toContain('tool "b_tool" removed');
  });
});

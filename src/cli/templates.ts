/** record/replay/eval settings: only the Pro edition has the commands that read them. */
const PRO_CONFIG_BLOCKS = `  record: {
    cases: [
      // { name: 'list items', tool: 'list_items', arguments: { limit: 5 } },
    ],
  },
  replay: {
    // Keys ignored anywhere in responses, e.g. generated IDs and timestamps.
    ignoreKeys: ['id', 'createdAt', 'updatedAt'],
    matchers: [
      // { path: '$.content[*].text.total', match: 'type' },
    ],
  },
  eval: {
    model: 'claude-sonnet-5',
    trials: 3,
    passThreshold: 0.8,
    source: 'live',
  },
`;

/** The mcp-eval.config.ts that "mcp-eval init" writes. Lite omits the record/replay/eval blocks. */
export function configTemplate(packageName: string, pro: boolean): string {
  return `import { defineConfig } from '${packageName}';

export default defineConfig({
  name: 'my-server',
  // stdio: the command that starts your server. For HTTP use:
  // server: { transport: 'http', url: 'http://localhost:3000/mcp', headers: { Authorization: \`Bearer \${process.env.MCP_TOKEN}\` } },
  server: { transport: 'stdio', command: 'node', args: ['dist/index.js'] },
  lint: { minDescriptionLength: 20 },
  // Extra secrets to scrub from ${pro ? 'snapshots and cassettes' : 'snapshots'} (authorization, api_key, token, password are always redacted).
  redact: { keys: [], patterns: [] },
${pro ? PRO_CONFIG_BLOCKS : ''}});
`;
}

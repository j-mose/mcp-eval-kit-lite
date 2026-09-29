# mcp-eval-kit-lite

Contract tests for MCP servers. Catch the change that silently breaks every client before you ship it.

- **Snapshots** your server's tools, prompts and resources into `mcp-snapshots/*.json` (commit it).
- **Diffs** every run against the snapshot and classifies each change:
  - **breaking**: tool removed, required parameter added, parameter removed, type narrowed, enum value removed
  - **risky**: description rewritten, annotation hints changed, output schema changed
  - **safe**: optional parameter added, tool added, type widened
- **Lints** tool definitions: missing or short descriptions, vague names, parameters without descriptions, names that are neither snake_case nor camelCase, and input schemas that break the MCP spec.
- **Exits non-zero** on breaking changes, so CI blocks the PR.

Works with any MCP server over stdio or Streamable HTTP, in any language. Node >= 22.12.

## Quick start

```bash
npm install --save-dev mcp-eval-kit-lite
npx mcp-eval init          # writes mcp-eval.config.ts
# edit the server command in mcp-eval.config.ts
npx mcp-eval contract      # first run creates mcp-snapshots/<name>.json
git add mcp-snapshots && git commit -m "test: add MCP contract snapshot"
```

From then on, `npx mcp-eval contract` fails when a change would break clients:

```
FAIL  Contract: 2 breaking, 1 risky, 0 safe; 0 lint issue(s)

SEVERITY  TARGET             CHANGE
BREAKING  tool:create_note   required parameter "folder" added
BREAKING  tool:delete_note   tool "delete_note" removed
RISKY     tool:search_notes  description changed (similarity 0.08)
```

If the change is intended, accept it with `npx mcp-eval contract --update` and commit the new snapshot.

## Config

```ts
// mcp-eval.config.ts
import { defineConfig } from 'mcp-eval-kit-lite';

export default defineConfig({
  name: 'my-server',
  server: { transport: 'stdio', command: 'node', args: ['dist/index.js'], env: { API_URL: 'http://localhost:8080' } },
  // or: server: { transport: 'http', url: 'http://localhost:3000/mcp', headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } },
  lint: { minDescriptionLength: 20, disable: [] },
});
```

stdio servers inherit only a safe default environment (PATH, HOME, ...) plus `server.env`. Pass anything else your server needs through `server.env`.

Flags: `--update` accepts the current schemas; `--fail-on-lint` also fails on lint errors; `-c <path>` picks a config file.

## Want more?

**MCP Eval Kit Pro** adds record/replay tests with field-level matchers, LLM tool-use evals (does Claude actually call your tools correctly?), HTML/Markdown/JUnit reports and a GitHub Actions workflow that comments on every PR. Get it at https://kane.lemonsqueezy.com/checkout/buy/f61b0463-82f8-4862-98b0-85b68447ddcd. Questions or feedback: open an issue on this repo.

## License

MIT

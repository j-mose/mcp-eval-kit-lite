import { inlineLocalRefs, isPlainObject } from '../json.js';
import type { JsonSchema, LintIssue, LintOptions, LintRule, Snapshot } from '../types.js';

export const DEFAULT_LINT: LintOptions = {
  minDescriptionLength: 20,
  vagueNames: ['do', 'run', 'execute', 'process', 'handle', 'tool', 'action', 'call', 'data', 'helper', 'misc', 'util', 'utils', 'stuff', 'thing', 'manage', 'perform', 'get', 'set', 'info'],
  disable: [],
};

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;

export function isWellFormedName(name: string): boolean {
  return SNAKE.test(name) || CAMEL.test(name);
}

/** Splits snake_case, kebab-case, dotted and camelCase names into lowercase words. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * Visits every object property (recursing into nested objects and array items). A property whose
 * schema is neither an object nor a boolean (e.g. `null` from a broken server) goes to `invalid`
 * instead and is not descended into.
 */
function walkParams(schema: JsonSchema, prefix: string, visit: (path: string, s: JsonSchema) => void, invalid: (path: string, s: unknown) => void): void {
  const properties = isPlainObject(schema.properties) ? (schema.properties as Record<string, unknown>) : {};
  for (const [k, raw] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!isPlainObject(raw) && typeof raw !== 'boolean') {
      invalid(path, raw);
      continue;
    }
    const s = (isPlainObject(raw) ? raw : {}) as JsonSchema;
    visit(path, s);
    walkParams(s, path, visit, invalid);
    if (isPlainObject(s.items)) walkParams(s.items as JsonSchema, `${path}[]`, visit, invalid);
  }
}

export function lintSnapshot(snap: Snapshot, opts: LintOptions): LintIssue[] {
  const out: LintIssue[] = [];
  const on = (r: LintRule): boolean => !opts.disable.includes(r);
  const vague = new Set(opts.vagueNames.map((v) => v.toLowerCase()));

  for (const tool of snap.tools) {
    const target = `tool:${tool.name}`;
    if (!isPlainObject(tool.inputSchema)) {
      if (on('invalid-input-schema')) {
        out.push({ rule: 'invalid-input-schema', level: 'error', target, message: `inputSchema.type must be "object" (MCP spec); got ${JSON.stringify(tool.inputSchema ?? null)}. Strict MCP clients reject the whole tools/list response.` });
      }
    } else if (on('invalid-input-schema') && tool.inputSchema.type !== 'object') {
      out.push({ rule: 'invalid-input-schema', level: 'error', target, message: `inputSchema.type must be "object" (MCP spec); got ${JSON.stringify(tool.inputSchema.type ?? null)}. Strict MCP clients reject the whole tools/list response.` });
    }
    const desc = tool.description?.trim() ?? '';
    if (desc.length === 0) {
      if (on('missing-description')) out.push({ rule: 'missing-description', level: 'error', target, message: 'tool has no description; the model cannot tell when to call it' });
    } else if (desc.length < opts.minDescriptionLength && on('short-description')) {
      out.push({ rule: 'short-description', level: 'warning', target, message: `description is ${desc.length} chars; aim for at least ${opts.minDescriptionLength}` });
    }
    const tokens = nameTokens(tool.name);
    if (on('vague-name') && tokens.length > 0 && tokens.every((t) => vague.has(t))) {
      out.push({ rule: 'vague-name', level: 'warning', target, message: `name "${tool.name}" says nothing about what the tool does` });
    }
    if (on('name-style') && !isWellFormedName(tool.name)) {
      out.push({ rule: 'name-style', level: 'warning', target, message: `name "${tool.name}" is neither snake_case nor camelCase` });
    }
    if (isPlainObject(tool.inputSchema)) {
      // Params behind a local $ref ($defs/definitions) are linted like inline ones.
      walkParams(inlineLocalRefs(tool.inputSchema) as JsonSchema, '', (path, s) => {
        const leaf = path.split('.').pop()!.replace(/\[\]$/, '');
        if (on('param-missing-description') && !(typeof s.description === 'string' && s.description.trim())) {
          out.push({ rule: 'param-missing-description', level: 'warning', target, path, message: `parameter "${path}" has no description` });
        }
        if (on('name-style') && !isWellFormedName(leaf)) {
          out.push({ rule: 'name-style', level: 'warning', target, path, message: `parameter "${path}" is neither snake_case nor camelCase` });
        }
      }, (path, raw) => {
        if (on('invalid-input-schema')) {
          out.push({ rule: 'invalid-input-schema', level: 'error', target, path, message: `parameter "${path}" schema must be an object; got ${JSON.stringify(raw ?? null)}` });
        }
      });
    }
  }
  return out;
}

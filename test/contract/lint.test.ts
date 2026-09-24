import { describe, expect, it } from 'vitest';
import { DEFAULT_LINT, isWellFormedName, lintSnapshot, nameTokens } from '../../src/contract/lint.js';
import type { Snapshot, ToolSnapshot } from '../../src/types.js';

const snap = (tools: ToolSnapshot[]): Snapshot => ({ version: 1, server: { name: 's', version: '1' }, tools, prompts: [], resources: [] });
const good: ToolSnapshot = {
  name: 'create_note',
  description: 'Create a note with a title and a markdown body.',
  inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Title of the note' } } },
};
const rules = (tools: ToolSnapshot[], opts = DEFAULT_LINT): string[] => lintSnapshot(snap(tools), opts).map((i) => `${i.rule}${i.path ? `:${i.path}` : ''}`);

describe('lintSnapshot', () => {
  it('passes a well-described tool', () => {
    expect(rules([good])).toEqual([]);
  });

  it('flags a missing description as an error', () => {
    const issues = lintSnapshot(snap([{ ...good, description: '  ' }]), DEFAULT_LINT);
    expect(issues).toEqual([expect.objectContaining({ rule: 'missing-description', level: 'error', target: 'tool:create_note' })]);
  });

  it('flags an inputSchema that is not type object as an error', () => {
    const issues = lintSnapshot(snap([{ ...good, inputSchema: { properties: {} } }]), DEFAULT_LINT);
    expect(issues).toEqual([expect.objectContaining({ rule: 'invalid-input-schema', level: 'error' })]);
  });

  it('flags missing or null inputSchema as an error', () => {
    const issuesUndefined = lintSnapshot(snap([{ ...good, inputSchema: undefined as unknown as Record<string, unknown> }]), DEFAULT_LINT);
    expect(issuesUndefined).toEqual([expect.objectContaining({ rule: 'invalid-input-schema', level: 'error' })]);
    const issuesNull = lintSnapshot(snap([{ ...good, inputSchema: null as unknown as Record<string, unknown> }]), DEFAULT_LINT);
    expect(issuesNull).toEqual([expect.objectContaining({ rule: 'invalid-input-schema', level: 'error' })]);
  });

  it('flags short descriptions', () => {
    expect(rules([{ ...good, description: 'Makes note' }])).toEqual(['short-description']);
  });

  it('flags vague names only when every word is vague', () => {
    expect(rules([{ ...good, name: 'run' }])).toEqual(['vague-name']);
    expect(rules([{ ...good, name: 'do_action' }])).toEqual(['vague-name']);
    expect(rules([{ ...good, name: 'getData' }])).toEqual(['vague-name']);
    expect(rules([{ ...good, name: 'get_note' }])).toEqual([]);
  });

  it('flags params without descriptions, including nested ones', () => {
    const t: ToolSnapshot = {
      ...good,
      inputSchema: { type: 'object', properties: { filter: { type: 'object', description: 'f', properties: { tag: { type: 'string' } } } } },
    };
    expect(rules([t])).toEqual(['param-missing-description:filter.tag']);
  });

  it('flags names that are neither snake_case nor camelCase', () => {
    const t: ToolSnapshot = { ...good, name: 'Create-Note', inputSchema: { type: 'object', properties: { 'Bad Name': { type: 'string', description: 'x' } } } };
    expect(rules([t])).toEqual(['name-style', 'name-style:Bad Name']);
  });

  it('respects disabled rules and custom minimum length', () => {
    const opts = { ...DEFAULT_LINT, disable: ['short-description' as const], minDescriptionLength: 500 };
    expect(rules([good], opts)).toEqual([]);
  });

  it('lints params behind a local $ref', () => {
    const t: ToolSnapshot = {
      ...good,
      inputSchema: {
        type: 'object',
        properties: { address: { $ref: '#/$defs/Address', description: 'Shipping address' } },
        $defs: { Address: { type: 'object', properties: { Zip_Code: { type: 'string' } } } },
      },
    };
    expect(rules([t])).toEqual(['param-missing-description:address.Zip_Code', 'name-style:address.Zip_Code']);
  });

  it('reports a null param schema instead of crashing', () => {
    const t: ToolSnapshot = { ...good, inputSchema: { type: 'object', properties: { a: null, b: { type: 'string', description: 'The b value' } } } };
    const issues = lintSnapshot(snap([t]), DEFAULT_LINT);
    expect(issues).toEqual([expect.objectContaining({ rule: 'invalid-input-schema', level: 'error', path: 'a' })]);
  });
});

describe('name helpers', () => {
  it('tokenizes and validates names', () => {
    expect(nameTokens('getNoteById')).toEqual(['get', 'note', 'by', 'id']);
    expect(nameTokens('admin.tools-list_all')).toEqual(['admin', 'tools', 'list', 'all']);
    expect(isWellFormedName('list_notes')).toBe(true);
    expect(isWellFormedName('listNotes')).toBe(true);
    expect(isWellFormedName('ListNotes')).toBe(false);
    expect(isWellFormedName('list-notes')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { diffSnapshots, wordSimilarity } from '../../src/contract/diff.js';
import type { Snapshot, ToolSnapshot } from '../../src/types.js';

const tool = (over: Partial<ToolSnapshot> = {}): ToolSnapshot => ({
  name: 'create_note',
  description: 'Create a note with a title and body text',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Note title' },
      body: { type: 'string', description: 'Note body' },
      priority: { type: 'string', enum: ['low', 'high'], description: 'Priority' },
      limit: { type: 'number', maximum: 100, description: 'Max' },
    },
    required: ['title'],
  },
  ...over,
});

const snap = (tools: ToolSnapshot[], extra: Partial<Snapshot> = {}): Snapshot => ({
  version: 1,
  server: { name: 's', version: '1' },
  tools,
  prompts: [],
  resources: [],
  ...extra,
});

const withSchema = (mutate: (s: Record<string, any>) => void): ToolSnapshot => {
  const t = tool();
  const schema = structuredClone(t.inputSchema) as Record<string, any>;
  mutate(schema);
  return { ...t, inputSchema: schema };
};

const kinds = (before: Snapshot, after: Snapshot): string[] => diffSnapshots(before, after).map((c) => `${c.severity}:${c.kind}${c.path ? `:${c.path}` : ''}`);

describe('diffSnapshots', () => {
  it('reports nothing for identical snapshots', () => {
    expect(diffSnapshots(snap([tool()]), snap([tool()]))).toEqual([]);
  });

  it('tool removed is breaking, tool added is safe', () => {
    const other = { ...tool(), name: 'list_notes' };
    expect(kinds(snap([tool()]), snap([other]))).toEqual(['breaking:tool-removed', 'safe:tool-added']);
  });

  it('required param added is breaking', () => {
    const after = withSchema((s) => { s.properties.folder = { type: 'string', description: 'f' }; s.required.push('folder'); });
    expect(kinds(snap([tool()]), snap([after]))).toEqual(['breaking:param-required-added:folder']);
  });

  it('optional param added is safe', () => {
    const after = withSchema((s) => { s.properties.tags = { type: 'array', items: { type: 'string' }, description: 't' }; });
    expect(kinds(snap([tool()]), snap([after]))).toEqual(['safe:param-optional-added:tags']);
  });

  it('param removed is breaking', () => {
    const after = withSchema((s) => { delete s.properties.body; });
    expect(kinds(snap([tool()]), snap([after]))).toEqual(['breaking:param-removed:body']);
  });

  it('a renamed param shows as removed + required added', () => {
    const after = withSchema((s) => { s.properties.name = s.properties.title; delete s.properties.title; s.required = ['name']; });
    expect(kinds(snap([tool()]), snap([after]))).toEqual(['breaking:param-removed:title', 'breaking:param-required-added:name']);
  });

  it('optional -> required is breaking; required -> optional is safe', () => {
    const tighter = withSchema((s) => { s.required = ['title', 'body']; });
    expect(kinds(snap([tool()]), snap([tighter]))).toEqual(['breaking:param-became-required:body']);
    const looser = withSchema((s) => { s.required = []; });
    expect(kinds(snap([tool()]), snap([looser]))).toEqual(['safe:param-became-optional:title']);
  });

  it('type narrowed is breaking, widened is safe, changed is breaking', () => {
    const narrowed = withSchema((s) => { s.properties.limit.type = 'integer'; });
    expect(kinds(snap([tool()]), snap([narrowed]))).toEqual(['breaking:type-narrowed:limit']);
    const widened = withSchema((s) => { s.properties.title.type = ['string', 'null']; });
    expect(kinds(snap([tool()]), snap([widened]))).toEqual(['safe:type-widened:title']);
    const changed = withSchema((s) => { s.properties.title.type = 'number'; });
    expect(kinds(snap([tool()]), snap([changed]))).toEqual(['breaking:type-changed:title']);
  });

  it('enum value removed is breaking, added is safe', () => {
    const removed = withSchema((s) => { s.properties.priority.enum = ['low']; });
    expect(kinds(snap([tool()]), snap([removed]))).toEqual(['breaking:enum-value-removed:priority']);
    const added = withSchema((s) => { s.properties.priority.enum = ['low', 'high', 'urgent']; });
    expect(kinds(snap([tool()]), snap([added]))).toEqual(['safe:enum-value-added:priority']);
  });

  it('introducing an enum on a free string is a narrowing', () => {
    const after = withSchema((s) => { s.properties.body.enum = ['a', 'b']; });
    expect(kinds(snap([tool()]), snap([after]))).toEqual(['breaking:type-narrowed:body']);
  });

  it('tightened numeric bounds are breaking, loosened are safe', () => {
    const tighter = withSchema((s) => { s.properties.limit.maximum = 50; });
    expect(kinds(snap([tool()]), snap([tighter]))).toEqual(['breaking:constraint-narrowed:limit']);
    const looser = withSchema((s) => { s.properties.limit.maximum = 500; });
    expect(kinds(snap([tool()]), snap([looser]))).toEqual(['safe:constraint-widened:limit']);
  });

  it('recurses into nested objects and array items', () => {
    const base = withSchema((s) => {
      s.properties.filter = { type: 'object', description: 'f', properties: { tags: { type: 'array', description: 't', items: { type: 'string', enum: ['a', 'b'] } } } };
    });
    const after = structuredClone(base);
    (after.inputSchema as any).properties.filter.properties.tags.items.enum = ['a'];
    expect(kinds(snap([base]), snap([after]))).toEqual(['breaking:enum-value-removed:filter.tags[]']);
  });

  it('a rewritten description is risky, a small edit is safe', () => {
    const rewritten = tool({ description: 'Deletes every archived record permanently' });
    expect(kinds(snap([tool()]), snap([rewritten]))).toEqual(['risky:description-changed']);
    const tweaked = tool({ description: 'Create a note with a title and optional body text' });
    expect(kinds(snap([tool()]), snap([tweaked]))).toEqual(['safe:description-changed']);
  });

  it('annotation changes are risky, compared after spec defaults, one per hint', () => {
    const after = tool({ annotations: { destructiveHint: true } });
    const changes = diffSnapshots(snap([tool({ annotations: { destructiveHint: false } })]), snap([after]));
    expect(changes.map((c) => `${c.severity}:${c.kind}:${c.message}`)).toEqual(['risky:annotation-changed:destructiveHint false -> true']);
    // Spelling out a default is not a change.
    expect(diffSnapshots(snap([tool()]), snap([tool({ annotations: { openWorldHint: true, title: 'Create' } })]))).toEqual([]);
    // destructive/idempotent hints are ignored while the tool stays read-only.
    expect(diffSnapshots(snap([tool({ annotations: { readOnlyHint: true } })]), snap([tool({ annotations: { readOnlyHint: true, destructiveHint: false } })]))).toEqual([]);
    expect(diffSnapshots(snap([tool({ annotations: { readOnlyHint: true } })]), snap([tool({ annotations: { readOnlyHint: true, openWorldHint: false } })])).map((c) => c.message)).toEqual(['openWorldHint true -> false']);
  });

  it('ignores $schema and key order', () => {
    const a = withSchema((s) => { s.$schema = 'http://json-schema.org/draft-07/schema#'; });
    const b = tool({ inputSchema: { required: ['title'], properties: tool().inputSchema.properties, type: 'object' } });
    expect(diffSnapshots(snap([a]), snap([b]))).toEqual([]);
  });

  it('classifies prompts and resources', () => {
    const before = snap([], {
      prompts: [{ name: 'summarize', arguments: [{ name: 'style', required: false }] }, { name: 'old', arguments: [] }],
      resources: [{ name: 'all', uri: 'notes://all' }],
    });
    const after = snap([], {
      prompts: [{ name: 'summarize', arguments: [{ name: 'style', required: true }, { name: 'lang', required: false }] }],
      resources: [{ name: 'recent', uri: 'notes://recent' }],
    });
    expect(kinds(before, after)).toEqual([
      'breaking:prompt-arg-required-added:style',
      'breaking:prompt-removed',
      'breaking:resource-removed',
      'safe:prompt-arg-optional-added:lang',
      'safe:resource-added',
    ]);
  });

  it('sorts breaking before risky before safe', () => {
    const after = { ...tool({ description: 'Totally different words entirely here' }), name: 'create_note' };
    const added = { ...tool(), name: 'z_tool' };
    const severities = diffSnapshots(snap([tool(), { ...tool(), name: 'gone' }]), snap([after, added])).map((c) => c.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ['breaking', 'risky', 'safe'].indexOf(a) - ['breaking', 'risky', 'safe'].indexOf(b)));
  });
});

// Fixtures below match what zod 4's `z.toJSONSchema()` actually emits (verified against zod
// 4.6.5 in this repo's node_modules), for the schema shapes noted in each comment.
describe('diffSnapshots: fix round 1 regressions', () => {
  const toolWith = (inputSchema: Record<string, any>): ToolSnapshot => ({
    name: 't',
    inputSchema,
  });

  it('traverses anyOf: a change inside a matched branch is detected (z.object({...}).nullable())', () => {
    // z.object({ f: z.object({ a: z.string() }).nullable() })
    const before = toolWith({
      type: 'object',
      properties: {
        f: {
          anyOf: [
            { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
            { type: 'null' },
          ],
        },
      },
      required: ['f'],
    });
    // ...with a required `b` added inside the nullable object branch.
    const after = toolWith({
      type: 'object',
      properties: {
        f: {
          anyOf: [
            { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'], additionalProperties: false },
            { type: 'null' },
          ],
        },
      },
      required: ['f'],
    });
    expect(kinds(snap([before]), snap([after]))).toEqual(['breaking:param-required-added:f.b']);
  });

  it('traverses anyOf: a branch removed from anyOf[string,number,boolean] is breaking', () => {
    const before = toolWith({ type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } } });
    const after = toolWith({ type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'number' }] } } });
    expect(kinds(snap([before]), snap([after]))).toEqual(['breaking:type-narrowed:v']);
  });

  it('dropping the null branch of a nullable field is breaking; adding one is safe', () => {
    const nullable = toolWith({ type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'null' }] } } });
    const plain = toolWith({ type: 'object', properties: { v: { type: 'string' } } });
    expect(kinds(snap([nullable]), snap([plain]))).toEqual(['breaking:type-narrowed:v']);
    expect(kinds(snap([plain]), snap([nullable]))).toEqual(['safe:type-widened:v']);
  });

  it('treats `const` as a one-value enum, so a changed literal is detected', () => {
    // z.literal('a') -> z.literal('b')
    const before = toolWith({ type: 'object', properties: { k: { type: 'string', const: 'a' } } });
    const after = toolWith({ type: 'object', properties: { k: { type: 'string', const: 'b' } } });
    expect(kinds(snap([before]), snap([after]))).toEqual(['breaking:enum-value-removed:k', 'safe:enum-value-added:k']);
  });

  it('recurses into additionalProperties as a schema (z.record value type narrowed)', () => {
    // z.record(z.string(), z.union([z.string(), z.number()])) -> z.record(z.string(), z.string())
    const before = toolWith({ type: 'object', properties: { m: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: ['string', 'number'] } } } });
    const after = toolWith({ type: 'object', properties: { m: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'string' } } } });
    expect(kinds(snap([before]), snap([after]))).toEqual(['breaking:type-narrowed:m{}']);
  });

  it('restricting additionalProperties to a schema is breaking; removing that restriction is safe', () => {
    const open = toolWith({ type: 'object', properties: { m: { type: 'object' } } });
    const restricted = toolWith({ type: 'object', properties: { m: { type: 'object', additionalProperties: { type: 'string' } } } });
    expect(kinds(snap([open]), snap([restricted]))).toEqual(['breaking:constraint-narrowed:m']);
    expect(kinds(snap([restricted]), snap([open]))).toEqual(['safe:constraint-widened:m']);
  });

  it('adding an items schema to an untyped array is breaking; removing it is safe', () => {
    const untyped = toolWith({ type: 'object', properties: { a: { type: 'array' } } });
    const typed = toolWith({ type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } });
    expect(kinds(snap([untyped]), snap([typed]))).toEqual(['breaking:constraint-narrowed:a']);
    expect(kinds(snap([typed]), snap([untyped]))).toEqual(['safe:constraint-widened:a']);
  });

  it('ignores $schema inside outputSchema', () => {
    const before = tool({ outputSchema: { type: 'object' } });
    const after = tool({ outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' } });
    expect(diffSnapshots(snap([before]), snap([after]))).toEqual([]);
  });

  it('a required entry with no matching property in either schema is still breaking', () => {
    const before = toolWith({ type: 'object', properties: {} });
    const after = toolWith({ type: 'object', properties: {}, required: ['x'] });
    expect(kinds(snap([before]), snap([after]))).toEqual(['breaking:param-required-added:x']);
  });
});

// Fixtures below match what zod 4's `z.toJSONSchema()` actually emits (verified against zod
// 4.6.5 in this repo's node_modules), for the schema shapes noted in each comment.
describe('diffSnapshots: fix round 2 regressions (anyOf branch pairing)', () => {
  const toolWith = (inputSchema: Record<string, any>): ToolSnapshot => ({
    name: 't',
    inputSchema,
  });

  // const X = z.object({ k: z.literal('x'), a: z.string() }), Y = z.object({ k: z.literal('y') }), W = z.object({ k: z.literal('w') });
  const X = { type: 'object', properties: { k: { type: 'string', const: 'x' }, a: { type: 'string' } }, required: ['k', 'a'], additionalProperties: false };
  const Y = { type: 'object', properties: { k: { type: 'string', const: 'y' } }, required: ['k'], additionalProperties: false };
  const W = { type: 'object', properties: { k: { type: 'string', const: 'w' } }, required: ['k'], additionalProperties: false };

  it('a discriminated union variant prepended is safe only (branches paired by discriminator, not position)', () => {
    // z.discriminatedUnion('k', [X, Y]) -> z.discriminatedUnion('k', [W, X, Y])
    const before = toolWith({ type: 'object', properties: { d: { oneOf: [X, Y] } } });
    const after = toolWith({ type: 'object', properties: { d: { oneOf: [W, X, Y] } } });
    expect(kinds(snap([before]), snap([after]))).toEqual(['safe:type-widened:d']);
  });

  it('discriminated union variants reordered is a no-op', () => {
    const before = toolWith({ type: 'object', properties: { d: { oneOf: [X, Y] } } });
    const after = toolWith({ type: 'object', properties: { d: { oneOf: [Y, X] } } });
    expect(diffSnapshots(snap([before]), snap([after]))).toEqual([]);
  });

  it('a literal prepended to a literal union is safe only', () => {
    // z.union([z.literal('a'), z.literal('b')]) -> z.union([z.literal('c'), z.literal('a'), z.literal('b')])
    const before = toolWith({ type: 'object', properties: { u: { anyOf: [{ type: 'string', const: 'a' }, { type: 'string', const: 'b' }] } } });
    const after = toolWith({ type: 'object', properties: { u: { anyOf: [{ type: 'string', const: 'c' }, { type: 'string', const: 'a' }, { type: 'string', const: 'b' }] } } });
    expect(kinds(snap([before]), snap([after]))).toEqual(['safe:type-widened:u']);
  });

  it('a literal removed from a literal union is breaking and names the removed value', () => {
    // z.union([z.literal('a'), z.literal('b')]) -> z.union([z.literal('b')])
    const before = toolWith({ type: 'object', properties: { u: { anyOf: [{ type: 'string', const: 'a' }, { type: 'string', const: 'b' }] } } });
    const after = toolWith({ type: 'object', properties: { u: { anyOf: [{ type: 'string', const: 'b' }] } } });
    const changes = diffSnapshots(snap([before]), snap([after]));
    expect(changes.map((c) => `${c.severity}:${c.kind}:${c.path}`)).toEqual(['breaking:type-narrowed:u']);
    expect(changes[0]?.message).toContain('"a"');
  });

  it('int -> number inside a nullable field is safe only, not a false breaking narrow', () => {
    // z.int().nullable() -> z.number().nullable() (zod emits the latter as {type: ["number", "null"]})
    const before = toolWith({ type: 'object', properties: { n: { anyOf: [{ type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 }, { type: 'null' }] } } });
    const after = toolWith({ type: 'object', properties: { n: { type: ['number', 'null'] } } });
    const changes = diffSnapshots(snap([before]), snap([after]));
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.severity === 'safe')).toBe(true);
    expect(changes.some((c) => c.kind === 'type-widened')).toBe(true);
  });
});

// Fixtures below match what zod 4's `z.toJSONSchema()` actually emits (verified against zod
// 4.6.5 in this repo's node_modules), for the schema shapes noted in each comment.
describe('diffSnapshots: fix round 3 regressions (identity uniqueness, synthetic-branch duplication)', () => {
  const toolWith = (inputSchema: Record<string, any>): ToolSnapshot => ({
    name: 't',
    inputSchema,
  });

  // const X = z.object({ k: z.literal('x'), ver: z.literal(1), a: z.string() });
  // const Y = z.object({ k: z.literal('y'), ver: z.literal(1), b: z.number() });
  // const W = z.object({ k: z.literal('w'), ver: z.literal(1) });
  // `ver` is a literal(1) shared by every variant, so it must NOT be used as an identity key —
  // only `k` (unique per variant) may pair branches.
  const X = { type: 'object', properties: { k: { type: 'string', const: 'x' }, ver: { type: 'number', const: 1 }, a: { type: 'string' } }, required: ['k', 'ver', 'a'], additionalProperties: false };
  const Y = { type: 'object', properties: { k: { type: 'string', const: 'y' }, ver: { type: 'number', const: 1 }, b: { type: 'number' } }, required: ['k', 'ver', 'b'], additionalProperties: false };
  const W = { type: 'object', properties: { k: { type: 'string', const: 'w' }, ver: { type: 'number', const: 1 } }, required: ['k', 'ver'], additionalProperties: false };

  it('a shared literal on every DU variant is not used for identity: reordering is a no-op', () => {
    const before = toolWith({ type: 'object', properties: { v: { oneOf: [X, Y] } } });
    const after = toolWith({ type: 'object', properties: { v: { oneOf: [Y, X] } } });
    expect(diffSnapshots(snap([before]), snap([after]))).toEqual([]);
  });

  it('a shared literal on every DU variant is not used for identity: prepending a variant is safe only', () => {
    const before = toolWith({ type: 'object', properties: { v: { oneOf: [X, Y] } } });
    const after = toolWith({ type: 'object', properties: { v: { oneOf: [W, X, Y] } } });
    expect(kinds(snap([before]), snap([after]))).toEqual(['safe:type-widened:v']);
  });

  it('a described nullable int -> number is safe only (no duplicate description-changed from synthesized branches)', () => {
    // z.int().nullable().describe('d') -> z.number().nullable().describe('d')
    const before = toolWith({ type: 'object', properties: { v: { anyOf: [{ type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 }, { type: 'null' }], description: 'd' } } });
    const after = toolWith({ type: 'object', properties: { v: { type: ['number', 'null'], description: 'd' } } });
    const changes = diffSnapshots(snap([before]), snap([after]));
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.severity === 'safe')).toBe(true);
    expect(changes.some((c) => c.kind === 'description-changed')).toBe(false);
  });

  it('a described nullable number -> number.min(0) gives exactly the breaking constraint row', () => {
    // z.number().nullable().describe('d') -> z.number().min(0).nullable().describe('d')
    const before = toolWith({ type: 'object', properties: { v: { type: ['number', 'null'], description: 'd' } } });
    const after = toolWith({ type: 'object', properties: { v: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }], description: 'd' } } });
    expect(kinds(snap([before]), snap([after]))).toEqual(['breaking:constraint-narrowed:v']);
  });
});

// Fixtures match zod 4.6.5 `z.toJSONSchema()` output for the shapes in each comment.
describe('diffSnapshots: fix round 4 regressions (plain <-> nullable keeps constraint comparison in the branch)', () => {
  const withV = (v: Record<string, any>): ToolSnapshot => ({
    name: 't',
    inputSchema: { type: 'object', properties: { v }, required: ['v'], additionalProperties: false },
  });
  const run = (a: Record<string, any>, b: Record<string, any>) => diffSnapshots(snap([withV(a)]), snap([withV(b)]));
  const rows = (a: Record<string, any>, b: Record<string, any>) => run(a, b).map((c) => `${c.severity}:${c.kind}:${c.path ?? ''}:${c.message}`);
  // z.int()
  const SAFE_INT = { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 };

  it('number().min(0) -> number().min(0).nullable() gives only the safe branch-added row', () => {
    expect(rows({ type: 'number', minimum: 0 }, { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] }))
      .toEqual(['safe:type-widened:v:"v" branch added']);
  });

  it('number().min(0) -> number().min(5).nullable() gives exactly one breaking 0 -> 5 plus the branch-added row', () => {
    expect(rows({ type: 'number', minimum: 0 }, { anyOf: [{ type: 'number', minimum: 5 }, { type: 'null' }] }))
      .toEqual(['breaking:constraint-narrowed:v:"v" minimum 0 -> 5', 'safe:type-widened:v:"v" branch added']);
  });

  it('int() -> int().nullable() is safe only', () => {
    expect(rows(SAFE_INT, { anyOf: [SAFE_INT, { type: 'null' }] })).toEqual(['safe:type-widened:v:"v" branch added']);
  });

  it('object({a}) -> object({a}).nullable() is safe only', () => {
    const obj = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
    expect(rows(obj, { anyOf: [obj, { type: 'null' }] })).toEqual(['safe:type-widened:v:"v" branch added']);
  });

  it('number().min(0).nullable() -> number().min(0) gives exactly the breaking null-removed row', () => {
    expect(rows({ anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] }, { type: 'number', minimum: 0 }))
      .toEqual(['breaking:type-narrowed:v:"v" branch removed']);
  });

  it('string().max(10), string().regex(/a/) and array().min(1) gain .nullable() safely', () => {
    for (const s of [{ type: 'string', maxLength: 10 }, { type: 'string', pattern: 'a' }, { type: 'array', items: { type: 'string' }, minItems: 1 }]) {
      expect(rows(s, { anyOf: [s, { type: 'null' }] })).toEqual(['safe:type-widened:v:"v" branch added']);
    }
  });

  it('describe() before or after nullable() is not a description change', () => {
    // z.string().describe('d').nullable() -> z.string().nullable().describe('d')
    const inner = { anyOf: [{ type: 'string', description: 'd' }, { type: 'null' }] };
    expect(rows(inner, { type: ['string', 'null'], description: 'd' })).toEqual([]);
    // hand-written: same with the description on an anyOf wrapper
    expect(rows(inner, { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'd' })).toEqual([]);
  });

  it('a type array and the equivalent anyOf compare equal, including constraints and enum (hand-written)', () => {
    expect(run({ anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] }, { type: ['number', 'null'], minimum: 0 })).toEqual([]);
    expect(run({ type: ['string', 'null'], enum: ['a', null] }, { anyOf: [{ type: 'string', enum: ['a'] }, { type: 'null' }] })).toEqual([]);
  });
});

describe('diffSnapshots: final review fixes', () => {
  const toolWith = (inputSchema: Record<string, any>): ToolSnapshot => ({ name: 't', inputSchema });
  const rows = (a: Record<string, any>, b: Record<string, any>) =>
    diffSnapshots(snap([toolWith(a)]), snap([toolWith(b)])).map((c) => `${c.severity}:${c.kind}:${c.path ?? ''}:${c.message}`);

  // pydantic (FastMCP) shape: an Enum and a nested model both live in $defs.
  const pydantic = (modes: string[], addressProps: Record<string, any>) => ({
    type: 'object',
    properties: {
      mode: { $ref: '#/$defs/Mode' },
      address: { $ref: '#/$defs/Address', description: 'Where to ship' },
    },
    required: ['mode', 'address'],
    $defs: {
      Mode: { type: 'string', enum: modes, title: 'Mode' },
      Address: { type: 'object', properties: addressProps, required: Object.keys(addressProps), title: 'Address' },
    },
  });
  const ADDR = { street: { type: 'string' }, zip: { type: 'string' } };

  it('an enum value removed behind a $ref is breaking', () => {
    expect(rows(pydantic(['a', 'b'], ADDR), pydantic(['a'], ADDR))).toEqual(['breaking:enum-value-removed:mode:"mode" enum values removed: "b"']);
  });

  it('a field removed inside a $defs object is breaking', () => {
    expect(rows(pydantic(['a'], ADDR), pydantic(['a'], { street: { type: 'string' } }))).toEqual(['breaking:param-removed:address.zip:parameter "address.zip" removed']);
  });

  it('#/definitions refs resolve too', () => {
    const s = (modes: string[]) => ({ type: 'object', properties: { mode: { $ref: '#/definitions/Mode' } }, definitions: { Mode: { enum: modes } } });
    expect(rows(s(['a', 'b']), s(['a']))).toEqual(['breaking:enum-value-removed:mode:"mode" enum values removed: "b"']);
  });

  it('removing a required param named "definitions" is breaking', () => {
    const s = (withDefs: boolean) => ({
      type: 'object',
      properties: { q: { type: 'string' }, ...(withDefs ? { definitions: { type: 'array', items: { type: 'string' } } } : {}) },
      required: withDefs ? ['q', 'definitions'] : ['q'],
    });
    expect(rows(s(true), s(false))).toEqual(['breaking:param-removed:definitions:parameter "definitions" removed']);
  });

  it('removing an optional param named "$defs" follows the removed-param rule', () => {
    const s = (withDefs: boolean) => ({ type: 'object', properties: { q: { type: 'string' }, ...(withDefs ? { $defs: { type: 'object' } } : {}) } });
    expect(rows(s(true), s(false))).toEqual(['breaking:param-removed:$defs:parameter "$defs" removed']);
  });

  it('a real $defs keyword and a property named "definitions" coexist', () => {
    const s = (modes: string[], withProp = true) => ({
      type: 'object',
      properties: { mode: { $ref: '#/$defs/Mode' }, ...(withProp ? { definitions: { $ref: '#/$defs/Mode', description: 'd' } } : {}) },
      $defs: { Mode: { enum: modes } },
    });
    expect(rows(s(['a', 'b']), s(['a', 'b']))).toEqual([]);
    expect(rows(s(['a', 'b']), s(['a']))).toEqual([
      'breaking:enum-value-removed:mode:"mode" enum values removed: "b"',
      'breaking:enum-value-removed:definitions:"definitions" enum values removed: "b"',
    ]);
    expect(rows(s(['a']), s(['a'], false))).toEqual(['breaking:param-removed:definitions:parameter "definitions" removed']);
  });

  it('an unchanged $defs schema gives no changes', () => {
    expect(rows(pydantic(['a', 'b'], ADDR), pydantic(['a', 'b'], ADDR))).toEqual([]);
  });

  // z.object({ root: Node }) with Node = z.object({ name, get children() { return z.array(Node) } })
  const recursive = (extra: Record<string, any> = {}) => ({
    type: 'object',
    properties: { root: { $ref: '#/$defs/__schema0' } },
    required: ['root'],
    $defs: {
      __schema0: {
        type: 'object',
        properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/__schema0' } }, ...extra },
        required: ['name', 'children'],
      },
    },
  });

  it('a recursive schema diffs without hanging, and a change in it is found once', () => {
    expect(rows(recursive(), recursive())).toEqual([]);
    expect(rows(recursive(), recursive({ tag: { type: 'string' } }))).toEqual(['safe:param-optional-added:root.tag:optional parameter "root.tag" added']);
    const selfRef = { type: 'object', properties: { next: { $ref: '#' } } };
    expect(rows(selfRef, selfRef)).toEqual([]);
  });

  // Real zod 4.6.5 output for z.discriminatedUnion('k', [A, B]) and the same with .nullable().
  const A = { type: 'object', properties: { k: { type: 'string', const: 'a' }, x: { type: 'string' } }, required: ['k', 'x'] };
  const B = { type: 'object', properties: { k: { type: 'string', const: 'b' }, y: { type: 'number' } }, required: ['k', 'y'] };
  const withV = (v: Record<string, any>) => ({ type: 'object', properties: { v }, required: ['v'] });

  it('discriminatedUnion -> discriminatedUnion.nullable() is safe only', () => {
    expect(rows(withV({ oneOf: [A, B] }), withV({ anyOf: [{ oneOf: [A, B] }, { type: 'null' }] }))).toEqual(['safe:type-widened:v:"v" branch added']);
    // .describe('d') before or after .nullable()
    expect(rows(withV({ oneOf: [A, B], description: 'd' }), withV({ anyOf: [{ oneOf: [A, B], description: 'd' }, { type: 'null' }] }))).toEqual(['safe:type-widened:v:"v" branch added']);
    expect(rows(withV({ oneOf: [A, B], description: 'd' }), withV({ anyOf: [{ oneOf: [A, B] }, { type: 'null' }], description: 'd' }))).toEqual(['safe:type-widened:v:"v" branch added']);
  });

  it('literal union -> literal union.nullable() is safe only', () => {
    const L = [{ type: 'string', const: 'a' }, { type: 'string', const: 'b' }];
    expect(rows(withV({ anyOf: L }), withV({ anyOf: [{ anyOf: L }, { type: 'null' }] }))).toEqual(['safe:type-widened:v:"v" branch added']);
  });

  it('adding an empty items or additionalProperties schema is not a change', () => {
    expect(rows(withV({ type: 'array' }), withV({ type: 'array', items: {} }))).toEqual([]);
    expect(rows(withV({ type: 'array', items: {} }), withV({ type: 'array' }))).toEqual([]);
    expect(rows({ type: 'object', properties: {} }, { type: 'object', properties: {}, additionalProperties: {} })).toEqual([]);
    expect(rows({ type: 'object', properties: {}, additionalProperties: {} }, { type: 'object', properties: {}, additionalProperties: true })).toEqual([]);
  });

  it('a null property schema does not crash the diff', () => {
    expect(() => rows({ type: 'object', properties: { a: null } }, { type: 'object', properties: { a: null } })).not.toThrow();
    expect(rows({ type: 'object', properties: { a: null } }, { type: 'object', properties: { a: null } })).toEqual([]);
    expect(rows({ type: 'object', properties: { a: null } }, { type: 'object', properties: { a: { type: 'string' } } })).toEqual(['breaking:type-narrowed:a:"a" type narrowed: array|boolean|integer|null|number|object|string -> string']);
  });
});

describe('wordSimilarity', () => {
  it('is 1 for identical text and 0 for disjoint text', () => {
    expect(wordSimilarity('Create a note', 'create a NOTE')).toBe(1);
    expect(wordSimilarity('alpha beta', 'gamma delta')).toBe(0);
  });
});

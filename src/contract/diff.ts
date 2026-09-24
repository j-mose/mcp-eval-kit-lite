import { deepEqual, inlineLocalRefs, isPlainObject } from '../json.js';
import type { Change, JsonSchema, PromptSnapshot, Snapshot, ToolSnapshot } from '../types.js';

/** Jaccard similarity of lowercase word sets. Below this, a description change is "risky". */
export const RISKY_DESCRIPTION_SIMILARITY = 0.5;

export function wordSimilarity(a: string, b: string): number {
  const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

const ALL_TYPES = ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'];

/** The set of JSON types a schema accepts. No "type" means any type. "number" includes "integer". */
function typeSet(schema: JsonSchema): Set<string> {
  const t = schema.type;
  const list = typeof t === 'string' ? [t] : Array.isArray(t) ? (t.filter((x) => typeof x === 'string') as string[]) : ALL_TYPES;
  const set = new Set(list);
  if (set.has('number')) set.add('integer');
  return set;
}

const isSubset = (a: Set<string>, b: Set<string>): boolean => [...a].every((x) => b.has(x));

/** Annotation keywords: compared once, at the level of the whole (possibly union) schema. */
const ANNOTATION_KEYS = ['description', 'title'];

/** Keywords that only constrain values of one JSON type. */
const KEYWORD_TYPES: Record<string, string[]> = {};
for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) KEYWORD_TYPES[k] = ['number', 'integer'];
for (const k of ['minLength', 'maxLength', 'pattern', 'format']) KEYWORD_TYPES[k] = ['string'];
for (const k of ['items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'contains']) KEYWORD_TYPES[k] = ['array'];
for (const k of ['properties', 'required', 'additionalProperties', 'patternProperties', 'minProperties', 'maxProperties', 'propertyNames']) KEYWORD_TYPES[k] = ['object'];

function valueHasType(v: unknown, t: string): boolean {
  switch (t) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'integer': return Number.isInteger(v);
    case 'array': return Array.isArray(v);
    case 'object': return isPlainObject(v);
    default: return false;
  }
}

function withoutAnnotations(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };
  for (const k of ANNOTATION_KEYS) delete out[k];
  return out;
}

/** A non-object schema (e.g. `null` from a broken server) is treated as the empty schema. */
const asSchema = (v: unknown): JsonSchema => (isPlainObject(v) ? (v as JsonSchema) : {});

/** An empty schema (`{}`, ignoring annotations) accepts anything, same as no schema. */
const isEmptySchema = (s: JsonSchema): boolean => Object.keys(withoutAnnotations(s)).length === 0;

const unionList = (s: JsonSchema): unknown[] | undefined => (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined);

/** A union schema normalized to its description (compared once) and its branches (each self-contained). */
type BranchForm = { description: string; branches: JsonSchema[] };

const descOf = (s: JsonSchema): string => (typeof s.description === 'string' ? s.description : '');

/**
 * Normalizes a union schema to a branch list in which every branch carries every keyword that
 * applies to it, so each keyword is compared exactly once, between the two branches that carry it:
 *  - `anyOf`/`oneOf`: the outer schema's non-annotation siblings apply to every branch (JSON Schema
 *    ANDs them), so they are merged into each branch (the branch's own keyword wins on conflict).
 *    If the outer schema has no description and there is exactly one non-null branch (the
 *    `.nullable()` shape), that branch's description is hoisted to the outer level, so
 *    `X.describe(d).nullable()` and `X.nullable().describe(d)` normalize identically.
 *  - a multi-element `type` array (zod 4 emits `z.number().nullable()` as `{type: ['number', 'null']}`):
 *    one branch per type, carrying only the sibling keywords that constrain that type (`minimum`
 *    goes to the number branch, not the null one) and only the enum/const values of that type.
 *  - a branch that is itself an `anyOf`/`oneOf` (zod 4 emits `DU.nullable()` as
 *    `anyOf: [{oneOf: [A, B]}, {type: 'null'}]`) is flattened into its own branches, carrying the
 *    outer siblings down, so adding `.nullable()` to a union only adds the null branch.
 * Returns undefined for a plain (non-union) schema.
 */
function branchForm(schema: JsonSchema): BranchForm | undefined {
  const list = unionList(schema);
  if (list) {
    const siblings = withoutAnnotations(schema);
    delete siblings.anyOf;
    delete siblings.oneOf;
    let branches = list.map(asSchema).map((b) => (Object.keys(siblings).length ? { ...siblings, ...b } : b));
    let description = descOf(schema);
    if (typeof schema.description !== 'string') {
      const nonNull = branches.filter((b) => b.type !== 'null');
      const only = nonNull[0];
      if (nonNull.length === 1 && only && typeof only.description === 'string') {
        description = only.description;
        branches = branches.map((b) => (b === only ? withoutAnnotations(b) : b));
      }
    }
    branches = branches.flatMap((b) => (unionList(b) ? (branchForm(b) as BranchForm).branches : [b]));
    return { description, branches };
  }
  if (Array.isArray(schema.type) && schema.type.length > 1) {
    const rest = withoutAnnotations(schema);
    delete rest.type;
    const branches = (schema.type as unknown[])
      .filter((t): t is string => typeof t === 'string')
      .map((t) => {
        const branch: JsonSchema = { type: t };
        for (const [k, v] of Object.entries(rest)) {
          const applies = KEYWORD_TYPES[k];
          if (applies && !applies.includes(t)) continue;
          if ((k === 'enum' && Array.isArray(v)) || k === 'const') {
            const values = k === 'const' ? [v] : (v as unknown[]);
            const kept = values.filter((x) => valueHasType(x, t));
            // An enum listing every value of its type (`null`, or both booleans) restricts nothing.
            const whole = (t === 'null' && kept.length > 0) || (t === 'boolean' && kept.includes(true) && kept.includes(false));
            if (!whole) branch.enum = kept;
            continue;
          }
          branch[k] = v;
        }
        return branch;
      });
    return { description: descOf(schema), branches };
  }
  return undefined;
}

/** Flattens `allOf` into the schema itself (union of properties/required, first-write-wins for other keys). */
function resolveAllOf(schema: JsonSchema): JsonSchema {
  if (!Array.isArray(schema.allOf)) return schema;
  const merged: Record<string, unknown> = { ...schema };
  delete merged.allOf;
  const mergedProps: Record<string, unknown> = isPlainObject(merged.properties) ? { ...(merged.properties as Record<string, unknown>) } : {};
  const mergedRequired = new Set<string>(Array.isArray(merged.required) ? (merged.required as string[]) : []);
  for (const rawSub of schema.allOf as unknown[]) {
    const sub = resolveAllOf(asSchema(rawSub));
    if (isPlainObject(sub.properties)) Object.assign(mergedProps, sub.properties);
    if (Array.isArray(sub.required)) for (const r of sub.required as string[]) mergedRequired.add(r);
    for (const [k, v] of Object.entries(sub)) {
      if (k === 'properties' || k === 'required') continue;
      if (!(k in merged)) merged[k] = v;
    }
  }
  merged.properties = mergedProps;
  merged.required = [...mergedRequired];
  return merged as JsonSchema;
}

/**
 * Identity candidates for a branch: a `const` (or single-value `enum`) on the branch itself, or on
 * any of its object properties (a discriminator, e.g. the `k` in a zod discriminated union). Used
 * to pair branches by identity before falling back to type-set matching, so reordering or
 * inserting a union/discriminated-union variant doesn't get misread as edits to unrelated branches.
 */
function branchIdentityKeys(b: JsonSchema): string[] {
  const keys: string[] = [];
  if ('const' in b) keys.push(`const:${JSON.stringify(b.const)}`);
  else if (Array.isArray(b.enum) && b.enum.length === 1) keys.push(`const:${JSON.stringify(b.enum[0])}`);
  if (isPlainObject(b.properties)) {
    for (const [name, propSchema] of Object.entries(b.properties as Record<string, unknown>)) {
      if (!isPlainObject(propSchema)) continue;
      if ('const' in propSchema) keys.push(`disc:${name}=${JSON.stringify((propSchema as JsonSchema).const)}`);
      else if (Array.isArray(propSchema.enum) && (propSchema.enum as unknown[]).length === 1) {
        keys.push(`disc:${name}=${JSON.stringify((propSchema.enum as unknown[])[0])}`);
      }
    }
  }
  return keys;
}

/** A human label for a branch (its const/discriminator value), for "branch removed" messages. */
function branchLabel(b: JsonSchema): string | undefined {
  if ('const' in b) return JSON.stringify(b.const);
  if (Array.isArray(b.enum) && b.enum.length === 1) return JSON.stringify(b.enum[0]);
  if (isPlainObject(b.properties)) {
    for (const [name, propSchema] of Object.entries(b.properties as Record<string, unknown>)) {
      if (!isPlainObject(propSchema)) continue;
      if ('const' in propSchema) return `${name}=${JSON.stringify((propSchema as JsonSchema).const)}`;
      if (Array.isArray(propSchema.enum) && (propSchema.enum as unknown[]).length === 1) {
        return `${name}=${JSON.stringify((propSchema.enum as unknown[])[0])}`;
      }
    }
  }
  return undefined;
}

/**
 * Compares two lists of schema variants (normalized by branchForm, or a single plain schema
 * treated as a one-branch list). Branches are paired in two passes:
 *  1. Identity: branches that share a `const`/single-value-`enum` identity (their own, or a
 *     discriminator property's) are paired regardless of position, so reordering or inserting a
 *     union/discriminated-union variant doesn't fall out as edits to unrelated branches.
 *  2. Remaining branches with compatible type sets (equal, or one a superset of the other, so
 *     `integer` can pair with a widened `number`) are paired by trying every compatible pair and
 *     greedily taking the ones that produce the fewest (fewest breaking, then fewest total) changes.
 * A branch left over on the old side is a removed (breaking) branch; left over on the new side is
 * an added (safe) branch. Matched branches recurse via diffParam, so e.g. a nullable object
 * (`anyOf: [{...}, {type: 'null'}]`) compares its object branch against a plain object schema on
 * the other side, and losing the null branch is a narrowing (breaking).
 */
function diffVariants(target: string, path: string, va: JsonSchema[], vb: JsonSchema[], out: Change[]): void {
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: { i: number; j: number }[] = [];

  // Identity pass: a key only identifies a branch if it belongs to exactly one branch on each
  // side. A key shared by several branches (e.g. a schema-version literal present on every
  // discriminated-union variant) doesn't tell two branches apart, so it must not be used to pair
  // them — that degenerates back into first-come positional pairing.
  const keysA = va.map(branchIdentityKeys);
  const keysB = vb.map(branchIdentityKeys);
  const countA = new Map<string, number>();
  for (const ks of keysA) for (const k of ks) countA.set(k, (countA.get(k) ?? 0) + 1);
  const countB = new Map<string, number>();
  for (const ks of keysB) for (const k of ks) countB.set(k, (countB.get(k) ?? 0) + 1);

  type IdCandidate = { i: number; j: number; score: number };
  const idCandidates: IdCandidate[] = [];
  for (let i = 0; i < va.length; i++) {
    for (let j = 0; j < vb.length; j++) {
      const shared = keysA[i]!.filter((k) => countA.get(k) === 1 && countB.get(k) === 1 && keysB[j]!.includes(k));
      if (shared.length) idCandidates.push({ i, j, score: shared.length });
    }
  }
  idCandidates.sort((x, y) => y.score - x.score);
  for (const c of idCandidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    pairs.push({ i: c.i, j: c.j });
  }

  // Least-change pass: remaining branches with a compatible type set, paired by trying every
  // compatible pair and greedily taking the ones producing the fewest (fewest breaking, then
  // fewest total) changes. Trial diffs are memoized per (i, j): a branch can appear in several
  // candidate pairs, and nested unions would otherwise re-diff the same pair repeatedly.
  type Candidate = { i: number; j: number; breaking: number; total: number };
  const candidates: Candidate[] = [];
  const trialCache = new Map<string, Change[]>();
  const trialDiff = (i: number, j: number): Change[] => {
    const key = `${i}:${j}`;
    let cached = trialCache.get(key);
    if (!cached) {
      cached = [];
      diffParam(target, path, va[i] as JsonSchema, vb[j] as JsonSchema, cached);
      trialCache.set(key, cached);
    }
    return cached;
  };
  for (let i = 0; i < va.length; i++) {
    if (usedA.has(i)) continue;
    const ta = typeSet(va[i] as JsonSchema);
    for (let j = 0; j < vb.length; j++) {
      if (usedB.has(j)) continue;
      const tb = typeSet(vb[j] as JsonSchema);
      if (!isSubset(ta, tb) && !isSubset(tb, ta)) continue;
      const trial = trialDiff(i, j);
      candidates.push({ i, j, breaking: trial.filter((c) => c.severity === 'breaking').length, total: trial.length });
    }
  }
  candidates.sort((x, y) => x.breaking - y.breaking || x.total - y.total);
  for (const c of candidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    pairs.push({ i: c.i, j: c.j });
  }

  for (const { i, j } of pairs) {
    const cached = trialCache.get(`${i}:${j}`);
    if (cached) out.push(...cached);
    else diffParam(target, path, va[i] as JsonSchema, vb[j] as JsonSchema, out);
  }
  for (let i = 0; i < va.length; i++) {
    if (usedA.has(i)) continue;
    const label = branchLabel(va[i] as JsonSchema);
    out.push({ severity: 'breaking', kind: 'type-narrowed', target, path, message: `"${path}" branch removed${label ? ` (${label})` : ''}` });
  }
  for (let j = 0; j < vb.length; j++) {
    if (usedB.has(j)) continue;
    const label = branchLabel(vb[j] as JsonSchema);
    out.push({ severity: 'safe', kind: 'type-widened', target, path, message: `"${path}" branch added${label ? ` (${label})` : ''}` });
  }
}

function props(schema: JsonSchema): Record<string, JsonSchema> {
  return isPlainObject(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
}

function required(schema: JsonSchema): Set<string> {
  return new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
}

function describeDescriptionChange(target: string, path: string | undefined, before: string, after: string): Change {
  const sim = wordSimilarity(before, after);
  const where = path ? `parameter "${path}" description` : 'description';
  return {
    severity: sim < RISKY_DESCRIPTION_SIMILARITY ? 'risky' : 'safe',
    kind: 'description-changed',
    target,
    ...(path ? { path } : {}),
    message: `${where} changed (similarity ${sim.toFixed(2)})`,
  };
}

type Bound = 'minimum' | 'exclusiveMinimum' | 'minLength' | 'minItems' | 'maximum' | 'exclusiveMaximum' | 'maxLength' | 'maxItems';
const LOWER: Bound[] = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems'];
const UPPER: Bound[] = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems'];

function diffConstraints(target: string, path: string, a: JsonSchema, b: JsonSchema, out: Change[]): void {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  for (const k of [...LOWER, ...UPPER]) {
    const x = num(a[k]);
    const y = num(b[k]);
    if (x === y) continue;
    const isLower = LOWER.includes(k);
    const narrowed = x === undefined ? true : y === undefined ? false : isLower ? y > x : y < x;
    out.push({
      severity: narrowed ? 'breaking' : 'safe',
      kind: narrowed ? 'constraint-narrowed' : 'constraint-widened',
      target,
      path,
      message: `"${path}" ${k} ${x ?? 'unset'} -> ${y ?? 'unset'}`,
    });
  }
  if (a.pattern !== b.pattern) {
    const narrowed = b.pattern !== undefined;
    out.push({
      severity: narrowed ? 'breaking' : 'safe',
      kind: narrowed ? 'constraint-narrowed' : 'constraint-widened',
      target,
      path,
      message: `"${path}" pattern ${JSON.stringify(a.pattern ?? null)} -> ${JSON.stringify(b.pattern ?? null)}`,
    });
  }
}

/** Extracts an effective enum: the real `enum`, or a single-value enum from `const`. */
function effectiveEnum(schema: JsonSchema): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum as unknown[];
  if ('const' in schema) return [schema.const];
  return undefined;
}

/** Compares one parameter schema (old a, new b) and recurses into object properties and array items. */
function diffParam(target: string, path: string, aIn: JsonSchema, bIn: JsonSchema, out: Change[]): void {
  const a = resolveAllOf(asSchema(aIn));
  const b = resolveAllOf(asSchema(bIn));

  // Union on either side: both sides become branch lists (a plain schema is one branch holding all
  // its keywords), the description is compared once here, and every other keyword is compared
  // inside the paired branches — nothing else is compared at this level, since the union wrapper
  // itself carries no constraints once they are pushed into its branches.
  const fa = branchForm(a);
  const fb = branchForm(b);
  if (fa || fb) {
    const A = fa ?? { description: descOf(a), branches: [withoutAnnotations(a)] };
    const B = fb ?? { description: descOf(b), branches: [withoutAnnotations(b)] };
    if (A.description !== B.description) out.push(describeDescriptionChange(target, path, A.description, B.description));
    diffVariants(target, path, A.branches, B.branches, out);
    return;
  }

  const ta = typeSet(a);
  const tb = typeSet(b);
  if (!isSubset(ta, tb) || !isSubset(tb, ta)) {
    if (isSubset(tb, ta)) {
      out.push({ severity: 'breaking', kind: 'type-narrowed', target, path, message: `"${path}" type narrowed: ${[...ta].join('|')} -> ${[...tb].join('|')}` });
    } else if (isSubset(ta, tb)) {
      out.push({ severity: 'safe', kind: 'type-widened', target, path, message: `"${path}" type widened: ${[...ta].join('|')} -> ${[...tb].join('|')}` });
    } else {
      out.push({ severity: 'breaking', kind: 'type-changed', target, path, message: `"${path}" type changed: ${[...ta].join('|')} -> ${[...tb].join('|')}` });
    }
  }

  const ea = effectiveEnum(a);
  const eb = effectiveEnum(b);
  if (ea && eb) {
    const removed = ea.filter((v) => !eb.some((w) => deepEqual(v, w)));
    const added = eb.filter((v) => !ea.some((w) => deepEqual(v, w)));
    if (removed.length) out.push({ severity: 'breaking', kind: 'enum-value-removed', target, path, message: `"${path}" enum values removed: ${removed.map((v) => JSON.stringify(v)).join(', ')}` });
    if (added.length) out.push({ severity: 'safe', kind: 'enum-value-added', target, path, message: `"${path}" enum values added: ${added.map((v) => JSON.stringify(v)).join(', ')}` });
  } else if (!ea && eb) {
    out.push({ severity: 'breaking', kind: 'type-narrowed', target, path, message: `"${path}" now restricted to enum ${JSON.stringify(eb)}` });
  } else if (ea && !eb) {
    out.push({ severity: 'safe', kind: 'type-widened', target, path, message: `"${path}" enum restriction removed` });
  }

  diffConstraints(target, path, a, b, out);

  const da = typeof a.description === 'string' ? a.description : '';
  const db = typeof b.description === 'string' ? b.description : '';
  if (da !== db) out.push(describeDescriptionChange(target, path, da, db));

  if (isPlainObject(a.properties) || isPlainObject(b.properties) || isPlainObject(a.additionalProperties) || isPlainObject(b.additionalProperties)) {
    diffObject(target, path, a, b, out);
  }

  const itemsA = isPlainObject(a.items) ? (a.items as JsonSchema) : undefined;
  const itemsB = isPlainObject(b.items) ? (b.items as JsonSchema) : undefined;
  if (itemsA && itemsB) {
    diffParam(target, `${path}[]`, itemsA, itemsB, out);
  } else if (!itemsA && itemsB && !isEmptySchema(itemsB)) {
    out.push({ severity: 'breaking', kind: 'constraint-narrowed', target, path, message: `"${path}" items constrained to a schema` });
  } else if (itemsA && !itemsB && !isEmptySchema(itemsA)) {
    out.push({ severity: 'safe', kind: 'constraint-widened', target, path, message: `"${path}" item schema constraint removed` });
  }
}

/** Compares the properties/required/additionalProperties of two object schemas. */
function diffObject(target: string, prefix: string, aIn: JsonSchema, bIn: JsonSchema, out: Change[]): void {
  const a = resolveAllOf(asSchema(aIn));
  const b = resolveAllOf(asSchema(bIn));
  const pa = props(a);
  const pb = props(b);
  const ra = required(a);
  const rb = required(b);
  const join = (k: string): string => (prefix ? `${prefix}.${k}` : k);

  for (const k of Object.keys(pa)) {
    const path = join(k);
    if (!Object.hasOwn(pb, k)) {
      out.push({ severity: 'breaking', kind: 'param-removed', target, path, message: `parameter "${path}" removed` });
      continue;
    }
    if (!ra.has(k) && rb.has(k)) out.push({ severity: 'breaking', kind: 'param-became-required', target, path, message: `parameter "${path}" is now required` });
    if (ra.has(k) && !rb.has(k)) out.push({ severity: 'safe', kind: 'param-became-optional', target, path, message: `parameter "${path}" is now optional` });
    diffParam(target, path, pa[k] as JsonSchema, pb[k] as JsonSchema, out);
  }
  for (const k of Object.keys(pb)) {
    if (Object.hasOwn(pa, k)) continue;
    const path = join(k);
    if (rb.has(k)) out.push({ severity: 'breaking', kind: 'param-required-added', target, path, message: `required parameter "${path}" added` });
    else out.push({ severity: 'safe', kind: 'param-optional-added', target, path, message: `optional parameter "${path}" added` });
  }
  // A `required` entry with no corresponding property in either schema (e.g. hand-written or
  // malformed schemas) is still a newly imposed constraint if it wasn't required before.
  for (const k of rb) {
    if (ra.has(k) || Object.hasOwn(pa, k) || Object.hasOwn(pb, k)) continue;
    const path = join(k);
    out.push({ severity: 'breaking', kind: 'param-required-added', target, path, message: `required parameter "${path}" added` });
  }

  // An empty additionalProperties schema accepts anything: the same as leaving it unset.
  const normAp = (v: unknown): unknown => (isPlainObject(v) && isEmptySchema(v as JsonSchema) ? undefined : v);
  const apA = normAp(a.additionalProperties);
  const apB = normAp(b.additionalProperties);
  if (isPlainObject(apA) && isPlainObject(apB)) {
    diffParam(target, `${prefix}{}`, apA as JsonSchema, apB as JsonSchema, out);
  } else if (apA !== false && apB === false) {
    out.push({ severity: 'breaking', kind: 'constraint-narrowed', target, ...(prefix ? { path: prefix } : {}), message: `${prefix ? `"${prefix}"` : 'input'} no longer accepts additional properties` });
  } else if ((apA === true || apA === undefined) && isPlainObject(apB)) {
    out.push({ severity: 'breaking', kind: 'constraint-narrowed', target, ...(prefix ? { path: prefix } : {}), message: `${prefix ? `"${prefix}"` : 'input'} additional properties restricted to a schema` });
  } else if (isPlainObject(apA) && (apB === true || apB === undefined)) {
    out.push({ severity: 'safe', kind: 'constraint-widened', target, ...(prefix ? { path: prefix } : {}), message: `${prefix ? `"${prefix}"` : 'input'} additional properties schema constraint removed` });
  }
}

/** Spec defaults (MCP 2025-11-25 ToolAnnotations). Omitted hints mean these values. */
export const ANNOTATION_DEFAULTS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/**
 * Compares annotation hints after applying spec defaults, one change per hint. destructive/
 * idempotent hints only matter when the tool is not read-only, so they are skipped when
 * the tool is read-only both before and after. The display title is ignored.
 */
function diffAnnotations(target: string, a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined, out: Change[]): void {
  const val = (x: Record<string, unknown> | undefined, k: keyof typeof ANNOTATION_DEFAULTS): boolean =>
    typeof x?.[k] === 'boolean' ? (x[k] as boolean) : ANNOTATION_DEFAULTS[k];
  const readOnlyBoth = val(a, 'readOnlyHint') && val(b, 'readOnlyHint');
  for (const k of Object.keys(ANNOTATION_DEFAULTS) as (keyof typeof ANNOTATION_DEFAULTS)[]) {
    if (readOnlyBoth && (k === 'destructiveHint' || k === 'idempotentHint')) continue;
    const x = val(a, k);
    const y = val(b, k);
    if (x !== y) out.push({ severity: 'risky', kind: 'annotation-changed', target, message: `${k} ${x} -> ${y}` });
  }
}

function diffTool(a: ToolSnapshot, b: ToolSnapshot, out: Change[]): void {
  const target = `tool:${a.name}`;
  // Local $refs ($defs/definitions, emitted by pydantic for nested models and enums and by zod
  // for recursive schemas) are inlined per side first, so changes behind a ref are compared.
  diffObject(target, '', inlineLocalRefs(a.inputSchema) as JsonSchema, inlineLocalRefs(b.inputSchema) as JsonSchema, out);
  if ((a.description ?? '') !== (b.description ?? '')) out.push(describeDescriptionChange(target, undefined, a.description ?? '', b.description ?? ''));
  diffAnnotations(target, a.annotations, b.annotations, out);
  const stripSchemaKey = (s: JsonSchema | undefined): JsonSchema | undefined => {
    if (!isPlainObject(s)) return s;
    const { $schema, ...rest } = s;
    return rest;
  };
  const output = (s: JsonSchema | undefined): JsonSchema | undefined => stripSchemaKey(inlineLocalRefs(s) as JsonSchema | undefined);
  if (!deepEqual(output(a.outputSchema), output(b.outputSchema))) {
    out.push({ severity: 'risky', kind: 'output-schema-changed', target, message: 'outputSchema changed' });
  }
}

function diffPrompt(a: PromptSnapshot, b: PromptSnapshot, out: Change[]): void {
  const target = `prompt:${a.name}`;
  for (const arg of a.arguments) {
    const nb = b.arguments.find((x) => x.name === arg.name);
    if (!nb) out.push({ severity: 'breaking', kind: 'prompt-arg-removed', target, path: arg.name, message: `argument "${arg.name}" removed` });
    else if (!arg.required && nb.required) out.push({ severity: 'breaking', kind: 'prompt-arg-required-added', target, path: arg.name, message: `argument "${arg.name}" is now required` });
  }
  for (const arg of b.arguments) {
    if (a.arguments.some((x) => x.name === arg.name)) continue;
    out.push(arg.required
      ? { severity: 'breaking', kind: 'prompt-arg-required-added', target, path: arg.name, message: `required argument "${arg.name}" added` }
      : { severity: 'safe', kind: 'prompt-arg-optional-added', target, path: arg.name, message: `optional argument "${arg.name}" added` });
  }
  if ((a.description ?? '') !== (b.description ?? '')) out.push(describeDescriptionChange(target, undefined, a.description ?? '', b.description ?? ''));
}

const SEVERITY_ORDER = { breaking: 0, risky: 1, safe: 2 } as const;

/** Classifies every difference between an old and new snapshot. Sorted breaking -> risky -> safe. */
export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const out: Change[] = [];
  const newTools = new Map(after.tools.map((t) => [t.name, t]));
  const oldTools = new Map(before.tools.map((t) => [t.name, t]));
  for (const t of before.tools) {
    const nt = newTools.get(t.name);
    if (!nt) out.push({ severity: 'breaking', kind: 'tool-removed', target: `tool:${t.name}`, message: `tool "${t.name}" removed` });
    else diffTool(t, nt, out);
  }
  for (const t of after.tools) {
    if (!oldTools.has(t.name)) out.push({ severity: 'safe', kind: 'tool-added', target: `tool:${t.name}`, message: `tool "${t.name}" added` });
  }

  const newPrompts = new Map(after.prompts.map((p) => [p.name, p]));
  for (const p of before.prompts) {
    const np = newPrompts.get(p.name);
    if (!np) out.push({ severity: 'breaking', kind: 'prompt-removed', target: `prompt:${p.name}`, message: `prompt "${p.name}" removed` });
    else diffPrompt(p, np, out);
  }
  for (const p of after.prompts) {
    if (!before.prompts.some((x) => x.name === p.name)) out.push({ severity: 'safe', kind: 'prompt-added', target: `prompt:${p.name}`, message: `prompt "${p.name}" added` });
  }

  const newUris = new Set(after.resources.map((r) => r.uri));
  const oldUris = new Set(before.resources.map((r) => r.uri));
  for (const r of before.resources) {
    if (!newUris.has(r.uri)) out.push({ severity: 'breaking', kind: 'resource-removed', target: `resource:${r.uri}`, message: `resource "${r.uri}" removed` });
  }
  for (const r of after.resources) {
    if (!oldUris.has(r.uri)) out.push({ severity: 'safe', kind: 'resource-added', target: `resource:${r.uri}`, message: `resource "${r.uri}" added` });
  }

  return out.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);
}

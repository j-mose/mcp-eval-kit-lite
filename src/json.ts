export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type JsonType = 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'undefined';

export function jsonType(v: unknown): JsonType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return t;
  return 'object';
}

/** Recursively sorts object keys so output is stable across runs. */
export function sortKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(sortKeys) as T;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out as T;
  }
  return v;
}

export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 2) + '\n';
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Parses a string as JSON only when it is an object or array; otherwise returns undefined. */
export function parseJsonContainer(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === 'object' && v !== null ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Keywords whose values are data, not subschemas: never searched for `$ref`. */
const REF_DATA_KEYS = new Set(['enum', 'const', 'default', 'examples']);
/** Keywords whose values map names to subschemas: their keys are names, not keywords. */
const REF_NAME_MAP_KEYS = new Set(['properties', 'patternProperties', 'dependentSchemas', 'dependencies']);

/**
 * Inlines local `$ref`s (`#`, `#/$defs/*`, `#/definitions/*`, any `#/...` pointer) against the
 * schema's own root, and drops the `$defs`/`definitions` containers. A ref's sibling keywords win
 * over the target's (pydantic puts `description` next to `$ref`). A ref already being expanded on
 * the current path (a recursive schema) is left as a `{ $ref }` stub, so the result is finite and a
 * recursive type is compared once. Non-local or dangling refs are left untouched.
 */
export function inlineLocalRefs(root: unknown): unknown {
  if (!isPlainObject(root)) return root;
  const lookup = (ref: string): unknown => {
    if (ref === '#') return root;
    if (!ref.startsWith('#/')) return undefined;
    let cur: unknown = root;
    for (const raw of ref.slice(2).split('/')) {
      const seg = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  };
  const walk = (v: unknown, active: ReadonlySet<string>): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, active));
    if (!isPlainObject(v)) return v;
    const ref = v.$ref;
    if (typeof ref === 'string') {
      const target = lookup(ref);
      if (isPlainObject(target)) {
        if (active.has(ref)) return v;
        const { $ref: _ref, ...siblings } = v;
        return walk({ ...target, ...siblings }, new Set(active).add(ref));
      }
    }
    // `v` is a schema here, so its keys are keywords.
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === '$defs' || k === 'definitions') continue;
      if (REF_DATA_KEYS.has(k)) out[k] = val;
      else if (REF_NAME_MAP_KEYS.has(k) && isPlainObject(val)) out[k] = walkNameMap(val, active);
      else out[k] = walk(val, active);
    }
    return out;
  };
  // Keys of a name map are property names (possibly "definitions" or "$defs"), never keywords.
  const walkNameMap = (m: Record<string, unknown>, active: ReadonlySet<string>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(m)) out[name] = walk(sub, active);
    return out;
  };
  return walk(root, new Set());
}

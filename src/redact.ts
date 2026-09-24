import { isPlainObject, parseJsonContainer } from './json.js';
import type { RedactOptions } from './types.js';

export const REDACTED = '[REDACTED]';
export const DEFAULT_REDACT_KEYS = ['authorization', 'api_key', 'token', 'password'];
export const DEFAULT_REDACT_PATTERNS = ['Bearer\\s+[A-Za-z0-9._~+/=-]+'];

const norm = (k: string): string => k.toLowerCase().replace(/[-_]/g, '');

export interface Redactor {
  (value: unknown): unknown;
}

/**
 * Builds a redactor. A key is secret when its normalized form (lowercase, no - or _)
 * equals or ends with a normalized secret key: "x-api-key", "access_token" and
 * "Authorization" all match; "max_tokens" does not.
 * Pattern matches inside any string are replaced. Strings holding JSON objects are
 * parsed, redacted and re-serialized so secrets inside text content are caught too.
 */
export function createRedactor(opts: RedactOptions): Redactor {
  const keys = opts.keys.map(norm);
  const patterns = opts.patterns.map((p) => new RegExp(p, 'g'));
  const isSecretKey = (k: string): boolean => {
    const n = norm(k);
    return keys.some((s) => n === s || n.endsWith(s));
  };
  const redactString = (s: string): string => {
    const parsed = keys.length > 0 ? parseJsonContainer(s) : undefined;
    if (parsed !== undefined) {
      const before = JSON.stringify(parsed);
      const after = JSON.stringify(walk(parsed));
      if (before !== after) return after;
    }
    return patterns.reduce((acc, re) => acc.replace(re, REDACTED), s);
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      const isScalar = (x: unknown): boolean => x !== null && typeof x !== 'object';
      for (const [k, val] of Object.entries(v)) {
        if (!isSecretKey(k)) out[k] = walk(val);
        else if (isScalar(val)) out[k] = REDACTED;
        // `token: ["a", "b"]`: scalar elements are secrets too; objects inside are still walked.
        else if (Array.isArray(val)) out[k] = val.map((x) => (isScalar(x) ? REDACTED : walk(x)));
        else out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk;
}

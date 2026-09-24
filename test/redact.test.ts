import { describe, expect, it } from 'vitest';
import { createRedactor, DEFAULT_REDACT_KEYS, DEFAULT_REDACT_PATTERNS, REDACTED } from '../src/redact.js';

const redact = createRedactor({ keys: DEFAULT_REDACT_KEYS, patterns: [...DEFAULT_REDACT_PATTERNS, 'sk-[A-Za-z0-9]{6,}'] });

describe('createRedactor', () => {
  it('redacts default secret keys at any depth, including suffix matches', () => {
    const out = redact({ user: 'ann', api_key: 'abc', nested: { Authorization: 'x', access_token: 't', 'x-api-key': 'k', password: 'p' } });
    expect(out).toEqual({ user: 'ann', api_key: REDACTED, nested: { Authorization: REDACTED, access_token: REDACTED, 'x-api-key': REDACTED, password: REDACTED } });
  });

  it('does not redact look-alike keys', () => {
    expect(redact({ max_tokens: 5, token_count: 2 })).toEqual({ max_tokens: 5, token_count: 2 });
  });

  it('applies patterns inside plain strings', () => {
    expect(redact({ note: 'use sk-abcdef123 with Bearer eyJ.abc' })).toEqual({ note: `use ${REDACTED} with ${REDACTED}` });
  });

  it('redacts secrets inside JSON text content', () => {
    const out = redact({ content: [{ type: 'text', text: '{"region":"us","api_key":"secret-1"}' }] }) as { content: { text: string }[] };
    expect(out.content[0]!.text).toBe(`{"region":"us","api_key":"${REDACTED}"}`);
    expect(JSON.stringify(out)).not.toContain('secret-1');
  });

  it('leaves non-JSON text alone when nothing matches and does not mutate input', () => {
    const input = { text: 'hello {not json' };
    expect(redact(input)).toEqual({ text: 'hello {not json' });
    expect(input).toEqual({ text: 'hello {not json' });
  });

  it('redacts scalar elements of an array under a secret key, and still walks objects inside it', () => {
    expect(redact({ token: ['x', 42, true, null], api_keys: ['k1'] })).toEqual({ token: ['[REDACTED]', '[REDACTED]', '[REDACTED]', null], api_keys: ['k1'] });
    expect(redact({ access_token: [{ value: 'v', password: 'p' }, 'raw'] })).toEqual({ access_token: [{ value: 'v', password: '[REDACTED]' }, '[REDACTED]'] });
    expect(redact({ tags: ['x'] })).toEqual({ tags: ['x'] });
  });
});

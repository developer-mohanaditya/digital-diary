import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOPES, generateKey, hashKey, keyNameProblem, keyShaped, lookupPrefix, normaliseScopes,
  expiryFrom,
} from '../src/apikey';

describe('api keys', () => {
  it('mints a key of the documented shape', () => {
    const key = generateKey();
    expect(key.startsWith('ddk_live_')).toBe(true);
    expect(key).toHaveLength('ddk_live_'.length + 43);
    expect(keyShaped(key)).toBe(true);
    expect(new Set(Array.from({ length: 20 }, generateKey)).size).toBe(20);
  });

  it('keeps only a 16-character prefix in the clear', () => {
    const key = generateKey();
    const prefix = lookupPrefix(key);
    expect(prefix).toHaveLength(16);
    expect(key.startsWith(prefix)).toBe(true);
    // Short enough to display, long enough that two keys cannot share it by accident.
    expect(prefix).not.toBe(key);
  });

  it('hashes the whole key, so the same key always finds its row', async () => {
    const key = generateKey();
    const hash = await hashKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashKey(key)).toBe(hash);
    expect(await hashKey(generateKey())).not.toBe(hash);
  });

  it('refuses anything that is not one of our keys', () => {
    expect(keyShaped('')).toBe(false);
    expect(keyShaped('ddk_live_short')).toBe(false);
    expect(keyShaped(`ddk_live_${'a'.repeat(43)} `)).toBe(false);
    expect(keyShaped(`sk_live_${'a'.repeat(43)}`)).toBe(false);
    expect(keyShaped(`ddk_live_${'a'.repeat(42)}+`)).toBe(false);
  });

  it('defaults to reading notes, deadlines and counts, never the original text', () => {
    expect(normaliseScopes(undefined)).toEqual({ scopes: DEFAULT_SCOPES });
    expect(DEFAULT_SCOPES).not.toContain('raw:read');
    expect(normaliseScopes(['stats:read', 'stats:read'])).toEqual({ scopes: ['stats:read'] });
  });

  it('will not grant the original text without notes to read it through', () => {
    expect(normaliseScopes(['raw:read'])).toMatchObject({ error: expect.stringContaining('notes:read') });
    expect(normaliseScopes(['raw:read', 'notes:read'])).toEqual({ scopes: ['raw:read', 'notes:read'] });
  });

  it('rejects unknown scopes and an empty list', () => {
    expect(normaliseScopes(['all:read'])).toMatchObject({ error: expect.stringContaining('Unknown scope') });
    expect(normaliseScopes([])).toMatchObject({ error: expect.stringContaining('at least one') });
    expect(normaliseScopes('notes:read')).toMatchObject({ error: expect.stringContaining('list') });
  });

  it('expires in whole offered periods, or never', () => {
    const now = new Date('2026-10-26T00:00:00.000Z');
    expect(expiryFrom('never', now)).toEqual({ at: null });
    expect(expiryFrom(undefined, now)).toEqual({ at: null });
    expect(expiryFrom('90', now)).toEqual({ at: '2027-01-24T00:00:00.000Z' });
    expect(expiryFrom(7, now)).toMatchObject({ error: expect.stringContaining('one of') });
    expect(expiryFrom(0, now)).toMatchObject({ error: expect.any(String) });
  });

  it('asks for a name that says which project holds the key', () => {
    expect(keyNameProblem('   ')).toMatch(/name/i);
    expect(keyNameProblem('x'.repeat(61))).toMatch(/60/);
    expect(keyNameProblem('Portfolio site')).toBeNull();
  });
});

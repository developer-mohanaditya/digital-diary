import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE, clearedCookie, issueSession, readCookie, sameSecret, sessionCookie, sessionValid,
} from '../src/session';

const NOW = new Date('2026-10-24T10:00:00.000Z');

describe('sameSecret', () => {
  it('accepts only identical strings', () => {
    expect(sameSecret('coffee', 'coffee')).toBe(true);
    expect(sameSecret('coffee', 'coffeE')).toBe(false);
    expect(sameSecret('coffee', 'coffee ')).toBe(false);
    expect(sameSecret('', 'coffee')).toBe(false);
    expect(sameSecret('', '')).toBe(true);
  });
});

describe('session cookie', () => {
  it('is valid before it expires and dead after', async () => {
    const token = await issueSession('secret', NOW);
    expect(await sessionValid(token, 'secret', NOW)).toBe(true);
    expect(await sessionValid(token, 'another secret', NOW)).toBe(false);
    const afterExpiry = new Date(NOW.getTime() + 31 * 86400000);
    expect(await sessionValid(token, 'secret', afterExpiry)).toBe(false);
  });

  it('rejects a token whose expiry was edited to gain time', async () => {
    const token = await issueSession('secret', NOW);
    const [, signature] = token.split('.');
    const forged = `${Math.floor(NOW.getTime() / 1000) + 999999}.${signature}`;
    expect(await sessionValid(forged, 'secret', NOW)).toBe(false);
  });

  it('rejects malformed and missing tokens without throwing', async () => {
    expect(await sessionValid(null, 'secret', NOW)).toBe(false);
    expect(await sessionValid('', 'secret', NOW)).toBe(false);
    expect(await sessionValid('nonsense', 'secret', NOW)).toBe(false);
    expect(await sessionValid('123.', 'secret', NOW)).toBe(false);
    expect(await sessionValid('.abc', 'secret', NOW)).toBe(false);
  });

  it('sets an HttpOnly, Secure, SameSite=Lax cookie and can clear it', async () => {
    const cookie = sessionCookie('token');
    expect(cookie).toContain(`${SESSION_COOKIE}=token`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(clearedCookie()).toContain('Max-Age=0');
  });
});

describe('readCookie', () => {
  const withCookie = (value: string) => new Request('https://diary.test/api/entries', { headers: { Cookie: value } });

  it('finds the session among other cookies', () => {
    expect(readCookie(withCookie(`a=1; ${SESSION_COOKIE}=abc.def; theme=dark`), SESSION_COOKIE)).toBe('abc.def');
  });

  it('returns null when absent or when there is no header', () => {
    expect(readCookie(withCookie('a=1; b=2'), SESSION_COOKIE)).toBeNull();
    expect(readCookie(new Request('https://diary.test/'), SESSION_COOKIE)).toBeNull();
  });
});

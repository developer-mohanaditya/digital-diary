// API keys for the read API: how one is minted, how it is looked up, and what it may read.
//
// The key is shown once and never stored. What is stored is its SHA-256 beside a 16-character
// prefix; the prefix finds the row, the hash proves the key. PBKDF2 is not needed here the way
// it is for the passphrase: the input is 256 random bits, so there is no guessable space for a
// fast hash to give away, and lookups stay one cheap digest.

export const KEY_PREFIX = 'ddk_live_';

// Long enough that two keys cannot collide on it, short enough to read on screen.
export const LOOKUP_CHARS = 16;

const SECRET_BYTES = 32;
const SECRET_CHARS = 43; // 32 bytes in unpadded base64url

export const SCOPES = ['notes:read', 'deadlines:read', 'stats:read', 'raw:read'] as const;
export type Scope = (typeof SCOPES)[number];

// A key that is not asked for anything else reads notes, deadlines and counts. The original
// text is deliberately not in the default: it is the part of a note the cleanup was meant to
// replace, so a side project has to ask for it.
export const DEFAULT_SCOPES: Scope[] = ['notes:read', 'deadlines:read', 'stats:read'];

export const SCOPE_LABEL: Record<Scope, string> = {
  'notes:read': 'Notes',
  'deadlines:read': 'Deadlines',
  'stats:read': 'Counts and stats',
  'raw:read': 'Original text',
};

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return KEY_PREFIX + b64url(bytes);
}

// The part kept in the clear, and the part a request is looked up by.
export function lookupPrefix(key: string): string {
  return key.slice(0, LOOKUP_CHARS);
}

export async function hashKey(key: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
}

// Anything that does not look like one of our keys is refused before a database round trip,
// so a fuzzer cannot turn the API into a query generator.
export function keyShaped(value: string): boolean {
  return new RegExp(`^${KEY_PREFIX}[A-Za-z0-9_-]{${SECRET_CHARS}}$`).test(value);
}

export function hasScope(scopes: readonly string[], need: Scope): boolean {
  return scopes.includes(need);
}

// What to save for a requested scope list. Raw text is read through notes, so asking for it
// alone would grant a scope that can never answer; the pair is refused and the page says so.
export function normaliseScopes(input: unknown): { scopes: Scope[] } | { error: string } {
  if (input === undefined) return { scopes: [...DEFAULT_SCOPES] };
  if (!Array.isArray(input)) return { error: 'Send scopes as a list of names.' };
  const wanted = input.filter((v): v is string => typeof v === 'string');
  if (wanted.length !== input.length) return { error: 'Send scopes as a list of names.' };
  const unknown = wanted.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (unknown.length) {
    return { error: `Unknown scope: ${unknown.join(', ')}. The scopes are ${SCOPES.join(', ')}.` };
  }
  if (!wanted.length) return { error: 'Pick at least one scope.' };
  if (wanted.includes('raw:read') && !wanted.includes('notes:read')) {
    return { error: 'Original text is read through notes, so notes:read is needed too.' };
  }
  // Array.from(new Set()) keeps the order the caller wrote, which the page shows back.
  return { scopes: Array.from(new Set(wanted)) as Scope[] };
}

// Expiry is offered in days; null means the key lives until it is revoked.
export function expiryFrom(days: unknown, now: Date): { at: string | null } | { error: string } {
  if (days === undefined || days === null || days === '' || days === 'never') return { at: null };
  const n = typeof days === 'number' ? days : Number(days);
  if (!Number.isFinite(n) || n <= 0) return { error: 'Say how many days the key should last.' };
  const allowed = [30, 90, 180, 365];
  if (!allowed.includes(n)) return { error: `Expiry is one of ${allowed.join(', ')} days, or never.` };
  return { at: new Date(now.getTime() + n * 86400000).toISOString() };
}

export function keyNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Give the key a name, so you know which project holds it.';
  if (name.trim().length > 60) return 'Keep the name under 60 characters.';
  return null;
}

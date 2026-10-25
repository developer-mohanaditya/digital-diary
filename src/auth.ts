// The page's passphrase. It starts as the DIARY_PASSPHRASE secret, which only the Cloudflare
// dashboard can write; Settings needs a passphrase the Worker itself can change, so the current
// one is kept as a salted hash in the settings table (key "passphrase") once it has been
// changed from the page.
//
// The env secret stays the seed: while no hash exists it is the passphrase, and while a hash
// exists it is still enough to keep the page locked. Whichever holds, the typed value is
// compared against one of them, never both, so the two cannot disagree about what opens it.
//
// PBKDF2-SHA-256 through WebCrypto: no dependency, and the iteration count travels inside the
// stored string, so a future change still verifies the hashes written before it.

export const PASSPHRASE_KEY = 'passphrase';

// 100k is the usual floor for PBKDF2-SHA-256 and costs a few tens of milliseconds here. It is
// paid on sign-in and on a change, never on reading the diary.
const ITERATIONS = 100000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

const encoder = new TextEncoder();

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(text: string): Uint8Array | null {
  try {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function derive(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derive(passphrase, salt, ITERATIONS);
  return `pbkdf2$sha256$${ITERATIONS}$${toB64(salt)}$${toB64(key)}`;
}

// Compares every byte, so the time taken says nothing about how much of it was right.
export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  const salt = fromB64(parts[3]);
  const want = fromB64(parts[4]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1000000) return false;
  if (!salt || !salt.length || !want || want.length !== KEY_BYTES) return false;
  const got = await derive(passphrase, salt, iterations);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

// Why the new passphrase cannot be used, or null when it can. Kept here so the page and the
// Worker tell the user the same thing.
export function passphraseProblem(next: string, current: string): string | null {
  if (next.length < 8) return 'Use at least eight characters.';
  if (next.length > 200) return 'That is too long; keep the new one under 200 characters.';
  if (next === current) return 'That is the passphrase you already have.';
  return null;
}

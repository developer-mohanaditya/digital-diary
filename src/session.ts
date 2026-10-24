// Signed-cookie sessions for the diary page.
// One passphrase unlocks a cookie; the cookie carries its own expiry and signature,
// so every request can be checked without a session table or a database round trip.

export const SESSION_COOKIE = 'diary_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, in seconds

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

// Compares two strings without stopping at the first difference, so the time taken
// says nothing about how much of the passphrase was right.
export function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function issueSession(secret: string, now: Date): Promise<string> {
  const expires = Math.floor(now.getTime() / 1000) + SESSION_MAX_AGE;
  return `${expires}.${await sign(secret, String(expires))}`;
}

export async function sessionValid(token: string | null, secret: string, now: Date): Promise<boolean> {
  if (!token) return false;
  const [stamp, signature] = token.split('.');
  if (!stamp || !signature || !/^\d+$/.test(stamp)) return false;
  if (Number(stamp) * 1000 <= now.getTime()) return false; // expired
  return sameSecret(signature, await sign(secret, stamp));
}

export function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

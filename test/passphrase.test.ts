import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { hashPassphrase } from '../src/auth';
import { SESSION_COOKIE } from '../src/session';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A Supabase that only knows the settings table: enough for the gate, sign-in and the change.
function settingsStub(initial: string | null = null) {
  const state = { stored: initial, bodies: [] as Record<string, unknown>[] };
  const stub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    if (url.includes('/settings?')) {
      if (method === 'POST') {
        const row = JSON.parse(String(init.body)) as { key: string; value: string };
        state.bodies.push(row);
        state.stored = row.value;
        return new Response('', { status: 201 });
      }
      if (url.includes('key=eq.passphrase')) {
        return json(state.stored ? [{ value: state.stored }] : []);
      }
    }
    return json([]);
  });
  vi.stubGlobal('fetch', stub);
  return state;
}

const env = (extra: Record<string, unknown> = {}) => ({
  ASSETS: { fetch: async () => new Response('assets') },
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_KEY: 'service-key',
  TELEGRAM_BOT_TOKEN: 'bot',
  TELEGRAM_WEBHOOK_SECRET: 'hook',
  ALLOWED_CHAT_ID: '1',
  DIARY_TZ: 'UTC',
  DIARY_PASSPHRASE: 'open sesame',
  ...extra,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

const post = (path: string, body: unknown, cookie?: string) => new Request(`https://diary.test${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});

const cookieFrom = (res: Response) => (res.headers.get('Set-Cookie') ?? '').split(';')[0];

async function signInWith(passphrase: string, e = env()) {
  const res = await worker.fetch(post('/api/session', { passphrase }), e);
  return { res, cookie: cookieFrom(res) };
}

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/passphrase', () => {
  it('replaces the env passphrase with one the page chose, and hands back a fresh cookie', async () => {
    const state = settingsStub();
    const e = env();
    const { cookie } = await signInWith('open sesame', e);
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));

    const res = await worker.fetch(post('/api/passphrase', { current: 'open sesame', next: 'a brand new one' }, cookie), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // A hash is stored, and it is not the passphrase.
    expect(state.stored).toMatch(/^pbkdf2\$sha256\$/);
    expect(state.stored).not.toContain('a brand new one');
    expect(state.bodies[0]).toMatchObject({ key: 'passphrase' });

    const fresh = cookieFrom(res);
    expect(fresh).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(fresh).not.toBe(cookie);
    // The new cookie still reads the diary; the old one was signed with the old key.
    const read = (c: string) => new Request('https://diary.test/api/entries', { headers: { Cookie: c } });
    expect((await worker.fetch(read(fresh), e)).status).toBe(200);
  });

  it('takes the new passphrase and refuses the old one afterwards', async () => {
    settingsStub();
    const e = env();
    const { cookie } = await signInWith('open sesame', e);
    await worker.fetch(post('/api/passphrase', { current: 'open sesame', next: 'a brand new one' }, cookie), e);

    expect((await signInWith('a brand new one', e)).res.status).toBe(200);
    const old = await signInWith('open sesame', e);
    expect(old.res.status).toBe(401);
    expect((await old.res.json() as { error: string }).error).toBe('That passphrase is not right.');
  });

  it('works when the passphrase was saved earlier, with the env secret gone', async () => {
    const stored = await hashPassphrase('a brand new one');
    settingsStub(stored);
    // No DIARY_PASSPHRASE: the stored hash alone keeps the gate on.
    const e = env({ DIARY_PASSPHRASE: undefined });
    const { res, cookie } = await signInWith('a brand new one', e);
    expect(res.status).toBe(200);
    const changed = await worker.fetch(post('/api/passphrase', { current: 'a brand new one', next: 'another good one' }, cookie), e);
    expect(changed.status).toBe(200);
  });

  it('needs a session, and says only that the current one is wrong', async () => {
    settingsStub();
    const e = env();
    const anonymous = await worker.fetch(post('/api/passphrase', { current: 'open sesame', next: 'a brand new one' }), e);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ need: 'login' });

    const { cookie } = await signInWith('open sesame', e);
    const wrong = await worker.fetch(post('/api/passphrase', { current: 'nope nope', next: 'a brand new one' }, cookie), e);
    expect(wrong.status).toBe(403);
    expect((await wrong.json() as { error: string }).error).toBe('That is not the current passphrase.');
  });

  it('holds the new passphrase to the same rules the form does', async () => {
    settingsStub();
    const e = env();
    const { cookie } = await signInWith('open sesame', e);
    const short = await worker.fetch(post('/api/passphrase', { current: 'open sesame', next: 'short' }, cookie), e);
    expect(short.status).toBe(400);
    expect((await short.json() as { error: string }).error).toBe('Use at least eight characters.');
    const same = await worker.fetch(post('/api/passphrase', { current: 'open sesame', next: 'open sesame' }, cookie), e);
    expect(same.status).toBe(400);
  });

  it('refuses to set the first passphrase on a page with no lock at all', async () => {
    settingsStub();
    const e = env({ DIARY_PASSPHRASE: undefined });
    const res = await worker.fetch(post('/api/passphrase', { current: '', next: 'a brand new one' }), e);
    expect(res.status).toBe(409);
  });

  it('still lets the env passphrase in when the settings table does not exist yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(
      { code: 'PGRST205', message: "Could not find the table 'public.settings'" }, 404,
    )));
    const { res } = await signInWith('open sesame');
    expect(res.status).toBe(200);
  });

  it('answers 502 and changes nothing when the database cannot store the hash', async () => {
    settingsStub();
    const e = env();
    const { cookie } = await signInWith('open sesame', e);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input).includes('on_conflict=key') && (init.method ?? 'GET') === 'POST') {
        return new Response('boom', { status: 500 });
      }
      return json([]);
    }));
    const res = await worker.fetch(post('/api/passphrase', { current: 'open sesame', next: 'a brand new one' }, cookie), e);
    expect(res.status).toBe(502);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });
});

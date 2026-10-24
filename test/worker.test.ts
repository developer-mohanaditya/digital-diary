import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { SESSION_COOKIE } from '../src/session';

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

const supabaseStub = () => {
  const calls: string[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/thoughts?')) {
      return new Response(JSON.stringify([{
        id: 'th-1', day: '2026-10-23', category: 'inbox', category_source: 'auto', mode: 'refine',
        clean_text: 'Had a coffee with Ram.', raw_text: 'Had a coffee with Ram.',
        created_at: '2026-10-23T15:08:00.000Z', capture_id: 'cap-1',
      }]), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/reminders?')) {
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', stub);
  return calls;
};

const request = (path: string, init: RequestInit = {}) => new Request(`https://diary.test${path}`, init);
const cookieFrom = (res: Response) => (res.headers.get('Set-Cookie') ?? '').split(';')[0];

afterEach(() => vi.unstubAllGlobals());

describe('/api/session', () => {
  it('sets a signed cookie for the right passphrase', async () => {
    supabaseStub();
    const res = await worker.fetch(request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: 'open sesame' }),
    }), env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cookieFrom(res)).toMatch(new RegExp(`^${SESSION_COOKIE}=\\d+\\.[0-9a-f]{64}$`));
    expect(res.headers.get('Set-Cookie')).toContain('HttpOnly');
  });

  it('refuses a wrong passphrase and sets no cookie', async () => {
    supabaseStub();
    const res = await worker.fetch(request('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: 'wrong' }),
    }), env());
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect((await res.json() as { ok: boolean }).ok).toBe(false);
  });

  it('explains that the Worker has no passphrase instead of accepting anything', async () => {
    supabaseStub();
    const res = await worker.fetch(request('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'x' }),
    }), env({ DIARY_PASSPHRASE: undefined }));
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toContain('DIARY_PASSPHRASE');
  });

  it('clears the cookie on sign-out', async () => {
    supabaseStub();
    const res = await worker.fetch(request('/api/session', { method: 'DELETE' }), env());
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

describe('/telegram/webhook cleanup', () => {
  // Records every request the Worker makes so the stored row and the reply can be read back.
  const wire = () => {
    const bodies: { url: string; body: { [k: string]: unknown } | null }[] = [];
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      bodies.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes('/captures?on_conflict')) {
        return new Response(JSON.stringify([{ id: 'cap-1' }]), { headers: { 'Content-Type': 'application/json' } });
      }
      // An empty array answers the reads (settings, reminders) without upsetting JSON.parse.
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stub);
    return bodies;
  };
  const telegram = (bodies: { url: string; body: { [k: string]: unknown } | null }[]) =>
    bodies.find((b) => b.url.includes('api.telegram.org'))?.body as { text: string } | undefined;
  const update = (text: string) => request('/telegram/webhook', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook', 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_id: 77, message: { message_id: 1, date: 1791895200, text, chat: { id: 1 } } }),
  });

  it('writes the cleaned text and the original through the real route', async () => {
    const bodies = wire();
    const ai = { run: vi.fn(async () => ({ response: 'Had coffee with Ram.' })) };
    const res = await worker.fetch(update('um so I had a coffee with ram'), env({ AI: ai }));
    expect(res.status).toBe(200);
    const thought = bodies.find((b) => b.url.endsWith('/thoughts'))?.body;
    expect(thought).toMatchObject({
      clean_text: 'Had coffee with Ram.',
      raw_text: 'um so I had a coffee with ram',
      mode: 'refine',
    });
    expect(telegram(bodies)?.text).toBe('Saved to Inbox.');
  });

  it('saves the note as written when the model is unavailable, and says so', async () => {
    const bodies = wire();
    const ai = { run: vi.fn(async () => { throw new Error('Workers AI binding not available'); }) };
    const res = await worker.fetch(update('a quick note'), env({ AI: ai }));
    expect(res.status).toBe(200);
    expect(bodies.find((b) => b.url.endsWith('/thoughts'))?.body).toMatchObject({
      clean_text: 'a quick note', raw_text: 'a quick note',
    });
    expect(telegram(bodies)?.text).toContain('Cleanup failed');
  });

  it('with no AI binding on the Worker, stores the words as sent', async () => {
    const bodies = wire();
    const res = await worker.fetch(update('a plain note'), env({ AI: undefined }));
    expect(res.status).toBe(200);
    expect(bodies.find((b) => b.url.endsWith('/thoughts'))?.body).toMatchObject({
      clean_text: 'a plain note', raw_text: 'a plain note',
    });
  });
});

describe('/api/entries', () => {
  it('serves the diary openly when no passphrase is configured', async () => {
    supabaseStub();
    const res = await worker.fetch(request('/api/entries'), env({ DIARY_PASSPHRASE: undefined }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; total: number };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(1);
  });

  it('answers 401 and asks the page to sign in when there is no session', async () => {
    const calls = supabaseStub();
    const res = await worker.fetch(request('/api/entries'), env());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, need: 'login' });
    expect(calls).toHaveLength(0); // never touches the database
  });

  it('hands over the notes once the cookie from sign-in is presented', async () => {
    supabaseStub();
    const login = await worker.fetch(request('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'open sesame' }),
    }), env());
    const cookie = cookieFrom(login);

    const res = await worker.fetch(request('/api/entries', { headers: { Cookie: cookie } }), env());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; total: number; days: Record<string, { text: string }[]>;
    };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(1);
    expect(body.days['2026-10-23'][0].text).toBe('Had a coffee with Ram.');
  });

  it('rejects a cookie that was not signed with the passphrase', async () => {
    supabaseStub();
    const forged = `${SESSION_COOKIE}=9999999999.${'0'.repeat(64)}`;
    const res = await worker.fetch(request('/api/entries', { headers: { Cookie: forged } }), env());
    expect(res.status).toBe(401);
  });

  it('still accepts Cloudflare Access if it is enabled later', async () => {
    supabaseStub();
    const res = await worker.fetch(request('/api/entries', {
      headers: { 'Cf-Access-Jwt-Assertion': 'token' },
    }), env());
    expect(res.status).toBe(200);
  });
});

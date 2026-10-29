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
  // The settings table, remembered between calls: the beat's marker is read back after it is
  // written, and a stub that always answers "nothing saved" would prove nothing about it.
  const settings = new Map<string, string>();
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.method === 'POST' && url.includes('/settings')) {
      const body = JSON.parse(String(init.body ?? '[]')) as { key?: string; value?: string }[] | { key?: string; value?: string };
      const row = Array.isArray(body) ? body[0] : body;
      if (row?.key) settings.set(row.key, row.value ?? '');
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }
    const setting = /\/settings\?key=eq\.([a-z_]+)/.exec(url);
    if (setting) {
      const saved = settings.get(setting[1]);
      return new Response(JSON.stringify(saved === undefined ? [] : [{ value: saved }]), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/thoughts?') && url.includes('captures(source,client)')) {
      return new Response(JSON.stringify([{
        id: 'th-1', day: '2026-10-23', category: 'inbox', category_source: 'auto', mode: 'refine',
        clean_text: 'Had a coffee with Ram.', raw_text: 'Had a coffee with Ram.',
        created_at: '2026-10-23T15:08:00.000Z', capture_id: 'cap-1',
        captures: { source: 'telegram', client: null },
      }]), { headers: { 'Content-Type': 'application/json' } });
    }
    // The same rows without the capture embed: what a database that predates captures.client
    // answers, and the second read the fallback makes.
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
  // The reply specifically: a "typing…" chat action goes to the same host, and it goes first.
  const telegram = (bodies: { url: string; body: { [k: string]: unknown } | null }[]) =>
    bodies.find((b) => b.url.endsWith('/sendMessage'))?.body as { text: string } | undefined;
  const update = (text: string) => request('/telegram/webhook', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook', 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_id: 77, message: { message_id: 1, date: 1791895200, text, chat: { id: 1 } } }),
  });

  it('shows the phone that the message arrived, and types while the note is being stored', async () => {
    const bodies = wire();
    const ai = { run: vi.fn(async () => ({ response: 'Had coffee with Ram.' })) };
    await worker.fetch(update('um so I had a coffee with ram'), env({ AI: ai }));

    const action = bodies.find((b) => b.url.endsWith('/sendChatAction'))?.body;
    expect(action).toEqual({ chat_id: 1, action: 'typing' });
    // Before the reply, not after it: a chat action sent afterwards says nothing about the wait.
    const order = bodies.map((b) => b.url.split('/').pop());
    expect(order.indexOf('sendChatAction')).toBeLessThan(order.indexOf('sendMessage'));
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
    const lines = (telegram(bodies)?.text ?? '').split('\n');
    expect(lines[0]).toBe('✓ <b>Saved to Inbox</b>');
    expect(lines[2]).toBe('<i>"Had coffee with Ram."</i>');
    // The wait and what the model reported, on the one fact line.
    expect(lines[4]).toContain('·');
  });

  it('saves the note as written when the model is unavailable, and says so', async () => {
    const bodies = wire();
    const ai = { run: vi.fn(async () => { throw new Error('Workers AI binding not available'); }) };
    const res = await worker.fetch(update('a quick note'), env({ AI: ai }));
    expect(res.status).toBe(200);
    expect(bodies.find((b) => b.url.endsWith('/thoughts'))?.body).toMatchObject({
      clean_text: 'a quick note', raw_text: 'a quick note',
    });
    expect(telegram(bodies)?.text).toContain('cleanup failed');
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

describe('/api/ai-check', () => {
  it('reports each cleanup model and what it answered', async () => {
    supabaseStub();
    const AI = { run: vi.fn(async () => ({ response: 'ok' })) };
    const res = await worker.fetch(request('/api/ai-check'), env({ AI, DIARY_PASSPHRASE: undefined }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; binding: boolean; models: { model: string; ok: boolean; output?: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.binding).toBe(true);
    expect(body.models).toHaveLength(3);
    expect(body.models[0]).toMatchObject({ ok: true, output: 'ok' });
  });

  it('reports the real model error instead of a bare failure', async () => {
    supabaseStub();
    const AI = { run: vi.fn(async () => { throw new Error('Model not found: @cf/zai-org/glm-4.7-flash'); }) };
    const res = await worker.fetch(request('/api/ai-check'), env({ AI, DIARY_PASSPHRASE: undefined }));
    expect(res.status).toBe(502);
    const body = await res.json() as { ok: boolean; binding: boolean; models: { error?: string }[] };
    expect(body.ok).toBe(false);
    expect(body.binding).toBe(true);
    expect(body.models[0].error).toContain('Model not found');
  });

  it('says the binding itself is missing when there is no AI on the Worker', async () => {
    supabaseStub();
    const res = await worker.fetch(request('/api/ai-check'), env({ AI: undefined, DIARY_PASSPHRASE: undefined }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, binding: false });
  });

  it('is behind the passphrase when one is set', async () => {
    supabaseStub();
    const res = await worker.fetch(request('/api/ai-check'), env({ AI: { run: vi.fn() } }));
    expect(res.status).toBe(401);
  });
});

describe('/api/reclean', () => {
  const untouchedStub = () => {
    const patches: { url: string; body: { [k: string]: unknown } | null }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') patches.push({ url, body: JSON.parse(String(init.body)) });
      if (url.includes('/thoughts?mode=neq.verbatim')) {
        return new Response(JSON.stringify([{
          id: 'th-old', mode: 'refine', category: 'work',
          clean_text: 'the deploy went out and, um, raw is still missing',
          raw_text: 'the deploy went out and, um, raw is still missing',
        }]), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));
    return patches;
  };

  it('refuses to run without an accepted secret', async () => {
    untouchedStub();
    const res = await worker.fetch(request('/api/reclean', { method: 'POST' }), env());
    expect(res.status).toBe(401);
    const wrong = await worker.fetch(
      request('/api/reclean', { method: 'POST', headers: { 'x-reclean-token': 'nope' } }),
      env(),
    );
    expect(wrong.status).toBe(401);
  });

  it('also accepts the database service key, for a machine without the bot secret', async () => {
    const patches = untouchedStub();
    const AI = { run: vi.fn(async () => ({ response: 'The deploy went out.' })) };
    const res = await worker.fetch(
      request('/api/reclean', { method: 'POST', headers: { 'x-reclean-token': 'service-key' } }),
      env({ AI }),
    );
    expect(res.status).toBe(200);
    expect(patches).toHaveLength(1);
  });

  it('rewrites only the clean_text of a note the old model left untouched', async () => {
    const patches = untouchedStub();
    const AI = { run: vi.fn(async () => ({ response: 'The deploy went out.\n\nStill missing: **Raw**.' })) };
    const res = await worker.fetch(
      request('/api/reclean', { method: 'POST', headers: { 'x-reclean-token': 'hook' } }),
      env({ AI }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, scanned: 1, cleaned: 1, failed: [] });
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toContain('id=eq.th-old');
    expect(patches[0].body).toEqual({
      clean_text: 'The deploy went out.\n\nStill missing: **Raw**.',
      // The repair spends neurons too, and keeps the owner waiting, so both are recorded on
      // the row it rewrote.
      tokens_in: null,
      tokens_out: null,
      cleanup_model: expect.stringMatching(/^@cf\//),
      cleanup_ms: expect.any(Number),
    });
  });
});

describe('/api/note', () => {
  // Records each write so the row the page produced can be read back, exactly as the
  // Telegram tests read the row a message produced.
  const wire = () => {
    const bodies: { url: string; body: { [k: string]: unknown }[] | null }[] = [];
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      bodies.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes('/captures?')) return new Response(JSON.stringify([{ id: 'cap-9' }]), { headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/thoughts')) return new Response(JSON.stringify([{ id: 'th-9' }]), { headers: { 'Content-Type': 'application/json' } });
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stub);
    return bodies;
  };
  const note = (payload: Record<string, unknown>) => request('/api/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  it('stores a note typed on the page through the same cleanup as a message', async () => {
    const bodies = wire();
    const AI = { run: vi.fn(async () => ({ response: 'I am not going to that party this weekend.' })) };
    const res = await worker.fetch(note({
      text: 'hell no, am not going to that party this weekend', mode: 'refine', category: null, due: null,
    }), env({ AI, DIARY_PASSPHRASE: undefined }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, cleanup: 'formatted', category: 'inbox', mode: 'refine' });

    const capture = bodies.find((b) => b.url.includes('/captures?'))?.body?.[0];
    expect(capture).toMatchObject({
      source: 'web', kind: 'text', raw_text: 'hell no, am not going to that party this weekend',
      command_mode: 'refine', command_category: null,
    });
    const thought = bodies.find((b) => b.url.endsWith('/thoughts'))?.body?.[0];
    expect(thought).toMatchObject({
      clean_text: 'I am not going to that party this weekend.',
      raw_text: 'hell no, am not going to that party this weekend',
      mode: 'refine', category: 'inbox', category_source: 'auto',
    });
  });

  it('keeps a failed cleanup as a refined note with its raw text, and says what failed', async () => {
    const bodies = wire();
    const AI = { run: vi.fn(async () => { throw new Error('Workers AI binding not available'); }) };
    const res = await worker.fetch(note({ text: 'a plain note', mode: 'refine' }), env({ AI, DIARY_PASSPHRASE: undefined }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, cleanup: 'failed' });
    expect((await Promise.resolve(bodies)).find((b) => b.url.endsWith('/thoughts'))?.body?.[0]).toMatchObject({
      clean_text: 'a plain note', raw_text: 'a plain note', mode: 'refine',
    });
  });

  it('does not call the model for a verbatim note and files it where it was asked', async () => {
    const bodies = wire();
    const AI = { run: vi.fn() };
    const res = await worker.fetch(
      note({ text: 'the exact words', mode: 'verbatim', category: 'quote' }),
      env({ AI, DIARY_PASSPHRASE: undefined }),
    );
    expect(AI.run).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, cleanup: 'verbatim', category: 'quote' });
    expect(bodies.find((b) => b.url.endsWith('/thoughts'))?.body?.[0]).toMatchObject({
      clean_text: 'the exact words', raw_text: 'the exact words', mode: 'verbatim', category_source: 'tag',
    });
  });

  it('creates the deadline reminder for a due date picked on the page', async () => {
    const bodies = wire();
    const res = await worker.fetch(note({
      text: 'send the proposal', mode: 'verbatim', category: 'deadline', due: '2026-11-03',
    }), env({ DIARY_PASSPHRASE: undefined }));
    expect(res.status).toBe(200);
    const reminder = bodies.find((b) => b.url.endsWith('/reminders'))?.body?.[0];
    expect(reminder).toMatchObject({ kind: 'deadline', due_at: '2026-11-03T09:00:00.000Z', status: 'pending' });
  });

  it('is behind the passphrase and writes nothing without a session', async () => {
    const bodies = wire();
    const res = await worker.fetch(note({ text: 'a note' }), env());
    expect(res.status).toBe(401);
    // The gate reads the passphrase row to know whether it is locked; nothing is written.
    expect(bodies.filter((b) => b.body)).toHaveLength(0);
  });

  it('refuses an empty note instead of storing a blank row', async () => {
    const bodies = wire();
    const res = await worker.fetch(note({ text: '   ' }), env({ DIARY_PASSPHRASE: undefined }));
    expect(res.status).toBe(400);
    expect(bodies.filter((b) => b.body)).toHaveLength(0);
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
    // The only read is the settings row that says whether a passphrase exists; the notes
    // themselves are never queried for an unsigned visitor.
    expect(calls.filter((u) => u.includes('/thoughts') || u.includes('/reminders'))).toHaveLength(0);
  });

  it('hands over the notes once the cookie from sign-in is presented', async () => {
    const calls = supabaseStub();
    const login = await worker.fetch(request('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'open sesame' }),
    }), env());
    const cookie = cookieFrom(login);

    const res = await worker.fetch(request('/api/entries', { headers: { Cookie: cookie } }), env());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; total: number;
      days: Record<string, { text: string; origin?: { source: string; client: string | null } }[]>;
    };
    expect(body.ok).toBe(true);
    expect(body.total).toBe(1);
    expect(body.days['2026-10-23'][0].text).toBe('Had a coffee with Ram.');
    // The note is marked with where it came in from, which rides on the capture the read embeds.
    expect(body.days['2026-10-23'][0].origin).toEqual({ source: 'telegram', client: null });
    expect(calls.some((u) => u.includes('/thoughts?') && u.includes('captures(source,client)'))).toBe(true);
  });

  it('serves the notes without an origin when the capture cannot be read', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      // A database that predates captures.client refuses the embed outright.
      if (url.includes('/thoughts?') && url.includes('captures(source,client)')) return new Response('bad', { status: 400 });
      if (url.includes('/thoughts?')) {
        return new Response(JSON.stringify([{
          id: 'th-1', day: '2026-10-23', category: 'inbox', category_source: 'auto', mode: 'refine',
          clean_text: 'Had a coffee with Ram.', raw_text: 'Had a coffee with Ram.',
          created_at: '2026-10-23T15:08:00.000Z', capture_id: 'cap-1',
        }]), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));

    const login = await worker.fetch(request('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'open sesame' }),
    }), env());
    const res = await worker.fetch(request('/api/entries', { headers: { Cookie: cookieFrom(login) } }), env());
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; days: Record<string, { origin?: unknown }[]> };
    expect(body.total).toBe(1);
    expect(body.days['2026-10-23'][0].origin).toBeUndefined();
    expect(calls.filter((u) => u.includes('/thoughts?'))).toHaveLength(2);
  });

  it('rejects a cookie that was not signed with the passphrase', async () => {
    supabaseStub();
    const forged = `${SESSION_COOKIE}=9999999999.${'0'.repeat(64)}`;
    const res = await worker.fetch(request('/api/entries', { headers: { Cookie: forged } }), env());
    expect(res.status).toBe(401);
  });

  it('does not open the diary for a forged Cloudflare Access header', async () => {
    supabaseStub();
    const res = await worker.fetch(request('/api/entries', {
      headers: { 'Cf-Access-Jwt-Assertion': 'token' },
    }), env());
    expect(res.status).toBe(401);
  });

  it('will not mint a key for that header either', async () => {
    supabaseStub();
    const res = await worker.fetch(request('/api/keys', {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': 'token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'stolen', scopes: ['notes:read'] }),
    }), env());
    expect(res.status).toBe(401);
  });
});

describe('scheduled', () => {
  it('beats once for a keep-alive slot, says so on Telegram, and stays quiet for the rest of it', async () => {
    const calls = supabaseStub();
    const beats = () => calls.filter((u) => u.endsWith('/heartbeats'));
    const said = () => calls.filter((u) => u.includes('api.telegram.org'));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-15T10:30:00Z')); // 12:30 in Paris
      await worker.scheduled({}, env({ DIARY_TZ: 'Europe/Paris' }));
      expect(beats()).toHaveLength(1);
      expect(said()).toHaveLength(1);

      // The twin entry an hour out, and any other run before the next slot: spent.
      calls.length = 0;
      vi.setSystemTime(new Date('2026-07-15T11:30:00Z')); // 13:30
      await worker.scheduled({}, env({ DIARY_TZ: 'Europe/Paris' }));
      expect(beats()).toHaveLength(0);
      expect(said()).toHaveLength(0);

      // The evening slot, and then the noon slot of the next day.
      vi.setSystemTime(new Date('2026-07-15T15:00:00Z')); // 17:00
      await worker.scheduled({}, env({ DIARY_TZ: 'Europe/Paris' }));
      expect(beats()).toHaveLength(1);

      calls.length = 0;
      vi.setSystemTime(new Date('2026-07-16T10:30:00Z')); // 12:30 the next day
      await worker.scheduled({}, env({ DIARY_TZ: 'Europe/Paris' }));
      expect(beats()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('catches a slot up when the run that should have taken it never came', async () => {
    const calls = supabaseStub();
    vi.useFakeTimers();
    try {
      // 13:30 in Paris, with nothing beaten for 12:30: the beat used to be skipped here, for ever.
      vi.setSystemTime(new Date('2026-07-15T11:30:00Z'));
      await worker.scheduled({}, env({ DIARY_TZ: 'Europe/Paris' }));
      expect(calls.filter((u) => u.endsWith('/heartbeats'))).toHaveLength(1);
      expect(calls.filter((u) => u.includes('api.telegram.org'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a failing step of the schedule not take the others down with it', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/reminders?')) throw new Error('the database is not answering');
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-15T10:30:00Z')); // 12:30 in Paris
      await worker.scheduled({}, env({ DIARY_TZ: 'Europe/Paris' }));
      // The reminder read threw; the beat was still made and still said so.
      expect(calls.filter((u) => u.endsWith('/heartbeats'))).toHaveLength(1);
      expect(calls.filter((u) => u.includes('api.telegram.org'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

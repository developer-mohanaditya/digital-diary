import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
// A row id as Supabase issues them: the route refuses anything that could rewrite the query.
const ID = '9f1c1a2b-0000-4000-8000-123456789abc';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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

// A Supabase with the three calls this route makes: the thoughts update, the reminder lookup
// and the reminder write. Everything is recorded so the tests can read the wire.
function stub(opts: { rows?: Record<string, unknown>[]; pending?: string[] } = {}) {
  const calls: { url: string; method: string; body: any }[] = [];
  const state = {
    rows: opts.rows ?? [{ id: ID, capture_id: 'cap-1', clean_text: 'A note that became a deadline' }],
    pending: opts.pending ?? [],
    created: [] as Record<string, unknown>[],
  };
  const fake = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url.includes('/thoughts?id=eq.')) return json(method === 'PATCH' ? state.rows : []);
    if (url.includes('/reminders?')) {
      if (method === 'PATCH' || method === 'DELETE') return new Response(null, { status: 204 });
      return json(state.pending.map((id) => ({ id })));
    }
    if (url.endsWith('/reminders') && method === 'POST') {
      state.created.push(...(body as Record<string, unknown>[]));
      return new Response('', { status: 201 });
    }
    return json([]);
  });
  vi.stubGlobal('fetch', fake);
  return { calls, state };
}

const post = (body: unknown, cookie?: string) => new Request('https://diary.test/api/note/move', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});

async function signedIn(e = env()) {
  const res = await worker.fetch(new Request('https://diary.test/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: 'open sesame' }),
  }), e);
  return (res.headers.get('Set-Cookie') ?? '').split(';')[0];
}

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/note/move', () => {
  it('rewrites the row and marks the category as chosen by hand', async () => {
    const { calls } = stub();
    const cookie = await signedIn();
    const res = await worker.fetch(post({ id: ID, category: 'work' }, cookie), env());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: ID, category: 'work' });
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/thoughts'));
    expect(patch?.url).toContain(`/thoughts?id=eq.${ID}`);
    expect(patch?.body).toEqual({ category: 'work', category_source: 'manual' });
  });

  it('needs a session', async () => {
    const { calls } = stub();
    const res = await worker.fetch(post({ id: ID, category: 'work' }), env());
    expect(res.status).toBe(401);
    expect((await res.json() as { need: string }).need).toBe('login');
    // The gate reads the passphrase row; the note itself is never touched.
    expect(calls.filter((c) => c.url.includes('/thoughts') || c.url.includes('/reminders'))).toHaveLength(0);
  });

  it('refuses an unknown category and a made-up id before it writes anything', async () => {
    const { calls } = stub();
    const e = env();
    const cookie = await signedIn(e);
    expect((await worker.fetch(post({ id: ID, category: 'lunch' }, cookie), e)).status).toBe(400);
    expect((await worker.fetch(post({ id: "th-1' or 1=1", category: 'work' }, cookie), e)).status).toBe(400);
    expect(calls.filter((c) => c.url.includes('/thoughts') || c.url.includes('/reminders'))).toHaveLength(0);
  });

  it('answers 404 when the row is gone rather than pretending it moved', async () => {
    stub({ rows: [] });
    const e = env();
    const cookie = await signedIn(e);
    const res = await worker.fetch(post({ id: ID, category: 'work' }, cookie), e);
    expect(res.status).toBe(404);
  });

  it('schedules the reminder a deadline needs, dated the way the composer would', async () => {
    const { state } = stub();
    const e = env();
    const cookie = await signedIn(e);
    const res = await worker.fetch(post({ id: ID, category: 'deadline', due: '2026-11-10' }, cookie), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, due: '2026-11-10', reminder: 'set' });
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({
      capture_id: 'cap-1', thought_id: ID, kind: 'deadline', status: 'pending', source: 'explicit',
      due_at: '2026-11-10T09:00:00.000Z', next_remind_at: '2026-11-07T09:00:00.000Z',
    });
  });

  it('will not file a note under Deadline without a date', async () => {
    const { calls } = stub();
    const e = env();
    const cookie = await signedIn(e);
    const res = await worker.fetch(post({ id: ID, category: 'deadline' }, cookie), e);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('due date');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('reschedules the reminder that is already there instead of stacking a second one', async () => {
    const { calls, state } = stub({ pending: ['rem-1'] });
    const e = env();
    const cookie = await signedIn(e);
    const res = await worker.fetch(post({ id: ID, category: 'deadline', due: '2026-11-10' }, cookie), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reminder: 'moved' });
    expect(state.created).toHaveLength(0);
    const resch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/reminders'));
    expect(resch?.url).toContain('id=eq.rem-1');
    expect(resch?.body).toMatchObject({ due_at: '2026-11-10T09:00:00.000Z' });
  });

  it('leaves Deadline by removing the reminder and its due badge', async () => {
    const { calls } = stub({ pending: ['rem-1'] });
    const e = env();
    const cookie = await signedIn(e);
    const res = await worker.fetch(post({ id: ID, category: 'life' }, cookie), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, category: 'life', reminder: 'closed' });
    const gone = calls.find((c) => c.method === 'DELETE' && c.url.includes('/reminders'));
    expect(gone?.url).toContain(`thought_id=eq.${ID}`);
    // Nothing left to draw a due date from, so the entry stops being a deadline.
    expect(calls.filter((c) => c.method === 'PATCH' && c.url.includes('/reminders'))).toHaveLength(0);
  });
});

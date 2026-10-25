import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

// A row id as Supabase issues them: the route refuses anything that could rewrite the query.
const ID = '9f1c1a2b-0000-4000-8000-123456789abc';
const REMINDER = 'aa11bb22-0000-4000-8000-123456789abc';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const env = () => ({
  ASSETS: { fetch: async () => new Response('assets') },
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_KEY: 'service-key',
  TELEGRAM_BOT_TOKEN: 'bot',
  TELEGRAM_WEBHOOK_SECRET: 'hook',
  ALLOWED_CHAT_ID: '1',
  DIARY_TZ: 'UTC',
  DIARY_PASSPHRASE: 'open sesame',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

// The three calls this route makes: the note's capture, the deadline on that capture, and the
// reminder write. Everything is recorded so the tests can read the wire.
function stub(opts: { capture?: string | null; deadlines?: { id: string }[] } = {}) {
  const calls: { url: string; method: string; body: any }[] = [];
  const state = {
    capture: opts.capture === undefined ? 'cap-1' : opts.capture,
    deadlines: opts.deadlines ?? [{ id: REMINDER }],
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url.includes('/thoughts?id=eq.')) return json(state.capture ? [{ capture_id: state.capture }] : []);
    if (url.includes('/reminders?capture_id=eq.')) return json(state.deadlines);
    if (url.includes('/reminders?id=eq.')) return new Response(null, { status: 204 });
    return json([]);
  }));
  return { calls, state };
}

const post = (body: unknown, cookie?: string) => new Request('https://diary.test/api/reminder/done', {
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

describe('POST /api/reminder/done', () => {
  it('closes the deadline on the note and stamps when it was ticked', async () => {
    const { calls } = stub();
    const e = env();
    const cookie = await signedIn(e);
    const res = await worker.fetch(post({ id: ID, done: true }, cookie), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: ID, done: true });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toContain(`/reminders?id=eq.${REMINDER}`);
    expect(patch?.body.status).toBe('done');
    expect(typeof patch?.body.done_at).toBe('string');
  });

  it('reopens it and pushes the next ping a day out, so a mistake does not page at once', async () => {
    const { calls } = stub();
    const e = env();
    const cookie = await signedIn(e);
    const res = await worker.fetch(post({ id: ID, done: false }, cookie), e);
    expect(res.status).toBe(200);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body.status).toBe('pending');
    expect(patch?.body.done_at).toBeNull();
    const next = new Date(patch?.body.next_remind_at).getTime();
    expect(next - Date.now()).toBeGreaterThan(20 * 3600 * 1000);
  });

  it('needs a session, and writes nothing without one', async () => {
    const { calls } = stub();
    const res = await worker.fetch(post({ id: ID, done: true }), env());
    expect(res.status).toBe(401);
    expect((await res.json() as { need: string }).need).toBe('login');
    expect(calls.filter((c) => c.url.includes('/reminders'))).toHaveLength(0);
  });

  it('refuses a made-up id and a body that does not say which way', async () => {
    const { calls } = stub();
    const e = env();
    const cookie = await signedIn(e);
    expect((await worker.fetch(post({ id: "th-1' or 1=1", done: true }, cookie), e)).status).toBe(400);
    expect((await worker.fetch(post({ id: ID }, cookie), e)).status).toBe(400);
    expect((await worker.fetch(post({ id: ID, done: 'yes' }, cookie), e)).status).toBe(400);
    expect(calls.filter((c) => c.url.includes('/reminders'))).toHaveLength(0);
  });

  it('answers 404 when the note carries no deadline, instead of pretending', async () => {
    const none = stub({ deadlines: [] });
    const e = env();
    const cookie = await signedIn(e);
    const res = await worker.fetch(post({ id: ID, done: true }, cookie), e);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain('no deadline');
    expect(none.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);

    const noCapture = stub({ capture: null });
    const second = await worker.fetch(post({ id: ID, done: true }, cookie), env());
    expect(second.status).toBe(404);
    expect(noCapture.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('reports a database refusal rather than claiming the deadline changed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? 'GET').toUpperCase();
      if (url.includes('/thoughts?id=eq.')) return json([{ capture_id: 'cap-1' }]);
      if (url.includes('/reminders?capture_id=eq.')) return json([{ id: REMINDER }]);
      if (method === 'PATCH') return json({ message: 'permission denied' }, 403);
      return json([]);
    }));
    const e = env();
    const cookie = await signedIn(e);
    const res = await worker.fetch(post({ id: ID, done: true }, cookie), e);
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toContain('403');
  });
});

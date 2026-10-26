import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { generateKey, hashKey, lookupPrefix, type Scope } from '../src/apikey';

// The API is read-only and every answer is a JSON envelope, so the tests here are about the
// things that could quietly go wrong: a key that should be refused, a filter that should not
// reach the query, a shape that should not leave the building, and the headers that keep a
// page of notes out of a cache.

const KEY = generateKey();
const OTHER = generateKey();
const CAPTURE = 'cap-1';
const TODAY_ROW_AT = '2026-10-15T19:41:02Z'; // CEST, so 21:41 in the diary's timezone

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const env = () => ({
  ASSETS: { fetch: async () => new Response('assets') },
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_KEY: 'service-key',
  TELEGRAM_BOT_TOKEN: 'bot',
  TELEGRAM_WEBHOOK_SECRET: 'hook',
  ALLOWED_CHAT_ID: '1',
  DIARY_TZ: 'Europe/Paris',
  DIARY_PASSPHRASE: 'open sesame',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

interface Stub {
  scopes?: Scope[];
  revoked?: boolean;
  expires?: string | null;
  policy?: Record<string, unknown> | null;
  rows?: Record<string, unknown>[];
  reminders?: Record<string, unknown>[];
  bump?: { minute_count: number; day_count: number };
}

// The real digest of KEY, so a stub row can hold a hash that verifies. A request for any other
// prefix finds no row, exactly as it would against the database.
let keyHash = '';

// One stub for the whole database surface the API touches, recording everything it was asked,
// so the tests can read the wire instead of guessing at it.
function stub(opts: Stub = {}) {
  const calls: { url: string; method: string; body: any }[] = [];
  const row = {
    id: 'key-1',
    name: 'portfolio',
    prefix: lookupPrefix(KEY),
    hash: keyHash,
    scopes: opts.scopes ?? ['notes:read', 'deadlines:read', 'stats:read'],
    policy: opts.policy ?? null,
    per_minute: 60,
    per_day: 5000,
    last_used_at: new Date().toISOString(),
    expires_at: opts.expires ?? null,
    revoked_at: opts.revoked ? new Date().toISOString() : null,
  };
  const state = {
    rows: opts.rows ?? [
      {
        id: 'note-1', day: '2026-10-15', category: 'work', category_source: 'tag', mode: 'refine',
        clean_text: 'Merged the release candidate.', raw_text: 'merged rc', created_at: TODAY_ROW_AT,
        capture_id: CAPTURE, tokens_in: 210, tokens_out: 48, cleanup_model: '@cf/m',
      },
    ],
    reminders: opts.reminders ?? [],
    bump: opts.bump ?? { minute_count: 1, day_count: 1 },
  };

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    // --- keys ---
    const asked = /\/api_keys\?prefix=eq\.([^&]+)/.exec(url);
    if (asked) return json(asked[1] === lookupPrefix(KEY) ? [row] : []);
    if (method === 'POST' && url.endsWith('/api_keys')) {
      return json([{ id: 'key-new', created_at: new Date().toISOString(), last_used_at: null, expires_at: null, revoked_at: null, ...body }]);
    }
    if (url.includes('/api_keys?select=id,name')) {
      return json([{
        id: 'key-1', name: 'portfolio', prefix: lookupPrefix(KEY), scopes: ['notes:read'],
        policy: { categories: ['work'], from: null, to: null, text: 'clean' },
        created_at: '2026-10-01T00:00:00Z', last_used_at: null, expires_at: null, revoked_at: null,
      }]);
    }
    if (url.includes('/api_keys?id=eq.')) return json([{ id: 'key-1' }]);

    // --- counters and aggregates ---
    if (url.includes('/rpc/bump_api_usage')) return json([state.bump]);
    if (url.includes('/rpc/diary_stats')) return json([{ bucket: '2026-10', notes: 12, words: 340, days: 9 }]);
    if (url.includes('/rpc/diary_days')) {
      return json([{ day: '2026-10-25', notes: 2, words: 30, categories: { work: 2 }, first_at: '2026-10-25T09:00:00Z', last_at: '2026-10-25T19:41:02Z' }]);
    }

    // --- the diary itself ---
    if (url.includes('/reminders?capture_id=in.')) return json(state.reminders);
    if (url.includes('/reminders?')) return json(state.reminders);
    if (url.includes('/thoughts?')) return json(state.rows);
    if (url.includes('/categories?')) return json([{ id: 'work', label: 'Work', sort_order: 5 }]);
    return json([]);
  }));

  return { calls, state };
}

function api(path: string, init: RequestInit = {}, key = KEY): Request {
  return new Request(`https://diary.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
  });
}

beforeEach(async () => { keyHash = await hashKey(KEY); });
afterEach(() => vi.unstubAllGlobals());

describe('GET /api/v1 authentication', () => {
  it('answers the shape of itself without a key, and never a note', async () => {
    stub();
    const res = await worker.fetch(new Request('https://diary.test/api/v1'), env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { api: { version: string; timeZone: string }; endpoints: unknown[] };
    expect(body.api).toMatchObject({ version: 'v1', timeZone: 'Europe/Paris' });
    expect(body.endpoints.length).toBeGreaterThan(5);
    expect(JSON.stringify(body)).not.toContain('Merged the release candidate');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('refuses a missing, malformed or unknown key with the same 401', async () => {
    stub();
    const plain = await worker.fetch(new Request('https://diary.test/api/v1/notes'), env());
    expect(plain.status).toBe(401);

    const malformed = await worker.fetch(api('/api/v1/notes', {}, 'nonsense'), env());
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(malformed.headers.get('WWW-Authenticate')).toContain('Bearer');

    const unknown = await worker.fetch(api('/api/v1/notes', {}, OTHER), env());
    expect(unknown.status).toBe(401);
    // Indistinguishable from the malformed one: the answer never says which part was wrong.
    expect(await unknown.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('refuses a revoked or an expired key', async () => {
    stub({ revoked: true });
    expect((await worker.fetch(api('/api/v1/notes'), env())).status).toBe(401);
    stub({ expires: '2020-01-01T00:00:00Z' });
    expect((await worker.fetch(api('/api/v1/notes'), env())).status).toBe(401);
  });

  it('names the scope a key is missing instead of answering empty', async () => {
    stub({ scopes: ['notes:read'] });
    const res = await worker.fetch(api('/api/v1/stats'), env());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('is read-only', async () => {
    stub();
    const res = await worker.fetch(api('/api/v1/notes', { method: 'POST' }), env());
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD');
  });

  it('answers 429 and says when to come back when the minute is spent', async () => {
    stub({ bump: { minute_count: 61, day_count: 61 } });
    const res = await worker.fetch(api('/api/v1/notes'), env());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('names the migration when the key tables are missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'PGRST205', message: 'relation does not exist' }, 404)));
    const res = await worker.fetch(api('/api/v1/notes'), env());
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain('0007');
  });
});

describe('GET /api/v1/notes', () => {
  it('turns a month and a category into one bounded query', async () => {
    const { calls } = stub();
    const res = await worker.fetch(api('/api/v1/notes?month=2026-10&category=work,life&limit=10'), env());
    expect(res.status).toBe(200);
    const query = calls.find((c) => c.url.includes('/thoughts?'))!.url;
    expect(query).toContain('day=gte.2026-10-01');
    expect(query).toContain('day=lte.2026-10-31');
    expect(query).toContain('category=in.(work,life)');
    expect(query).toContain('limit=11');
    const body = (await res.json()) as { notes: { day: string; time: string; text: string; words: number }[] };
    expect(body.notes[0]).toMatchObject({ day: '2026-10-15', time: '21:41', words: 4 });
  });

  it('refuses two ways of saying the same period, and a made-up date', async () => {
    const { calls } = stub();
    expect((await worker.fetch(api('/api/v1/notes?day=2026-10-25&month=2026-10'), env())).status).toBe(400);
    expect((await worker.fetch(api('/api/v1/notes?day=2026-02-31'), env())).status).toBe(400);
    expect((await worker.fetch(api('/api/v1/notes?category=holiday'), env())).status).toBe(400);
    expect((await worker.fetch(api('/api/v1/notes?cursor=made-up'), env())).status).toBe(400);
    expect(calls.filter((c) => c.url.includes('/thoughts?'))).toHaveLength(0);
  });

  // A limit is digits or nothing: Number() would read 0x10, 1e3 and +1 as quantities, and a
  // page size that silently becomes 16 is worse than a refusal.
  it('takes a limit written in decimal only', async () => {
    stub();
    for (const q of ['limit=0', 'limit=-5', 'limit=1.5', 'limit=abc', 'limit=', 'limit=0x10', 'limit=1e3', 'limit=%2B1']) {
      const res = await worker.fetch(api(`/api/v1/notes?${q}`), env());
      expect(res.status, q).toBe(400);
    }
    expect((await worker.fetch(api('/api/v1/notes?limit=3'), env())).status).toBe(200);
  });

  it('refuses a cursor that does not point at a row id', async () => {
    const { calls } = stub();
    const cursor = (text: string) => encodeURIComponent(btoa(text).replace(/=+$/, ''));
    const forged = await worker.fetch(api(`/api/v1/notes?cursor=${cursor('2026-10-25T00:00:00Z|note-1')}`), env());
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({ error: { code: 'bad_cursor' } });
    expect(calls.filter((c) => c.url.includes('/thoughts?'))).toHaveLength(0);

    const real = await worker.fetch(
      api(`/api/v1/notes?cursor=${cursor('2026-10-24T00:00:00Z|9f1c1a2b-0000-4000-8000-123456789abc')}`),
      env(),
    );
    expect(real.status).toBe(200);
    expect(calls.find((c) => c.url.includes('/thoughts?'))!.url).toContain('id.lt.9f1c1a2b-0000-4000-8000-123456789abc');
  });

  it('clamps a page to 500 and says where the next one starts', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `note-${i}`, day: '2026-10-15', category: 'work', category_source: 'auto', mode: 'refine',
      clean_text: `note ${i}`, raw_text: 'x', created_at: `2026-10-15T1${i}:00:00Z`, capture_id: CAPTURE,
    }));
    const { calls } = stub({ rows });
    const res = await worker.fetch(api('/api/v1/notes?limit=2&order=desc'), env());
    expect(calls.find((c) => c.url.includes('/thoughts?'))!.url).toContain('limit=3');
    const body = (await res.json()) as { notes: unknown[]; meta: { count: number; next: string | null } };
    expect(body.notes).toHaveLength(2);
    expect(body.meta.next).toBeTruthy();

    expect((await worker.fetch(api('/api/v1/notes?limit=9999'), env())).status).toBe(200);
    expect(calls.filter((c) => c.url.includes('/thoughts?')).pop()!.url).toContain('limit=501');
  });

  it('keeps the original text behind its scope, and never leaks it by default', async () => {
    stub();
    const plain = await worker.fetch(api('/api/v1/notes'), env());
    expect(JSON.stringify(await plain.json())).not.toContain('merged rc');

    stub({ scopes: ['notes:read'] });
    const asked = await worker.fetch(api('/api/v1/notes?fields=raw'), env());
    expect(asked.status).toBe(403);

    // Granted is not the same as wanted: a raw:read key that does not ask still gets no raw.
    stub({ scopes: ['notes:read', 'raw:read'] });
    const unasked = await worker.fetch(api('/api/v1/notes'), env());
    expect(JSON.stringify(await unasked.json())).not.toContain('merged rc');

    const allowed = (await (await worker.fetch(api('/api/v1/notes?fields=id,raw'), env())).json()) as {
      notes: Record<string, unknown>[];
    };
    expect(allowed.notes[0]).toEqual({ id: 'note-1', raw: 'merged rc' });
  });

  it('cuts the shape down to the fields that were asked for', async () => {
    stub();
    const body = (await (await worker.fetch(api('/api/v1/notes?fields=id,text'), env())).json()) as {
      notes: Record<string, unknown>[];
    };
    expect(Object.keys(body.notes[0]).sort()).toEqual(['id', 'text']);
  });

  it('carries the deadline and whether it is done', async () => {
    const row = { id: 'r1', capture_id: CAPTURE, thought_id: 'note-1', title: 'Proposal', due_at: '2026-11-03T09:00:00Z', status: 'done', done_at: '2026-11-01T10:00:00Z', created_at: '2026-10-25T09:00:00Z' };
    const { calls } = stub({ reminders: [row] });
    const res = await worker.fetch(api('/api/v1/notes?has=deadline'), env());
    expect(calls.find((c) => c.url.includes('kind=eq.deadline&select=capture_id'))!.url).toContain('capture_id&limit=500');
    const body = (await res.json()) as { notes: { due: string; done: boolean; doneAt: string }[] };
    expect(body.notes[0]).toMatchObject({ due: '2026-11-03', done: true, doneAt: '2026-11-01T10:00:00Z' });
  });

  it('answers one note, and 404 for an id with no row behind it', async () => {
    const { calls } = stub();
    const one = await worker.fetch(api('/api/v1/notes/9f1c1a2b-0000-4000-8000-123456789abc'), env());
    expect(one.status).toBe(200);
    expect(calls.some((c) => c.url.includes('/thoughts?id=eq.'))).toBe(true);

    stub({ rows: [] });
    const missing = await worker.fetch(api('/api/v1/notes/9f1c1a2b-0000-4000-8000-123456789abc'), env());
    expect(missing.status).toBe(404);
  });

  it('refuses an id that is not a row id, before it reaches the database', async () => {
    const { calls } = stub();
    for (const bad of ['abc', 'abcdefgh', "9f1c1a2b' or 1=1--", '9f1c1a2b-0000-4000-8000-123456789abz']) {
      const res = await worker.fetch(api(`/api/v1/notes/${encodeURIComponent(bad)}`), env());
      expect(res.status, bad).toBe(400);
    }
    expect((await worker.fetch(api('/api/v1/deadlines/abcdefgh'), env())).status).toBe(400);
    expect(calls.filter((c) => c.url.includes('/thoughts?id=eq.'))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes('/reminders?id=eq.'))).toHaveLength(0);
  });

  it('sets no CORS header, so another page cannot read the answer', async () => {
    stub();
    const res = await worker.fetch(api('/api/v1/notes'), env());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('the aggregate endpoints', () => {
  it('groups by year through the database, not over the wire', async () => {
    const { calls } = stub();
    const res = await worker.fetch(api('/api/v1/stats?year=2026&by=year'), env());
    expect(res.status).toBe(200);
    const call = calls.find((c) => c.url.includes('/rpc/diary_stats'))!;
    expect(call.body).toEqual({ p_from: '2026-01-01', p_to: '2026-12-31', p_by: 'year', p_categories: null });
    const body = (await res.json()) as { groups: { key: string; notes: number }[]; meta: { totals: { notes: number } } };
    expect(body.groups[0]).toMatchObject({ key: '2026-10', notes: 12 });
    expect(body.meta.totals.notes).toBe(12);
  });

  it('refuses a grouping it does not know', async () => {
    stub();
    expect((await worker.fetch(api('/api/v1/stats?by=fortnight'), env())).status).toBe(400);
  });

  it('rolls days up with their category tally', async () => {
    stub();
    const body = (await (await worker.fetch(api('/api/v1/days?month=2026-10'), env())).json()) as {
      days: { day: string; notes: number; categories: Record<string, number> }[];
    };
    expect(body.days[0]).toMatchObject({ day: '2026-10-25', notes: 2, categories: { work: 2 } });
  });

  it('answers open, done or all deadlines with the days left and late', async () => {
    const row = {
      id: 'r1', capture_id: CAPTURE, thought_id: 'note-1', title: 'Proposal', due_at: '2026-10-20T09:00:00Z',
      status: 'done', done_at: '2026-10-22T10:00:00Z', created_at: '2026-10-10T09:00:00Z',
    };
    const { calls } = stub({ reminders: [row] });
    const res = await worker.fetch(api('/api/v1/deadlines?status=done'), env());
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.url.includes('/reminders?'))!.url).toContain('status=eq.done');
    const body = (await res.json()) as { deadlines: { due: string; daysLate: number; openDays: number; done: boolean; note?: { id: string } }[] };
    expect(body.deadlines[0]).toMatchObject({ due: '2026-10-20', daysLate: 2, openDays: 12, done: true });
    expect(body.deadlines[0].note?.id).toBe('note-1');
  });
});

describe('GET /api/v1/export', () => {
  it('writes CSV a spreadsheet can open, quoting the text it must', async () => {
    stub({
      rows: [{
        id: 'note-1', day: '2026-10-15', category: 'work', category_source: 'tag', mode: 'refine',
        clean_text: 'He said "ship it", then left.', raw_text: 'x',
        created_at: TODAY_ROW_AT, capture_id: CAPTURE,
      }],
    });
    const res = await worker.fetch(api('/api/v1/export?month=2026-10&format=csv'), env());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('diary-2026-10-01_2026-10-31.csv');
    const text = await res.text();
    expect(text.split('\r\n')[0]).toBe('day,time,at,category,type,source,words,due,done,text');
    expect(text).toContain('"He said ""ship it"", then left."');
    expect(text).not.toContain(',raw');
  });

  it('writes markdown one day at a time', async () => {
    stub();
    const res = await worker.fetch(api('/api/v1/export?day=2026-10-15&format=md'), env());
    const text = await res.text();
    expect(text).toContain('## 15 October 2026');
    expect(text).toContain('- **21:41 · work**');
  });

  it('refuses a format it cannot write', async () => {
    stub();
    expect((await worker.fetch(api('/api/v1/export?format=pdf'), env())).status).toBe(400);
  });
});

// A key is no longer the whole diary: it carries a policy, and every read has to honour it.
describe('a key’s limits', () => {
  const NOTE_ID = '9f1c1a2b-0000-4000-8000-123456789abc';
  const workOnly = { categories: ['work'], from: null, to: null, text: 'clean' };
  const noteOn = (day: string, category = 'work') => ({
    id: 'note-1', day, category, category_source: 'tag', mode: 'refine',
    clean_text: 'Merged the release candidate.', raw_text: 'merged rc',
    created_at: `${day}T19:41:02Z`, capture_id: CAPTURE,
  });

  it('narrows a note read to the categories it was given, and refuses a reach past them', async () => {
    const { calls } = stub({ policy: workOnly });
    const asked = await worker.fetch(api('/api/v1/notes?month=2026-10'), env());
    expect(asked.status).toBe(200);
    expect(calls.find((c) => c.url.includes('/thoughts?'))!.url).toContain('category=in.(work)');

    // Silent narrowing would hide the misconfiguration, so the refusal names the category.
    const outside = await worker.fetch(api('/api/v1/notes?category=life'), env());
    expect(outside.status).toBe(403);
    expect(await outside.json()).toMatchObject({ error: { code: 'out_of_policy' } });
  });

  it('clamps the date window, and treats a note outside it as missing', async () => {
    const since = { categories: null, from: '2026-10-01', to: null, text: 'clean' };
    const { calls } = stub({ policy: since });
    expect((await worker.fetch(api('/api/v1/notes?month=2026-09'), env())).status).toBe(200);
    const query = calls.find((c) => c.url.includes('/thoughts?'))!.url;
    expect(query).toContain('day=gte.2026-10-01');
    // A month before the window is narrowed to nothing rather than refused: an empty answer.
    expect(query).toContain('day=lte.2026-09-30');

    // 404, never 403: the answer must not confirm that a note is there to want.
    stub({ policy: since, rows: [noteOn('2026-09-20')] });
    expect((await worker.fetch(api(`/api/v1/notes/${NOTE_ID}`), env())).status).toBe(404);
    stub({ policy: since, rows: [noteOn('2026-10-15')] });
    expect((await worker.fetch(api(`/api/v1/notes/${NOTE_ID}`), env())).status).toBe(200);
  });

  it('hides a deadline whose note is outside the limits', async () => {
    const reminder = {
      id: 'r1', capture_id: CAPTURE, thought_id: 'note-1', title: 'Proposal',
      due_at: '2026-11-03T09:00:00Z', status: 'pending', done_at: null, created_at: '2026-10-10T09:00:00Z',
    };
    // The reminder is on a work note; this key may only read life.
    stub({ policy: { categories: ['life'], from: null, to: null, text: 'clean' }, reminders: [reminder] });
    const body = (await (await worker.fetch(api('/api/v1/deadlines'), env())).json()) as { deadlines: unknown[] };
    expect(body.deadlines).toHaveLength(0);

    // One deadline answers 404 for the same reason a note does.
    stub({ policy: { categories: ['life'], from: null, to: null, text: 'clean' }, reminders: [reminder] });
    const one = await worker.fetch(api('/api/v1/deadlines/9f1c1a2b-0000-4000-8000-123456789abc'), env());
    expect(one.status).toBe(404);
  });

  it('drops the sentences from a counts-only key, and closes the ways around it', async () => {
    stub({ policy: { categories: null, from: null, to: null, text: 'none' } });
    const body = (await (await worker.fetch(api('/api/v1/notes'), env())).json()) as {
      notes: { text?: string; words: number }[];
    };
    expect(body.notes[0].text).toBeUndefined();
    expect(body.notes[0].words).toBe(4);
    expect((await worker.fetch(api('/api/v1/notes?fields=text'), env())).status).toBe(403);
    // A word search would rebuild the text one query at a time.
    expect((await worker.fetch(api('/api/v1/notes?q=release'), env())).status).toBe(403);
    expect((await worker.fetch(api('/api/v1/export?format=csv'), env())).status).toBe(403);
  });

  it('keeps the deadline but not the sentence behind it', async () => {
    const reminder = {
      id: 'r1', capture_id: CAPTURE, thought_id: 'note-1', title: 'Proposal',
      due_at: '2026-11-03T09:00:00Z', status: 'pending', done_at: null, created_at: '2026-10-10T09:00:00Z',
    };
    stub({ policy: { categories: null, from: null, to: null, text: 'none' }, reminders: [reminder] });
    const body = (await (await worker.fetch(api('/api/v1/deadlines'), env())).json()) as {
      deadlines: { note?: { id: string; day: string; text?: string } }[];
    };
    expect(body.deadlines[0].note).toEqual({ id: 'note-1', day: '2026-10-15' });
  });

  it('counts only the categories it may read, inside the window', async () => {
    const { calls } = stub({ policy: { categories: ['work'], from: '2026-10-01', to: null, text: 'clean' } });
    expect((await worker.fetch(api('/api/v1/stats?year=2026'), env())).status).toBe(200);
    const stat = calls.find((c) => c.url.includes('/rpc/diary_stats'))!;
    expect(stat.body).toMatchObject({ p_from: '2026-10-01', p_categories: ['work'] });

    expect((await worker.fetch(api('/api/v1/days?year=2026'), env())).status).toBe(200);
    const days = calls.find((c) => c.url.includes('/rpc/diary_days'))!;
    expect(days.body).toMatchObject({ p_from: '2026-10-01', p_categories: ['work'] });
  });

  it('tells the caller its own limits', async () => {
    stub({ policy: workOnly });
    const body = (await (await worker.fetch(api('/api/v1/me'), env())).json()) as { key: { policy: unknown } };
    expect(body.key.policy).toEqual(workOnly);
  });
});

describe('/api/keys', () => {
  async function signedIn(e = env()) {
    const res = await worker.fetch(new Request('https://diary.test/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: 'open sesame' }),
    }), e);
    return (res.headers.get('Set-Cookie') ?? '').split(';')[0];
  }

  function post(path: string, body: unknown, cookie: string, origin?: string) {
    return new Request(`https://diary.test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    });
  }

  it('needs the page session, not a key', async () => {
    stub();
    const e = env();
    expect((await worker.fetch(new Request('https://diary.test/api/keys'), e)).status).toBe(401);
    // A key is for reading the diary; it cannot mint another key.
    expect((await worker.fetch(api('/api/keys'), e)).status).toBe(401);
  });

  it('shows the key once and sends only its hash and prefix to the database', async () => {
    const e = env();
    const { calls } = stub();
    const cookie = await signedIn(e);
    const res = await worker.fetch(post('/api/keys', { name: 'Portfolio site', scopes: ['notes:read', 'raw:read'], expiresInDays: 90 }, cookie), e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; key: string; id: string; scopes: string[] };
    expect(body.key).toMatch(/^ddk_live_[A-Za-z0-9_-]{43}$/);
    expect(body.scopes).toEqual(['notes:read', 'raw:read']);
    const write = calls.find((c) => c.url.endsWith('/api_keys') && c.method === 'POST')!;
    // PostgREST takes an array of rows; the one row holds the hash, never the key.
    expect(write.body[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(write.body[0].prefix).toBe(body.key.slice(0, 16));
    // The secret itself never travels to the database, and the answer is never cached.
    expect(JSON.stringify(write.body)).not.toContain(body.key);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('stores the limits a new key was given', async () => {
    const e = env();
    const { calls } = stub();
    const cookie = await signedIn(e);
    const policy = { categories: ['work', 'learning'], from: '2026-01-01', to: null, text: 'none' };
    const res = await worker.fetch(post('/api/keys', {
      name: 'Habit tracker', scopes: ['notes:read', 'stats:read'], expiresInDays: 'never', policy,
    }, cookie), e);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { policy: unknown }).policy).toEqual(policy);
    const write = calls.find((c) => c.url.endsWith('/api_keys') && c.method === 'POST')!;
    expect(write.body[0].policy).toEqual(policy);
  });

  it('refuses limits it could not enforce', async () => {
    const e = env();
    const { calls } = stub();
    const cookie = await signedIn(e);
    const bad = [
      { categories: ['holiday'], from: null, to: null, text: 'clean' },
      { categories: [], from: null, to: null, text: 'clean' },
      { categories: null, from: '2026-02-31', to: null, text: 'clean' },
      { categories: null, from: '2026-10-01', to: '2026-09-01', text: 'clean' },
      { categories: null, from: null, to: null, text: 'all' },
    ];
    for (const policy of bad) {
      const res = await worker.fetch(post('/api/keys', { name: 'x', scopes: ['notes:read'], policy }, cookie), e);
      expect(res.status, JSON.stringify(policy)).toBe(400);
    }
    // Two answers to one question: counts only, but also the original text.
    const contradictory = await worker.fetch(post('/api/keys', {
      name: 'x', scopes: ['notes:read', 'raw:read'], policy: { categories: null, from: null, to: null, text: 'none' },
    }, cookie), e);
    expect(contradictory.status).toBe(400);
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api_keys'))).toHaveLength(0);
  });

  it('refuses a nameless key, no scopes, and raw text without notes', async () => {
    const e = env();
    stub();
    const cookie = await signedIn(e);
    expect((await worker.fetch(post('/api/keys', { scopes: ['notes:read'] }, cookie), e)).status).toBe(400);
    expect((await worker.fetch(post('/api/keys', { name: 'x', scopes: [] }, cookie), e)).status).toBe(400);
    expect((await worker.fetch(post('/api/keys', { name: 'x', scopes: ['raw:read'] }, cookie), e)).status).toBe(400);
  });

  it('refuses to mint a key for a page on another origin', async () => {
    const e = env();
    const { calls } = stub();
    const cookie = await signedIn(e);
    const res = await worker.fetch(post('/api/keys', { name: 'evil' }, cookie, 'https://evil.test'), e);
    expect(res.status).toBe(403);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('lists keys without their secret and revokes one', async () => {
    const e = env();
    const { calls } = stub();
    const cookie = await signedIn(e);
    const list = await worker.fetch(new Request('https://diary.test/api/keys', { headers: { Cookie: cookie } }), e);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { keys: { prefix: string; key?: string; policy: unknown }[] };
    expect(body.keys[0].key).toBeUndefined();
    expect(body.keys[0].prefix).toHaveLength(16);
    expect(body.keys[0].policy).toEqual({ categories: ['work'], from: null, to: null, text: 'clean' });

    // A made-up id is the caller's mistake, not a database failure.
    expect((await worker.fetch(post('/api/keys/abcdefgh/revoke', {}, cookie), e)).status).toBe(400);

    const res = await worker.fetch(post('/api/keys/9f1c1a2b-0000-4000-8000-123456789abc/revoke', {}, cookie), e);
    expect(res.status).toBe(200);
    const revoke = calls.find((c) => c.method === 'PATCH')!;
    expect(revoke.url).toContain('revoked_at=is.null');
    expect(typeof revoke.body.revoked_at).toBe('string');
  });
});

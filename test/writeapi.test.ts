import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { generateKey, hashKey, lookupPrefix } from '../src/apikey';

// The write half of the API. These tests go through the Worker — the route, the key, the
// capture, the thought, the receipt and the Telegram acknowledgement — rather than the module
// alone, because what matters is what a caller and the owner actually see. The database is a
// small in-memory stand-in for the two tables involved, so a retry can be tested as a retry.

const KEY = generateKey();
let keyHash = '';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noContent = () => new Response(null, { status: 204 });

// The day the diary would file a note today, in the diary's timezone.
const parisDay = (offset = 0): string => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

interface StubOpts {
  scopes?: string[];
  policy?: Record<string, unknown> | null;
  ai?: 'ok' | 'throws' | 'none';
  // The first capture insert reports no row although the row is there: what a second request
  // arriving at the same moment looks like from the losing side of the race.
  raceFirstCapture?: boolean;
  // The counter function itself fails, which is not the same as a key being over its limit.
  counterDown?: boolean;
  // What the note-weighted bump answers: over 300 in a day is a spent allowance.
  batch?: { minute_count: number; day_count: number };
}

function stub(opts: StubOpts = {}) {
  const calls: { url: string; method: string; body: any }[] = [];
  const captures: any[] = [];
  const thoughts: any[] = [];
  const reminders: any[] = [];
  const keyRow = {
    id: 'key-write',
    name: 'Demo for Agents',
    prefix: lookupPrefix(KEY),
    hash: keyHash,
    scopes: opts.scopes ?? ['notes:write'],
    policy: opts.policy ?? null,
    per_minute: 30,
    per_day: 300,
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
  };

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.includes('api.telegram.org')) return json({ ok: true });

    // --- the key ---
    const asked = /\/api_keys\?prefix=eq\.([^&]+)/.exec(url);
    if (asked) return json(asked[1] === lookupPrefix(KEY) ? [keyRow] : []);
    if (url.includes('/rpc/bump_api_usage')) {
      return opts.counterDown ? json({ message: 'counter down' }, 500) : json([{ minute_count: 1, day_count: 1 }]);
    }
    if (url.includes('/rpc/bump_api_notes')) {
      return opts.counterDown ? json({ message: 'counter down' }, 500) : json([opts.batch ?? { minute_count: 2, day_count: 2 }]);
    }

    // --- captures, as the two tables the write path touches ---
    if (method === 'GET' && url.includes('/captures?')) {
      const ids = (/source_update_id=in\.\(([^)]*)\)/.exec(url)?.[1] ?? '').split(',').map(Number);
      return json(captures
        .filter((c) => ids.includes(Number(c.source_update_id)))
        .map((c) => ({ id: c.id, source_update_id: c.source_update_id })));
    }
    if (method === 'POST' && url.includes('/captures?')) {
      const row = body[0];
      if (opts.raceFirstCapture && captures.length === 0) {
        captures.push({ id: 'cap-race', ...row });
        return json([]);
      }
      const id = `cap-${captures.length + 1}`;
      captures.push({ id, ...row });
      return json([{ id }]);
    }
    if (method === 'PATCH' && url.includes('/captures?')) return noContent();

    if (method === 'GET' && url.includes('/thoughts')) {
      const ids = (/capture_id=in\.\(([^)]*)\)/.exec(url)?.[1] ?? '').split(',');
      return json(thoughts.filter((t) => ids.includes(t.capture_id)).map((t) => ({
        id: t.id, capture_id: t.capture_id, day: t.day, category: t.category, mode: t.mode,
        clean_text: t.clean_text, created_at: t.created_at,
        tokens_in: t.tokens_in ?? null, tokens_out: t.tokens_out ?? null, cleanup_model: t.cleanup_model ?? null,
      })));
    }
    if (method === 'POST' && url.includes('/thoughts')) {
      // The adapter posts one object here, not an array: the capture insert is the batched one.
      const id = `thought-${thoughts.length + 1}`;
      thoughts.push({ id, created_at: new Date().toISOString(), ...(Array.isArray(body) ? body[0] : body) });
      return json([{ id }]);
    }
    if (method === 'POST' && url.includes('/reminders')) {
      reminders.push(body[0]);
      return json([], 201);
    }
    return json([]);
  }));

  return { calls, captures, thoughts, reminders };
}

const env = (ai: StubOpts['ai'] = 'none') => ({
  ASSETS: { fetch: async () => new Response('assets') },
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_KEY: 'service-key',
  TELEGRAM_BOT_TOKEN: 'bot',
  TELEGRAM_WEBHOOK_SECRET: 'hook',
  ALLOWED_CHAT_ID: '7',
  DIARY_TZ: 'Europe/Paris',
  DIARY_PASSPHRASE: 'open sesame',
  ...(ai === 'none' ? {} : {
    AI: {
      run: ai === 'ok'
        // Deliberately not a line that starts "Rewritten note": the real cleanup strips a model
        // that answers with a preamble, and the fixture must not be one.
        ? async () => ({ response: 'Merged the write API and ran its tests.', usage: { prompt_tokens: 120, completion_tokens: 30 } })
        : async () => { throw new Error('model retired'); },
    },
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

function post(body: unknown, init: RequestInit = {}): Request {
  return new Request('https://diary.test/api/v1/notes', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

const note = (over: Record<string, unknown> = {}) => ({ text: 'Shipped the write API.', category: 'work', ...over });

beforeEach(async () => { keyHash = await hashKey(KEY); });
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/v1/notes', () => {
  it('files a note as a capture and a thought, and answers with a receipt', async () => {
    const s = stub();
    const res = await worker.fetch(post({ client: 'claude-code', notes: [note()] }), env());
    expect(res.status).toBe(200);
    const answer = await res.json() as any;

    expect(answer.receipt.notes).toHaveLength(1);
    expect(answer.receipt.notes[0]).toMatchObject({ status: 'stored', category: 'work', day: parisDay(), words: 4 });
    expect(answer.receipt.counts).toMatchObject({ notes: 1, byCategory: { work: 1 } });
    expect(answer.receipt.duplicate).toBe(false);
    expect(answer.receipt.code).toMatch(/^rc_[0-9a-f]{6}$/);

    // The row is the same shape the bot writes, plus where it came from.
    expect(s.captures[0]).toMatchObject({ source: 'api', client: 'claude-code', status: 'received' });
    expect(s.thoughts[0]).toMatchObject({
      category: 'work', category_source: 'tag', mode: 'refine',
      clean_text: 'Shipped the write API.', raw_text: 'Shipped the write API.', day: parisDay(),
    });
    // No model bound in this env, and the note is stored as written rather than not at all.
    expect(answer.receipt.notes[0].cleanup).toBe('unavailable');
  });

  it('confirms on Telegram with the receipt the caller was given', async () => {
    const s = stub();
    const res = await worker.fetch(post({ client: 'claude-code', notes: [note()] }), env());
    const answer = await res.json() as any;
    expect(answer.receipt.telegram).toBe('sent');
    expect(answer.receipt.preview).toBe('Shipped the write API.');

    const sent = s.calls.find((c) => c.url.includes('api.telegram.org'));
    expect(sent?.body.chat_id).toBe(7);
    expect(sent?.body.text).toContain('Claude Code filed 1 note');
    expect(sent?.body.text).toContain(answer.receipt.code);
  });

  it('stores nothing twice when the same Idempotency-Key is retried', async () => {
    const s = stub();
    const first = await worker.fetch(post({ notes: [note()] }, { headers: { 'Idempotency-Key': 'session-1' } }), env());
    const one = await first.json() as any;
    const again = await worker.fetch(post({ notes: [note()] }, { headers: { 'Idempotency-Key': 'session-1' } }), env());
    const two = await again.json() as any;

    expect(s.captures).toHaveLength(1);
    expect(s.thoughts).toHaveLength(1);
    expect(two.receipt.duplicate).toBe(true);
    expect(two.receipt.notes[0].status).toBe('duplicate');
    expect(two.receipt.code).toBe(one.receipt.code);
    // Silent: the owner has seen that message already.
    expect(two.receipt.telegram).toBe('skipped');
    expect(s.calls.filter((c) => c.url.includes('api.telegram.org'))).toHaveLength(1);
  });

  it('files each note of a batch on its own capture, so a retry skips only what landed', async () => {
    const s = stub();
    await worker.fetch(post({ notes: [note(), note({ text: 'Two.', category: 'project' })] }, { headers: { 'Idempotency-Key': 'batch-1' } }), env());
    expect(s.captures).toHaveLength(2);
    expect(s.captures[0].source_update_id).not.toBe(s.captures[1].source_update_id);
    // The second request fixes one note and resends both.
    const retry = await worker.fetch(post({ notes: [note(), note({ text: 'Two, corrected.', category: 'project' })] }, { headers: { 'Idempotency-Key': 'batch-1' } }), env());
    const answer = await retry.json() as any;
    expect(s.captures).toHaveLength(2);
    expect(answer.receipt.notes.map((n: any) => n.status)).toEqual(['duplicate', 'duplicate']);
  });

  it('names the note that lost a race instead of leaving it out of the receipt', async () => {
    // Two requests with the same key arriving together: this one's insert finds the row already
    // there and gets no id back. The note is in the diary, so the receipt has to say so.
    const s = stub({ raceFirstCapture: true });
    const res = await worker.fetch(post({ notes: [note()] }, { headers: { 'Idempotency-Key': 'race-1' } }), env());
    expect(res.status).toBe(200);
    const answer = await res.json() as any;
    expect(answer.receipt.notes[0]).toMatchObject({ status: 'duplicate', id: 'cap-race', day: parisDay() });
    expect(answer.receipt.counts.notes).toBe(0);
    expect(answer.receipt.duplicate).toBe(true);
    expect(answer.receipt.telegram).toBe('skipped');
    expect(s.captures).toHaveLength(1);
  });

  it('refuses a key without the write scope, and writes nothing', async () => {
    const s = stub({ scopes: ['notes:read'] });
    const res = await worker.fetch(post({ notes: [note()] }), env());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(s.captures).toHaveLength(0);
  });

  it('refuses a note outside the limits its key carries, and writes nothing', async () => {
    const s = stub({ policy: { categories: ['work'], from: null, to: null, text: 'clean' } });
    const res = await worker.fetch(post({ notes: [note({ category: 'life' })] }), env());
    expect(res.status).toBe(403);
    const answer = await res.json() as any;
    expect(answer.error.code).toBe('out_of_policy');
    expect(answer.error.message).toContain('limited to work');
    expect(s.captures).toHaveLength(0);
  });

  it('refuses a window it may not write into', async () => {
    stub({ policy: { categories: null, from: parisDay(2), to: null, text: 'clean' } });
    const res = await worker.fetch(post({ notes: [note()] }), env());
    expect(res.status).toBe(403);
    expect((await res.json() as any).error.code).toBe('out_of_policy');
  });

  it('holds the batch to its ceiling', async () => {
    stub();
    const many = Array.from({ length: 26 }, (_, i) => note({ text: `Note ${i}.` }));
    const res = await worker.fetch(post({ notes: many }), env());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'too_many' } });
  });

  it('refuses a note longer than a note may be', async () => {
    stub();
    const res = await worker.fetch(post({ notes: [note({ text: 'x'.repeat(4001) })] }), env());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'too_many' } });
  });

  it('refuses an unknown category, mode or date before anything is written', async () => {
    const s = stub();
    for (const bad of [{ category: 'nonsense' }, { mode: 'polish' }, { day: '2026-02-30' }]) {
      const res = await worker.fetch(post({ notes: [note(bad)] }), env());
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'bad_note' } });
    }
    expect(s.captures).toHaveLength(0);
  });

  it('refuses a day and a moment that disagree', async () => {
    stub();
    const res = await worker.fetch(post({ notes: [note({ day: '2001-01-05' })] }), env());
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.message).toContain('disagree');
  });

  it('wants a due date on a deadline, and sets the ping the composer would', async () => {
    const s = stub();
    const missing = await worker.fetch(post({ notes: [note({ category: 'deadline' })] }), env());
    expect(missing.status).toBe(400);
    expect((await missing.json() as any).error.message).toContain('due date');

    const due = parisDay(10);
    const res = await worker.fetch(post({ notes: [note({ category: 'deadline', due })] }), env());
    const answer = await res.json() as any;
    expect(res.status).toBe(200);
    expect(s.reminders).toHaveLength(1);
    expect(s.reminders[0]).toMatchObject({ kind: 'deadline', source: 'explicit', due_at: `${due}T09:00:00.000Z` });
    expect(answer.receipt.reminders[0]).toMatchObject({ due, set: true });
  });

  it('runs the cleanup and records what it cost', async () => {
    const s = stub({ ai: 'ok' });
    const res = await worker.fetch(post({ notes: [note({ mode: 'refine' })] }), env('ok'));
    const answer = await res.json() as any;
    expect(answer.receipt.notes[0].cleanup).toBe('formatted');
    expect(s.thoughts[0]).toMatchObject({
      clean_text: 'Merged the write API and ran its tests.', raw_text: 'Shipped the write API.',
      tokens_in: 120, tokens_out: 30, cleanup_model: expect.stringContaining('@cf/'),
    });
    expect(answer.receipt.usage).toMatchObject({ tokensIn: 120, tokensOut: 30 });
  });

  it('keeps the note when the cleanup fails, and says which part failed', async () => {
    const s = stub({ ai: 'throws' });
    const res = await worker.fetch(post({ notes: [note()] }), env('throws'));
    const answer = await res.json() as any;
    expect(res.status).toBe(200);
    expect(answer.receipt.notes[0]).toMatchObject({ status: 'stored', cleanup: 'failed' });
    expect(answer.receipt.notes[0].error).toContain('model retired');
    expect(s.thoughts[0].clean_text).toBe('Shipped the write API.');
  });

  it('keeps verbatim as written and never asks a model', async () => {
    const s = stub({ ai: 'ok' });
    const res = await worker.fetch(post({ notes: [note({ mode: 'verbatim' })] }), env('ok'));
    const answer = await res.json() as any;
    expect(answer.receipt.notes[0].cleanup).toBe('verbatim');
    expect(s.thoughts[0].clean_text).toBe('Shipped the write API.');
    expect(s.thoughts[0].cleanup_model).toBeNull();
  });

  it('cannot be silenced by the caller: an old ack field does nothing', async () => {
    // A stolen key used to be able to write without the one message that says it did, so the
    // request no longer owns that decision. The note still lands, and the phone still hears.
    const s = stub();
    const res = await worker.fetch(post({ notes: [note()], ack: false }), env());
    const answer = await res.json() as any;
    expect(answer.receipt.telegram).toBe('sent');
    expect(s.calls.filter((c) => c.url.includes('api.telegram.org'))).toHaveLength(1);
    expect(s.captures).toHaveLength(1);
    // A field that is neither truthy nor false is still a mistake worth naming.
    const bad = await worker.fetch(post({ notes: [note()], ack: 'no' }), env());
    expect(bad.status).toBe(400);
  });

  it('spends the key’s allowance once per note, not once per request', async () => {
    // Three notes are three model calls, so they cost three of the day's 300, not one.
    const s = stub();
    const res = await worker.fetch(post({ notes: [note(), note({ text: 'Two.' }), note({ text: 'Three.' })] }), env());
    expect(res.status).toBe(200);
    const bump = s.calls.filter((c) => c.url.includes('/rpc/bump_api_notes'));
    expect(bump).toHaveLength(1);
    expect(bump[0].body).toEqual({ k: 'key-write', extra: 2 });
  });

  it('refuses a batch that would spend more of the day than is left', async () => {
    stub({ batch: { minute_count: 4, day_count: 301 } });
    const res = await worker.fetch(post({ notes: [note(), note({ text: 'Two.' })] }), env());
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });

  it('files nothing when the counter cannot answer', async () => {
    // Reads survive a counter hiccup because they cost nothing. A write spends money and sends
    // a message, so it is refused rather than filed uncounted.
    const s = stub({ counterDown: true });
    const res = await worker.fetch(post({ notes: [note()] }), env());
    expect(res.status).toBe(503);
    expect(s.captures).toHaveLength(0);
  });

  it('needs a key like every other endpoint', async () => {
    stub();
    const res = await worker.fetch(new Request('https://diary.test/api/v1/notes', {
      method: 'POST', body: JSON.stringify({ notes: [note()] }), headers: { 'Content-Type': 'application/json' },
    }), env());
    expect(res.status).toBe(401);
  });

  it('refuses a read key nothing was asked of, and a body that is not a request', async () => {
    stub();
    const res = await worker.fetch(post({ notes: [] }), env());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_note' } });
  });
});

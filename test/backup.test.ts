import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { backupFileName, exportDue, staleSnapshot, weekKey } from '../src/backup';

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

const request = (path: string, init: RequestInit = {}) => new Request(`https://diary.test${path}`, init);
const cookieFrom = (res: Response) => (res.headers.get('Set-Cookie') ?? '').split(';')[0];

const SNAPSHOT = {
  id: 7,
  taken_at: '2026-10-26T03:00:04.000Z',
  reason: 'scheduled',
  counts: { thoughts: 8, captures: 8, reminders: 0, archived_notes: 23 },
  payload: { thoughts: [], captures: [], reminders: [], archived_notes: [] },
};

// One stub for both the database and Telegram: the export step talks to both, and what matters
// is which URLs were called and whether the marker was written.
const stub = (opts: { missing?: boolean; takenAt?: string; payload?: unknown } = {}) => {
  const settings = new Map<string, string>();
  const calls: string[] = [];
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('api.telegram.org')) return new Response(JSON.stringify({ ok: true }));
    if (url.includes('/diary_backups')) {
      if (opts.missing) return new Response('{"code":"PGRST205"}', { status: 404 });
      return new Response(JSON.stringify([{ ...SNAPSHOT, taken_at: opts.takenAt ?? SNAPSHOT.taken_at, payload: opts.payload ?? SNAPSHOT.payload }]));
    }
    if (init?.method === 'POST' && url.includes('/rpc/diary_backup')) return new Response('8');
    if (init?.method === 'POST' && url.includes('/settings')) {
      const body = JSON.parse(String(init.body ?? '{}')) as { key?: string; value?: string };
      if (body.key) settings.set(body.key, body.value ?? '');
      return new Response('[]');
    }
    const setting = /\/settings\?key=eq\.([a-z_]+)/.exec(url);
    if (setting) {
      const saved = settings.get(setting[1]);
      return new Response(JSON.stringify(saved === undefined ? [] : [{ value: saved }]));
    }
    return new Response('[]');
  });
  vi.stubGlobal('fetch', fake);
  return { calls, settings };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('when the copy leaves', () => {
  it('names the ISO week', () => {
    expect(weekKey('2026-10-26')).toBe('2026-W44');
    expect(weekKey('2026-11-02')).toBe('2026-W45');
    // A week that straddles new year keeps its ISO year on both sides.
    expect(weekKey('2026-12-31')).toBe('2026-W53');
    expect(weekKey('2027-01-01')).toBe('2026-W53');
  });

  it('is due once a week, until that week\'s copy has left', () => {
    expect(exportDue(new Date('2026-10-26T06:45:00Z'), 'UTC', null)).toBe(true);
    expect(exportDue(new Date('2026-10-30T06:45:00Z'), 'UTC', null)).toBe(true);
    expect(exportDue(new Date('2026-10-26T06:45:00Z'), 'UTC', '2026-W44')).toBe(false);
    // The week after is a new copy, whatever day the run lands on.
    expect(exportDue(new Date('2026-11-02T06:45:00Z'), 'UTC', '2026-W44')).toBe(true);
  });

  it('reads the week on the diary clock, not the Worker clock', () => {
    // 2026-10-25 23:30 UTC is already Monday in Paris, and still Sunday everywhere else.
    expect(exportDue(new Date('2026-10-25T23:30:00Z'), 'Europe/Paris', null)).toBe(true);
    expect(exportDue(new Date('2026-10-25T23:30:00Z'), 'Europe/Paris', '2026-W44')).toBe(false);
  });

  it('calls a snapshot from before this week stale, and one from this morning fresh', () => {
    const now = new Date('2026-10-26T06:45:00Z');
    expect(staleSnapshot('2026-10-26T03:00:04.000Z', now)).toBe(false);
    expect(staleSnapshot('2026-10-25T03:00:04.000Z', now)).toBe(true);
    expect(staleSnapshot('not a date', now)).toBe(true);
  });

  it('names the file after the day it was taken', () => {
    expect(backupFileName('2026-10-26')).toBe('ink-backup-2026-10-26.json');
  });
});

describe('/api/backup', () => {
  const signIn = async () => {
    const res = await worker.fetch(request('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: 'open sesame' }),
    }), env());
    return cookieFrom(res);
  };

  it('needs the session, and answers 401 without it', async () => {
    const s = stub();
    const res = await worker.fetch(request('/api/backup'), env());
    expect(res.status).toBe(401);
    expect(s.calls.filter((u) => u.includes('/diary_backups'))).toHaveLength(0);
  });

  it('reports the last snapshot with its counts', async () => {
    stub();
    const cookie = await signIn();
    const res = await worker.fetch(request('/api/backup', { headers: { Cookie: cookie } }), env());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true, available: true,
      backup: { id: 7, at: SNAPSHOT.taken_at, reason: 'scheduled', counts: SNAPSHOT.counts },
    });
  });

  it('takes one now, then reports it', async () => {
    const s = stub();
    const cookie = await signIn();
    const res = await worker.fetch(request('/api/backup', { method: 'POST', headers: { Cookie: cookie } }), env());
    expect(res.status).toBe(200);
    expect((await res.json() as { backup: { id: number } }).backup.id).toBe(7);
    expect(s.calls.some((u) => u.includes('/rpc/diary_backup'))).toBe(true);
  });

  it('says backups are not set up when the table is missing, without failing the page', async () => {
    stub({ missing: true });
    const cookie = await signIn();
    const res = await worker.fetch(request('/api/backup', { headers: { Cookie: cookie } }), env());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, available: false, backup: null });
  });
});

describe('the weekly copy leaving the database', () => {
  it('sends the Monday snapshot as a document and remembers the day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T06:45:00Z'));
    const s = stub();

    await worker.scheduled(undefined, env());

    const sent = s.calls.filter((u) => u.includes('sendDocument'));
    expect(sent).toHaveLength(1);
    expect(s.settings.get('backup_export')).toBe('2026-W44');
    // It is the snapshot the database took, not a new one: the upload costs no extra write.
    expect(s.calls.some((u) => u.includes('/rpc/diary_backup'))).toBe(false);
  });

  it('stays quiet on the day\'s later runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T06:45:00Z'));
    const s = stub();
    await worker.scheduled(undefined, env());
    vi.setSystemTime(new Date('2026-10-26T15:00:00Z'));
    await worker.scheduled(undefined, env());
    expect(s.calls.filter((u) => u.includes('sendDocument'))).toHaveLength(1);
  });

  it('does nothing again in the same week', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T06:45:00Z'));
    const s = stub();
    await worker.scheduled(undefined, env());
    expect(s.calls.filter((u) => u.includes('sendDocument'))).toHaveLength(1);
    vi.setSystemTime(new Date('2026-10-30T20:00:00Z'));
    await worker.scheduled(undefined, env());
    expect(s.calls.filter((u) => u.includes('sendDocument'))).toHaveLength(1);
  });

  it('takes a fresh snapshot instead of sending last week\'s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T06:45:00Z'));
    const s = stub({ takenAt: '2026-10-19T03:00:04.000Z' });
    await worker.scheduled(undefined, env());
    expect(s.calls.some((u) => u.includes('/rpc/diary_backup'))).toBe(true);
    expect(s.calls.filter((u) => u.includes('sendDocument'))).toHaveLength(1);
  });
});

import { handleUpdate, type TelegramUpdate, type Store, type Notifier } from './handler';
import { groupByDay, type DeadlineMark, type ThoughtRow } from './api';
import { BACKUP_MODEL, BIG_MODEL, SMALL_MODEL, readOutput, workersAiRefiner, type AiRunner } from './refine';
import {
  SESSION_COOKIE, clearedCookie, issueSession, readCookie, sameSecret, sessionCookie, sessionValid,
} from './session';

export interface Env {
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID: string;
  DIARY_TZ: string; // IANA timezone, e.g. "Asia/Kolkata"
  DIARY_PASSPHRASE?: string;     // secret: the one password that opens the diary page
  DIARY_SESSION_SECRET?: string; // secret: signs cookies; defaults to the passphrase
  AI?: AiRunner;                 // Workers AI binding, wired up in wrangler.toml
}

// Supabase REST adapter (service key stays server-side in Worker secrets).
function supabaseStore(env: Env): Store {
  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  const check = async (res: Response) => {
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    return res;
  };
  return {
    async insertCapture(c) {
      const res = await check(await fetch(`${base}/captures?on_conflict=source,source_update_id`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify([{
          source: 'telegram', source_update_id: c.update_id, source_chat_id: c.chat_id,
          kind: 'text', raw_text: c.raw_text, command_mode: c.mode, command_category: c.category, status: c.status,
        }]),
      }));
      const rows = (await res.json()) as { id: string }[];
      return rows.length ? { inserted: true, id: rows[0].id } : { inserted: false };
    },
    async insertThought(t) {
      await check(await fetch(`${base}/thoughts`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(t),
      }));
    },
    async getTimeZone() {
      const res = await check(await fetch(`${base}/settings?key=eq.timezone&select=value`, { headers }));
      const rows = (await res.json()) as { value: string }[];
      return rows[0]?.value ?? null;
    },
    async setTimeZone(zone) {
      await check(await fetch(`${base}/settings?on_conflict=key`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'timezone', value: zone, updated_at: new Date().toISOString() }),
      }));
    },
    async setCaptureStatus(id, status, error) {
      await check(await fetch(`${base}/captures?id=eq.${id}`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ status, last_error: error ?? null }),
      }));
    },
    async insertReminder(r) {
      await check(await fetch(`${base}/reminders`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify([{
          capture_id: r.captureId, thought_id: r.thoughtId, kind: r.kind,
          title: r.title, due_at: r.dueAt, next_remind_at: r.nextRemindAt,
          status: 'pending', source: r.source,
        }]),
      }));
    },
    async listDueReminders(nowIso) {
      const res = await check(await fetch(
        `${base}/reminders?status=eq.pending&next_remind_at=lte.${encodeURIComponent(nowIso)}&select=id,kind,title,due_at,snooze_count&order=next_remind_at.asc&limit=50`,
        { headers },
      ));
      return (await res.json()) as { id: string; kind: string; title: string; due_at: string | null; snooze_count?: number }[];
    },
    async markReminderDone(id) {
      await check(await fetch(`${base}/reminders?id=eq.${id}`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'done', done_at: new Date().toISOString() }),
      }));
    },
    async snoozeReminder(id, nextIso) {
      await check(await fetch(`${base}/reminders?id=eq.${id}`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ next_remind_at: nextIso, snooze_count: 1 }),
      }));
    },
    async health(day) {
      // Exact counts come back in the content-range header, so one row is enough.
      const countOf = async (query: string) => {
        const res = await check(await fetch(`${base}/${query}`, {
          headers: { ...headers, Prefer: 'count=exact' },
        }));
        const total = Number((res.headers.get('content-range') ?? '').split('/')[1]);
        return Number.isFinite(total) ? total : 0;
      };
      const captures = await countOf('captures?select=id&limit=1');
      const thoughts = await countOf('thoughts?select=id&limit=1');
      const todayThoughts = await countOf(`thoughts?day=eq.${day}&select=id&limit=1`);
      const pendingReminders = await countOf('reminders?status=eq.pending&select=id&limit=1');
      const lastRes = await check(await fetch(`${base}/captures?select=received_at&order=received_at.desc&limit=1`, { headers }));
      const lastRows = (await lastRes.json()) as { received_at: string }[];
      // The heartbeat is the write half of the check: a readable database can still
      // reject inserts, and this table exists for exactly that signal.
      await check(await fetch(`${base}/heartbeats`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify([{ note: 'test' }]),
      }));
      return {
        captures, thoughts, todayThoughts, pendingReminders,
        lastCaptureAt: lastRows[0]?.received_at ?? null, heartbeatOk: true,
      };
    },
  };
}

// Telegram Bot API adapter.
function telegramNotifier(env: Env): Notifier {
  const send = async (payload: Record<string, unknown>) => {
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error('telegram reply failed', err);
    }
  };
  return {
    async reply(chatId, text) {
      await send({ chat_id: chatId, text });
    },
    async remind(chatId, reminderId, text) {
      await send({
        chat_id: chatId,
        text,
        reply_markup: { inline_keyboard: [[{ text: 'Done', callback_data: `done:${reminderId}` }]] },
      });
    },
  };
}

async function answerCallback(env: Env, id: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: id, text }),
    });
  } catch (err) {
    console.error('callback answer failed', err);
  }
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

// Everything the cookie signature needs. Defaulting to the passphrase keeps setup to
// one secret; DIARY_SESSION_SECRET only matters if the passphrase is ever rotated and
// you want existing sessions to survive (or die) on a separate schedule.
function sessionSecret(env: Env): string | null {
  return env.DIARY_SESSION_SECRET || env.DIARY_PASSPHRASE || null;
}

async function signedIn(request: Request, env: Env): Promise<boolean> {
  // No passphrase on the Worker means no gate: this is a one-person diary and the owner
  // asked to read it without signing in. Setting DIARY_PASSPHRASE closes it again.
  if (!env.DIARY_PASSPHRASE) return true;
  // If Cloudflare Access is ever enabled, it authenticates visitors before the Worker
  // and stamps this header. The cookie covers the case where Access is not set up.
  if (request.headers.get('Cf-Access-Jwt-Assertion')) return true;
  const secret = sessionSecret(env);
  if (!secret) return false;
  return sessionValid(readCookie(request, SESSION_COOKIE), secret, new Date());
}

// POST /api/session { passphrase } -> sets the signed cookie.
async function signIn(request: Request, env: Env): Promise<Response> {
  if (!env.DIARY_PASSPHRASE) {
    return json({ ok: false, error: 'No passphrase is set on the Worker. Add the DIARY_PASSPHRASE secret.' }, 503);
  }
  let body: { passphrase?: unknown };
  try {
    body = (await request.json()) as { passphrase?: unknown };
  } catch {
    return json({ ok: false, error: 'Send JSON: { "passphrase": "..." }' }, 400);
  }
  const given = typeof body.passphrase === 'string' ? body.passphrase : '';
  if (!sameSecret(given, env.DIARY_PASSPHRASE)) {
    // A short pause makes guessing over the network expensive without needing storage.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return json({ ok: false, error: 'That passphrase is not right.' }, 401);
  }
  const token = await issueSession(sessionSecret(env)!, new Date());
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}

// GET /api/ai-check: one tiny inference per cleanup model. A cleanup that fails can be a
// missing binding, a retired model id or an account that cannot use Workers AI, and only
// the error tells them apart. It answers that with no test note written to the diary.
async function aiCheck(request: Request, env: Env): Promise<Response> {
  if (!(await signedIn(request, env))) return json({ ok: false, need: 'login' }, 401);
  if (!env.AI) {
    return json({ ok: false, binding: false, error: 'No AI binding on this Worker.' }, 503);
  }
  const models: { model: string; ok: boolean; ms: number; output?: string | null; error?: string }[] = [];
  for (const model of [SMALL_MODEL, BIG_MODEL, BACKUP_MODEL]) {
    const started = Date.now();
    try {
      const out = await env.AI.run(model, {
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 8,
      });
      models.push({ model, ok: true, ms: Date.now() - started, output: readOutput(out) });
    } catch (err) {
      models.push({ model, ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const ok = models.some((m) => m.ok);
  return json({ ok, binding: true, models }, ok ? 200 : 502);
}

// POST /api/reclean: runs the cleanup again over notes an earlier model left untouched.
// Those rows have clean_text === raw_text, so they have no Raw control and nothing to
// read: this is the one-time repair, not part of saving a note. The raw text is never
// modified, so a bad rewrite is recoverable. Guarded by the webhook secret because it
// spends AI credits and runs unattended.
async function reclean(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('x-reclean-token') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: 'Send the Telegram webhook secret as x-reclean-token.' }, 401);
  }
  if (!env.AI) return json({ ok: false, error: 'No AI binding on this Worker.' }, 503);
  const refiner = workersAiRefiner(env.AI);
  const limit = Math.min(Number(new URL(request.url).searchParams.get('limit') ?? 25) || 25, 50);
  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  const rowsRes = await fetch(
    `${base}/thoughts?mode=neq.verbatim&select=id,mode,category,clean_text,raw_text&order=created_at.desc&limit=200`,
    { headers },
  );
  if (!rowsRes.ok) return json({ ok: false, error: `Supabase ${rowsRes.status}: ${await rowsRes.text()}` }, 502);
  const rows = (await rowsRes.json()) as ThoughtRow[];
  const untouched = rows.filter((r) => (r.raw_text ?? '').trim() !== '' && (r.clean_text ?? '') === (r.raw_text ?? '')).slice(0, limit);
  let cleaned = 0;
  const failed: string[] = [];
  for (const r of untouched) {
    try {
      const out = await refiner.refine({ text: r.raw_text!, mode: r.mode as 'refine' | 'reason' | 'think', category: r.category });
      if (!out || out === r.clean_text) continue;
      const patch = await fetch(`${base}/thoughts?id=eq.${r.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ clean_text: out }),
      });
      if (!patch.ok) throw new Error(`Supabase ${patch.status}: ${await patch.text()}`);
      cleaned++;
    } catch (err) {
      failed.push(`${r.id}: ${err instanceof Error ? err.message.split('\n')[0].slice(0, 160) : 'unknown error'}`);
    }
  }
  return json({ ok: true, untouched: untouched.length, cleaned, skipped: untouched.length - cleaned - failed.length, failed });
}

// Read API for the web interface. Without a signed-in session (or Cloudflare Access,
// if it is ever enabled) the API would hand the whole diary to anyone who learns the
// workers.dev URL, so it answers 401 and the page asks for the passphrase.
async function entriesApi(request: Request, env: Env): Promise<Response> {
  if (!(await signedIn(request, env))) {
    return json({ ok: false, need: 'login', error: 'Sign in to read your diary.' }, 401);
  }

  const url = new URL(request.url);
  const tz = env.DIARY_TZ || 'UTC';
  const isDay = (v: string | null): v is string => v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const today = new Date().toISOString().slice(0, 10);
  const from = isDay(url.searchParams.get('from')) ? url.searchParams.get('from')! : '2020-01-01';
  const to = isDay(url.searchParams.get('to')) ? url.searchParams.get('to')! : today;

  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  try {
    const [thoughtsRes, remindersRes] = await Promise.all([
      fetch(`${base}/thoughts?day=gte.${from}&day=lte.${to}&select=id,day,category,category_source,mode,clean_text,raw_text,created_at,capture_id&order=day.asc&limit=1000`, { headers }),
      fetch(`${base}/reminders?select=capture_id,kind,title,due_at,next_remind_at,status&order=next_remind_at.asc&limit=200`, { headers }),
    ]);
    if (!thoughtsRes.ok) {
      return json({ ok: false, error: `Supabase ${thoughtsRes.status}: ${await thoughtsRes.text()}` }, 502);
    }
    const rows = (await thoughtsRes.json()) as ThoughtRow[];
    type ReminderRow = { capture_id: string | null; kind: string; title: string; due_at: string | null; next_remind_at: string; status: string };
    const allReminders = remindersRes.ok ? (await remindersRes.json()) as ReminderRow[] : [];
    // Deadlines ride along with the note that created them, so the page can show a due badge.
    const deadlines: Record<string, DeadlineMark> = {};
    for (const r of allReminders) {
      if (!r.capture_id) continue;
      deadlines[r.capture_id] = { due: r.due_at ? r.due_at.slice(0, 10) : null, done: r.status === 'done' };
    }
    const reminders = allReminders.filter((r) => r.status === 'pending');
    return json({ ok: true, timeZone: tz, today, total: rows.length, days: groupByDay(rows, tz, deadlines), reminders });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, 502);
  }
}

async function webhook(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }
  const update = (await request.json()) as TelegramUpdate & {
    callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
  };
  const store = supabaseStore(env);
  const notifier = telegramNotifier(env);
  const ownerId = Number(env.ALLOWED_CHAT_ID);
  const chatId = update.callback_query ? update.callback_query.message?.chat.id : update.message?.chat.id;
  try {
    // Done button: done:<reminderId>
    if (update.callback_query) {
      const q = update.callback_query;
      const chatId = q.message?.chat.id;
      if (chatId !== Number(env.ALLOWED_CHAT_ID)) return new Response('ok');
      if (q.data?.startsWith('done:')) {
        const rid = q.data.slice(5);
        if (store.markReminderDone) await store.markReminderDone(rid);
        await answerCallback(env, q.id, 'Marked done. No more pings.');
      } else {
        await answerCallback(env, q.id, 'OK');
      }
      return new Response('ok');
    }
    await handleUpdate(update, store, notifier, {
      allowedChatId: Number(env.ALLOWED_CHAT_ID),
      timeZone: env.DIARY_TZ || 'UTC',
    }, new Date(), env.AI ? workersAiRefiner(env.AI) : undefined);
    return new Response('ok');
  } catch (err) {
    // Tell the owner instead of failing silently. Answering 200 stops Telegram from
    // retrying the same update every few minutes for a day, which would turn one
    // failure into dozens of identical error messages.
    console.error('update failed', err);
    const reason = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'unknown error';
    if (chatId !== ownerId) return new Response('retry', { status: 500 });
    await notifier.reply(ownerId, `Something failed. ${reason}`);
    return new Response('ok');
  }
}

async function runDue(env: Env): Promise<void> {
  const store = supabaseStore(env);
  const notifier = telegramNotifier(env);
  const chatId = Number(env.ALLOWED_CHAT_ID);
  if (!store.listDueReminders) return;
  const due = await store.listDueReminders(new Date().toISOString());
  for (const r of due) {
    const label = r.kind === 'deadline' ? 'Deadline' : 'Review';
    const dueTxt = r.due_at ? ` (due ${r.due_at.slice(0, 10)})` : '';
    if (notifier.remind) await notifier.remind(chatId, r.id, `${label}${dueTxt}: ${r.title}`);
    else await notifier.reply(chatId, `${label}${dueTxt}: ${r.title}`);
    // Reschedule: deadlines daily until due+1d, reviews max 2 pings then done.
    if (r.kind === 'deadline' && r.due_at && new Date(r.due_at).getTime() > Date.now() && store.snoozeReminder) {
      const next = new Date(Date.now() + 86400000).toISOString();
      await store.snoozeReminder(r.id, next);
    } else if (r.kind === 'review' && (r.snooze_count ?? 0) < 1 && store.snoozeReminder) {
      const next = new Date(Date.now() + 2 * 86400000).toISOString();
      await store.snoozeReminder(r.id, next);
    } else if (store.markReminderDone) {
      await store.markReminderDone(r.id);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/telegram/webhook' && request.method === 'POST') return webhook(request, env);
    if (url.pathname === '/api/session') {
      if (request.method === 'POST') return signIn(request, env);
      if (request.method === 'DELETE') return json({ ok: true }, 200, { 'Set-Cookie': clearedCookie() });
    }
    if (url.pathname === '/api/entries' && request.method === 'GET') return entriesApi(request, env);
    if (url.pathname === '/api/ai-check' && request.method === 'GET') return aiCheck(request, env);
    if (url.pathname === '/api/reclean' && request.method === 'POST') return reclean(request, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await runDue(env);
  },
};

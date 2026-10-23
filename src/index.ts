import { handleUpdate, type TelegramUpdate, type Store, type Notifier } from './handler';
import { groupByDay, type ThoughtRow } from './api';

export interface Env {
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID: string;
  DIARY_TZ: string; // IANA timezone, e.g. "Asia/Kolkata"
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Read API for the web interface. Cloudflare Access sits in front of the site and
// adds this header once a request is authenticated; without it the API would hand
// the whole diary to anyone who learns the workers.dev URL.
async function entriesApi(request: Request, env: Env): Promise<Response> {
  if (!request.headers.get('Cf-Access-Jwt-Assertion')) {
    return json({ ok: false, error: 'Not signed in. This page sits behind Cloudflare Access.' }, 401);
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
      fetch(`${base}/thoughts?day=gte.${from}&day=lte.${to}&select=id,day,category,category_source,mode,clean_text,raw_text,created_at&order=day.asc&limit=1000`, { headers }),
      fetch(`${base}/reminders?status=eq.pending&select=id,kind,title,due_at,next_remind_at&order=next_remind_at.asc&limit=20`, { headers }),
    ]);
    if (!thoughtsRes.ok) {
      return json({ ok: false, error: `Supabase ${thoughtsRes.status}: ${await thoughtsRes.text()}` }, 502);
    }
    const rows = (await thoughtsRes.json()) as ThoughtRow[];
    const reminders = remindersRes.ok ? await remindersRes.json() : [];
    return json({ ok: true, timeZone: tz, today, total: rows.length, days: groupByDay(rows, tz), reminders });
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
    });
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
    if (url.pathname === '/api/entries' && request.method === 'GET') return entriesApi(request, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await runDue(env);
  },
};

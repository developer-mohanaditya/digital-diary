import {
  handleUpdate, localDay, type HealthStats, type TelegramUpdate, type Store, type Notifier, type RepairResult, type ThoughtInput,
} from './handler';
import type { Category, Mode } from './parse';
import { MAX_INPUT_CHARS, cleanNote, type CleanupKind } from './refine';
import { UI_CATEGORIES, groupByDay, type DeadlineMark, type NoteOrigin, type ThoughtRow } from './api';
import { BACKUP_MODEL, BIG_MODEL, SMALL_MODEL, readOutput, workersAiRefiner, type AiRunner } from './refine';
import { reminderTimes } from './reminders';
import {
  SESSION_COOKIE, clearedCookie, issueSession, readCookie, sameSecret, sessionCookie, sessionValid,
} from './session';
import { PASSPHRASE_KEY, hashPassphrase, passphraseProblem, verifyPassphrase } from './auth';
import { hourIn, summaryDue, summaryMessage, type SummaryNote } from './summary';
import { beatMessage, beatSlot } from './heartbeat';
import { backupCaption, failedMessage, reminderMessage, stripHtml } from './receipts';
import { backupFileName, exportDue, staleSnapshot, weekKey, type Backup } from './backup';
import { keepTyping } from './typing';
import { createApiKey, isRowId, listApiKeys, normalisePolicy, publicApi, revokeApiKey } from './publicapi';
import { expiryFrom, keyNameProblem, normaliseScopes } from './apikey';

export interface Env {
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID: string;
  DIARY_TZ: string; // IANA timezone, e.g. "Asia/Kolkata"
  DIARY_PASSPHRASE?: string;     // secret: seeds the passphrase, and keeps the page closed
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
  // One row in heartbeats, from either writer: the /heartbeat command, and the three
  // keep-alive beats a day the cron makes.
  const postHeartbeat = (note: string) => fetch(`${base}/heartbeats`, {
    method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify([{ note }]),
  });
  return {
    async insertCapture(c) {
      const write = (body: Record<string, unknown>) => fetch(`${base}/captures?on_conflict=source,source_update_id`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify([body]),
      });
      const row = {
        source: c.source ?? 'telegram', source_update_id: c.update_id, source_chat_id: c.chat_id,
        kind: 'text', raw_text: c.raw_text, command_mode: c.mode, command_category: c.category,
        status: c.status, client: c.client ?? null, dedupe_key: c.dedupeKey ?? null,
      };
      let res = await write(row);
      // client and dedupe_key arrive with 0009, and a deploy can reach production before the
      // migration does. The note still lands exactly once — idempotency rides source_update_id,
      // which is older than both — so only the readable key is lost.
      if (res.status === 400) {
        const { client: _client, dedupe_key: _key, ...bare } = row;
        res = await write(bare);
      }
      await check(res);
      const rows = (await res.json()) as { id: string }[];
      return rows.length ? { inserted: true, id: rows[0].id } : { inserted: false };
    },
    async insertThought(t) {
      const write = (body: ThoughtInput) => fetch(`${base}/thoughts`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(body),
      });
      let res = await write(t);
      // The usage columns arrive with 0006 and the cleanup's duration with 0012; a deploy can
      // reach production before either migration does. The note matters more than what it cost,
      // so a 400 retries without them — the fallback the web paths already take.
      if (res.status === 400) {
        const { tokens_in: _in, tokens_out: _out, cleanup_model: _model, cleanup_ms: _ms, ...bare } = t;
        res = await write(bare);
      }
      await check(res);
    },
    // The write API's two reads. findCaptures is how a retried request finds the captures the
    // first one made: the id is derived from the caller's Idempotency-Key, so the same request
    // asks the same question. writtenNotes reads back rows that API just wrote, which is what
    // its receipt and the owner's Telegram message are built from — never anything else.
    async findCaptures(source, sourceUpdateIds) {
      if (!sourceUpdateIds.length) return [];
      const res = await check(await fetch(
        `${base}/captures?source=eq.${source}&source_update_id=in.(${sourceUpdateIds.join(',')})` +
          `&select=id,source_update_id&limit=${sourceUpdateIds.length}`,
        { headers },
      ));
      const rows = (await res.json()) as { id: string; source_update_id: number }[];
      return rows.map((r) => ({ id: r.id, sourceUpdateId: Number(r.source_update_id) }));
    },
    async writtenNotes(captureIds) {
      if (!captureIds.length) return [];
      const read = (select: string) => fetch(
        `${base}/thoughts?capture_id=in.(${captureIds.join(',')})&select=${select}&order=created_at.asc`,
        { headers },
      );
      let res = await read('id,capture_id,day,category,mode,clean_text,created_at,tokens_in,tokens_out,cleanup_model');
      // Same reason as the page's read: the usage columns arrive with 0006, and a receipt is not
      // worth failing over what a cleanup cost.
      if (res.status === 400) res = await read('id,capture_id,day,category,mode,clean_text,created_at');
      await check(res);
      const rows = (await res.json()) as {
        id: string; capture_id: string; day: string; category: string; mode: string;
        clean_text: string; created_at: string;
        tokens_in?: number | null; tokens_out?: number | null; cleanup_model?: string | null;
      }[];
      return rows.map((r) => ({
        id: r.id, captureId: r.capture_id, day: r.day, category: r.category, mode: r.mode,
        text: r.clean_text, at: r.created_at,
        tokensIn: r.tokens_in ?? null, tokensOut: r.tokens_out ?? null, model: r.cleanup_model ?? null,
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
    async health(day, note = 'test') {
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
      await check(await postHeartbeat(note));
      return {
        captures, thoughts, todayThoughts, pendingReminders,
        lastCaptureAt: lastRows[0]?.received_at ?? null, heartbeatOk: true,
      };
    },
    async beat(note) {
      await check(await postHeartbeat(note));
    },
    async dayNotes(day) {
      const res = await check(await fetch(
        `${base}/thoughts?day=eq.${day}&select=category,clean_text,created_at&order=created_at.asc&limit=200`,
        { headers },
      ));
      const rows = (await res.json()) as { category: string; clean_text: string; created_at: string }[];
      return rows.map((r) => ({ category: r.category as SummaryNote['category'], text: r.clean_text, at: r.created_at }));
    },
    async openReminders(limit) {
      const res = await check(await fetch(
        `${base}/reminders?status=eq.pending&select=kind,title,due_at&order=next_remind_at.asc&limit=${limit}`,
        { headers },
      ));
      const rows = (await res.json()) as { kind: string; title: string; due_at: string | null }[];
      return rows.map((r) => ({ kind: r.kind, title: r.title, dueAt: r.due_at }));
    },
    async summarySentOn() {
      const res = await check(await fetch(`${base}/settings?key=eq.daily_summary&select=value`, { headers }));
      const rows = (await res.json()) as { value: string }[];
      return rows[0]?.value ?? null;
    },
    async markSummarySent(day) {
      await check(await fetch(`${base}/settings?on_conflict=key`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'daily_summary', value: day, updated_at: new Date().toISOString() }),
      }));
    },
    // Which keep-alive slot has already been beaten. Read on every cron run, written only when a
    // row is made, so the second run in the same slot — the twin entry an hour out — can see that
    // its beat is already there.
    async heartbeatMark() {
      const res = await check(await fetch(`${base}/settings?key=eq.heartbeat&select=value`, { headers }));
      const rows = (await res.json()) as { value: string }[];
      return rows[0]?.value ?? null;
    },
    async markHeartbeat(slot) {
      await check(await fetch(`${base}/settings?on_conflict=key`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'heartbeat', value: slot, updated_at: new Date().toISOString() }),
      }));
    },
    // The snapshots 0013 takes. A database without that migration answers 404 for the table,
    // which is a fact for Settings to show ("not set up yet"), not an error to throw.
    async latestBackup() {
      const res = await fetch(
        `${base}/diary_backups?select=id,taken_at,reason,counts,payload&order=taken_at.desc,id.desc&limit=1`,
        { headers },
      );
      if (res.status === 404) return { available: false, backup: null };
      await check(res);
      const rows = (await res.json()) as Backup[];
      return { available: true, backup: rows[0] ?? null };
    },
    async takeBackup(reason) {
      await check(await fetch(`${base}/rpc/diary_backup`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_reason: reason }),
      }));
    },
    // Which week's copy already left. Same marker rule as the summary: written only after the
    // document is sent, so a failure is retried by the next run rather than lost.
    async backupExportedOn() {
      const res = await check(await fetch(`${base}/settings?key=eq.backup_export&select=value`, { headers }));
      const rows = (await res.json()) as { value: string }[];
      return rows[0]?.value ?? null;
    },
    async markBackupExported(week) {
      await check(await fetch(`${base}/settings?on_conflict=key`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'backup_export', value: week, updated_at: new Date().toISOString() }),
      }));
    },
  };
}

// Telegram Bot API adapter. The boolean is what the write API's receipt reports, so a message
// that never went out is said out loud rather than assumed: the notes are stored either way.
async function sendTelegram(env: Env, payload: Record<string, unknown>): Promise<boolean> {
  const post = (body: Record<string, unknown>) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    let res = await post(payload);
    // Telegram refuses the whole message when the markup is wrong, and a receipt that never
    // arrives is worse than one without its bold: send it again with the tags taken off.
    if (res.status === 400 && payload.parse_mode) {
      const { parse_mode: _mode, ...rest } = payload;
      console.error('telegram rejected the markup, retrying as plain text');
      res = await post({ ...rest, text: stripHtml(String(payload.text ?? '')) });
    }
    if (!res.ok) {
      console.error('telegram send failed', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('telegram send failed', err);
    return false;
  }
}

// The weekly snapshot leaving the database. Telegram is the carrier because it is the one place
// the owner already reads and the one place a copy can live outside the project it protects; the
// boolean is what keeps the marker unwritten when the upload fails, so the next run tries again.
async function sendDocument(env: Env, chatId: number, name: string, body: string, caption: string): Promise<boolean> {
  try {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', caption);
    form.set('parse_mode', 'HTML');
    form.set('document', new Blob([body], { type: 'application/json' }), name);
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
      method: 'POST', body: form,
    });
    if (!res.ok) {
      console.error('telegram document failed', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('telegram document failed', err);
    return false;
  }
}

function telegramNotifier(env: Env): Notifier {
  return {
    async reply(chatId, text) {
      await sendTelegram(env, { chat_id: chatId, text, parse_mode: 'HTML' });
    },
    async remind(chatId, reminderId, text) {
      await sendTelegram(env, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: 'Done', callback_data: `done:${reminderId}` }]] },
      });
    },
    // The chat action behind "typing…". Best effort by design: the pacer in src/typing.ts
    // swallows whatever this throws, because a note must never fail over a chat action.
    async typing(chatId) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
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

// The passphrase Settings saved, or null when it has never been changed from the page. Throws
// when the database cannot answer, which every caller turns into a refusal: an unreadable lock
// must not open.
async function readPassphrase(env: Env): Promise<string | null> {
  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  const res = await fetch(`${base}/settings?key=eq.${PASSPHRASE_KEY}&select=value`, { headers });
  if (!res.ok) {
    const text = await res.text();
    // A settings table that was never created (migration 0002 not run) must not lock the owner
    // out: no row means no saved passphrase, and the env secret is still the passphrase.
    if (res.status === 404 || /PGRST205|42P01/.test(text)) {
      console.warn('settings table missing: run migrations/0002_settings.sql; using DIARY_PASSPHRASE');
      return null;
    }
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  const rows = (await res.json()) as { value: string }[];
  return rows[0]?.value ?? null;
}

async function writePassphrase(env: Env, hash: string): Promise<void> {
  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  const res = await fetch(`${base}/settings?on_conflict=key`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: PASSPHRASE_KEY, value: hash, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

// Everything the cookie signature needs. Until Settings saves a passphrase the env secret signs
// the cookie, as it always did; afterwards the stored hash does, so changing the passphrase
// signs every other device out. DIARY_SESSION_SECRET overrides both and keeps sessions across a
// change.
function sessionSecret(env: Env, stored: string | null): string | null {
  return env.DIARY_SESSION_SECRET || stored || env.DIARY_PASSPHRASE || null;
}

// The gate is on when either place holds a passphrase. With neither, this is a one-person diary
// and the owner reads it without signing in.
function gateOn(env: Env, stored: string | null): boolean {
  return Boolean(stored || env.DIARY_PASSPHRASE);
}

function cookieOk(request: Request, secret: string): Promise<boolean> {
  return sessionValid(readCookie(request, SESSION_COOKIE), secret, new Date());
}

async function signedIn(request: Request, env: Env): Promise<boolean> {
  let stored: string | null;
  try {
    stored = await readPassphrase(env);
  } catch {
    return false;
  }
  if (!gateOn(env, stored)) return true;
  // The signed cookie is the only thing that opens the diary. A header that merely has to be
  // present is not a credential: anyone on the internet can send Cf-Access-Jwt-Assertion, and
  // while it was trusted here a one-line curl read the whole diary and minted itself a key.
  // Cloudflare Access, if it is ever switched on, is an extra gate in front of this one.
  const secret = sessionSecret(env, stored);
  if (!secret) return false;
  return cookieOk(request, secret);
}

// Does the typed value open this diary? A saved passphrase wins over the env secret, so the two
// can never both be right and disagree.
async function passphraseMatches(env: Env, stored: string | null, given: string): Promise<boolean> {
  if (stored) return verifyPassphrase(given, stored);
  return env.DIARY_PASSPHRASE ? sameSecret(given, env.DIARY_PASSPHRASE) : false;
}

// A short pause makes guessing over the network expensive without needing storage.
const wrongGuessPause = () => new Promise((resolve) => setTimeout(resolve, 400));

// POST /api/session { passphrase } -> sets the signed cookie.
async function signIn(request: Request, env: Env): Promise<Response> {
  let stored: string | null;
  try {
    stored = await readPassphrase(env);
  } catch (err) {
    console.error('passphrase read failed', err);
    return json({ ok: false, error: 'Could not read the lock. Try again.' }, 502);
  }
  const secret = sessionSecret(env, stored);
  if (!secret) {
    return json({ ok: false, error: 'No passphrase is set on the Worker. Add the DIARY_PASSPHRASE secret.' }, 503);
  }
  let body: { passphrase?: unknown };
  try {
    body = (await request.json()) as { passphrase?: unknown };
  } catch {
    return json({ ok: false, error: 'Send JSON: { "passphrase": "..." }' }, 400);
  }
  const given = typeof body.passphrase === 'string' ? body.passphrase : '';
  if (!(await passphraseMatches(env, stored, given))) {
    await wrongGuessPause();
    return json({ ok: false, error: 'That passphrase is not right.' }, 401);
  }
  const token = await issueSession(secret, new Date());
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}

// POST /api/passphrase { current, next }: change the diary's passphrase from Settings. This is
// the one credential the Worker can change, so the page no longer needs the Cloudflare dashboard
// for it — though the dashboard is still the way back in once you cannot sign in at all.
async function passphraseApi(request: Request, env: Env): Promise<Response> {
  let stored: string | null;
  try {
    stored = await readPassphrase(env);
  } catch (err) {
    console.error('passphrase read failed', err);
    return json({ ok: false, error: 'Could not read the lock. Try again.' }, 502);
  }
  const secret = sessionSecret(env, stored);
  if (!secret) {
    return json({ ok: false, error: 'The page has no passphrase yet. Set DIARY_PASSPHRASE on the Worker first.' }, 409);
  }
  if (!(await cookieOk(request, secret))) {
    return json({ ok: false, need: 'login', error: 'Sign in to change the passphrase.' }, 401);
  }
  let body: { current?: unknown; next?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'Send JSON: { "current": "...", "next": "..." }' }, 400);
  }
  const current = typeof body.current === 'string' ? body.current : '';
  const next = typeof body.next === 'string' ? body.next.trim() : '';
  if (!(await passphraseMatches(env, stored, current))) {
    await wrongGuessPause();
    return json({ ok: false, error: 'That is not the current passphrase.' }, 403);
  }
  const problem = passphraseProblem(next, current);
  if (problem) return json({ ok: false, error: problem }, 400);
  const hash = await hashPassphrase(next);
  try {
    await writePassphrase(env, hash);
  } catch (err) {
    console.error('passphrase write failed', err);
    return json({ ok: false, error: 'Could not save the new passphrase. Nothing changed.' }, 502);
  }
  // The cookie is signed with the new hash, so every other device is locked out and this one
  // gets a fresh 30-day cookie in the same answer, instead of being signed out by its own change.
  const token = await issueSession(sessionSecret(env, hash)!, new Date());
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

// Runs the cleanup again over notes an earlier model left untouched: those rows have
// clean_text === raw_text, so they have no Raw control and nothing to read. This is the
// repair path for history, not part of saving a note. Only clean_text is ever written,
// so a bad rewrite is always recoverable from raw_text.
async function repairUntouched(env: Env, limit: number): Promise<RepairResult> {
  if (!env.AI) throw new Error('No AI binding on this Worker.');
  const refiner = workersAiRefiner(env.AI);
  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  const rowsRes = await fetch(
    `${base}/thoughts?mode=neq.verbatim&select=id,mode,category,clean_text,raw_text&order=created_at.desc&limit=200`,
    { headers },
  );
  if (!rowsRes.ok) throw new Error(`Supabase ${rowsRes.status}: ${await rowsRes.text()}`);
  const rows = (await rowsRes.json()) as ThoughtRow[];
  const untouched = rows
    .filter((r) => (r.raw_text ?? '').trim() !== '' && (r.clean_text ?? '') === (r.raw_text ?? ''))
    .slice(0, limit);
  let cleaned = 0;
  const failed: string[] = [];
  for (const r of untouched) {
    try {
      const started = Date.now();
      const out = await refiner.refine({ text: r.raw_text!, mode: r.mode as 'refine' | 'reason' | 'think', category: r.category });
      if (!out || out.text === r.clean_text) continue;
      // The repair spends neurons too, and keeps the owner waiting, so it records both on the
      // row it rewrote.
      const send = (body: Record<string, unknown>) => fetch(`${base}/thoughts?id=eq.${r.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(body),
      });
      let patch = await send({
        clean_text: out.text,
        tokens_in: out.tokensIn,
        tokens_out: out.tokensOut,
        cleanup_model: out.model,
        cleanup_ms: Date.now() - started,
      });
      // The rewrite matters more than its cost, so a missing 0006 or 0012 costs the counters, not
      // the repair.
      if (patch.status === 400) patch = await send({ clean_text: out.text });
      if (!patch.ok) throw new Error(`Supabase ${patch.status}: ${await patch.text()}`);
      cleaned++;
    } catch (err) {
      failed.push(`${r.id}: ${err instanceof Error ? err.message.split('\n')[0].slice(0, 160) : 'unknown error'}`);
    }
  }
  return { scanned: untouched.length, cleaned, failed };
}

// POST /api/reclean: the same repair, for a machine. Guarded, because it spends AI
// neurons and rewrites derived text: either the Telegram webhook secret or the database
// service key is accepted as the bearer, since both are already Worker secrets and a
// leak of either is worse than this route.
async function reclean(request: Request, env: Env): Promise<Response> {
  const given = request.headers.get('x-reclean-token') ?? '';
  const accepted = [env.TELEGRAM_WEBHOOK_SECRET, env.SUPABASE_SERVICE_KEY].filter((v): v is string => Boolean(v));
  if (!given || !accepted.some((candidate) => sameSecret(given, candidate))) {
    return json({ ok: false, error: 'Send an accepted secret as x-reclean-token.' }, 401);
  }
  const asked = Number(new URL(request.url).searchParams.get('limit') ?? 5);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 25) : 5;
  try {
    return json({ ok: true, ...(await repairUntouched(env, limit)) });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, 502);
  }
}

// Read API for the web interface. Without a signed-in session the API would hand the whole
// diary to anyone who learns the URL, so it answers 401 and the page asks for the passphrase.
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
  // The usage columns arrive with migration 0006. Asking for a column that does not exist
  // yet is a 400 from PostgREST, and that would blank the diary page for everyone between a
  // deploy and the migration being run, so the read falls back to the older column set.
  const readThoughts = async (select: string) =>
    fetch(`${base}/thoughts?day=gte.${from}&day=lte.${to}&select=${select}&order=day.asc&limit=1000`, { headers });
  // The capture rides along as an embed, because the capture is where a note's origin lives —
  // the door it came through and, for an API note, the app that filed it. One request, and the
  // row already carries the id it joins on. It needs captures.client (0009): on an older
  // database the whole read answers 400, so the plain column set is the fallback, and then a
  // note simply has no origin to show.
  const withUsage = 'id,day,category,category_source,mode,clean_text,raw_text,created_at,capture_id,tokens_in,tokens_out,cleanup_model,cleanup_ms,captures(source,client)';
  const withoutUsage = 'id,day,category,category_source,mode,clean_text,raw_text,created_at,capture_id';
  try {
    const [thoughtsRes, remindersRes] = await Promise.all([
      (async () => {
        const first = await readThoughts(withUsage);
        return first.status === 400 ? readThoughts(withoutUsage) : first;
      })(),
      fetch(`${base}/reminders?select=capture_id,kind,title,due_at,next_remind_at,status,done_at&order=next_remind_at.asc&limit=200`, { headers }),
    ]);
    if (!thoughtsRes.ok) {
      return json({ ok: false, error: `Supabase ${thoughtsRes.status}: ${await thoughtsRes.text()}` }, 502);
    }
    const rows = (await thoughtsRes.json()) as ThoughtRow[];
    // Keyed by capture, so a note picks up its origin the way it picks up its deadline.
    const origins: Record<string, NoteOrigin> = {};
    for (const row of rows) {
      const capture = row.captures;
      if (row.capture_id && capture && typeof capture.source === 'string') {
        origins[row.capture_id] = { source: capture.source, client: capture.client ?? null };
      }
    }
    type ReminderRow = { capture_id: string | null; kind: string; title: string; due_at: string | null; next_remind_at: string; status: string; done_at: string | null };
    const allReminders = remindersRes.ok ? (await remindersRes.json()) as ReminderRow[] : [];
    // Deadlines ride along with the note that created them, so the page can show a due badge.
    const deadlines: Record<string, DeadlineMark> = {};
    for (const r of allReminders) {
      if (!r.capture_id) continue;
      deadlines[r.capture_id] = { due: r.due_at ? r.due_at.slice(0, 10) : null, done: r.status === 'done', doneAt: r.done_at };
    }
    const reminders = allReminders.filter((r) => r.status === 'pending');
    return json({ ok: true, timeZone: tz, today, total: rows.length, days: groupByDay(rows, tz, deadlines, origins), reminders });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, 502);
  }
}

// What the page reports after a save, so the message under the box is about the note it
// just typed rather than a generic "saved".
type NoteCleanup = CleanupKind;

// POST /api/note: a note typed on the page. It takes the same path as a Telegram message
// — storage, cleanup, then the result — so a note added here is the same kind of row as
// one sent to the bot. Before this existed the page only pushed the note into browser
// memory: it showed "Refined" without asking a model, and was gone on the next load.
async function noteApi(request: Request, env: Env): Promise<Response> {
  if (!(await signedIn(request, env))) {
    return json({ ok: false, need: 'login', error: 'Sign in to add a note.' }, 401);
  }
  let body: { text?: unknown; mode?: unknown; category?: unknown; due?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'Send JSON: { "text": "..." }' }, 400);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return json({ ok: false, error: 'The note is empty.' }, 400);
  if (text.length > MAX_INPUT_CHARS) {
    return json({ ok: false, error: `That is longer than ${MAX_INPUT_CHARS} characters. Split it into two notes.` }, 400);
  }
  const mode: Mode =
    body.mode === 'verbatim' || body.mode === 'reason' || body.mode === 'think' ? body.mode : 'refine';
  const picked = typeof body.category === 'string' ? body.category : '';
  const chosen = (UI_CATEGORIES as readonly string[]).includes(picked) ? picked : null;
  const category = (chosen ?? 'inbox') as Category;

  // The model runs before the insert so one request answers what was stored, but a
  // failure only changes the wording: the raw text is saved either way. The step itself is
  // the same one the write API takes, so the two doors cannot disagree about what
  // "formatted" or "failed" means.
  const cleaned = await cleanNote(env.AI ? workersAiRefiner(env.AI) : undefined, { text, mode, category });
  if (cleaned.error) console.error('refine failed', cleaned.error);
  const clean = cleaned.clean;
  const cleanup: NoteCleanup = cleaned.cleanup;
  // Reassigned below when a deadline's reminder fails: the note is stored either way, and the
  // message under the box has to say which part did not happen.
  let refineError = cleaned.error;
  const usage = { tokensIn: cleaned.tokensIn, tokensOut: cleaned.tokensOut, model: cleaned.model, ms: cleaned.ms };

  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  const now = new Date();
  const tz = env.DIARY_TZ || 'UTC';
  try {
    // source_update_id is only unique per source, so the timestamp cannot collide with a
    // Telegram update id; the random tail covers two notes in the same millisecond.
    const updateId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const captureRes = await fetch(`${base}/captures?on_conflict=source,source_update_id`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify([{
        source: 'web',
        source_update_id: updateId,
        source_chat_id: 0,
        kind: 'text',
        raw_text: text,
        command_mode: mode,
        command_category: chosen,
        status: 'received',
      }]),
    });
    if (!captureRes.ok) {
      return json({ ok: false, error: `Supabase ${captureRes.status}: ${await captureRes.text()}` }, 502);
    }
    const captureRows = (await captureRes.json()) as { id: string }[];
    if (!captureRows.length) return json({ ok: false, error: 'The note was not stored.' }, 502);
    const captureId = captureRows[0].id;
    // The capture is the row every door writes first. Telegram and the write API advance it from
    // received to done once the note exists; this door left it at received for ever, which made
    // any "unprocessed" question a lie. Best effort: the note is what matters, and a status that
    // cannot be written must not turn a saved note into a failed request.
    const advanceCapture = (status: 'done' | 'failed', error?: string) => fetch(
      `${base}/captures?id=eq.${captureId}`,
      {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(error ? { status, last_error: error } : { status }),
      },
    ).catch(() => null);

    const row = {
      capture_id: captureId,
      day: localDay(now, tz),
      captured_at: now.toISOString(),
      category,
      category_source: chosen ? 'tag' : 'auto',
      mode,
      clean_text: clean,
      raw_text: text,
    };
    const writeThought = (body: Record<string, unknown>) => fetch(`${base}/thoughts`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify([body]),
    });
    let thoughtRes = await writeThought({
      ...row,
      tokens_in: usage.tokensIn,
      tokens_out: usage.tokensOut,
      cleanup_model: usage.model,
      cleanup_ms: usage.ms,
    });
    // Same reason as the read above: a deploy can reach production before the migration
    // does, and a note that was captured must still be stored.
    if (thoughtRes.status === 400) thoughtRes = await writeThought(row);
    if (!thoughtRes.ok) {
      await advanceCapture('failed', 'the note could not be stored');
      return json({ ok: false, error: `Supabase ${thoughtRes.status}: ${await thoughtRes.text()}` }, 502);
    }
    const thoughtRows = (await thoughtRes.json()) as { id: string }[];
    const thoughtId = thoughtRows[0]?.id ?? null;
    await advanceCapture('done');

    // A deadline picked here gets the same reminder the bot would create: first ping three
    // days before the due date, then daily until it is marked done.
    const due = typeof body.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.due) ? body.due : null;
    if (category === 'deadline' && due) {
      const { dueAt, next } = reminderTimes(due, now);
      const reminderRes = await fetch(`${base}/reminders`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify([{
          capture_id: captureId,
          thought_id: thoughtId,
          kind: 'deadline',
          title: clean.slice(0, 140),
          due_at: dueAt.toISOString(),
          next_remind_at: next.toISOString(),
          status: 'pending',
          source: 'explicit',
        }]),
      });
      // The note is already stored; a reminder that failed is reported without losing it.
      if (!reminderRes.ok) refineError ??= `reminder not created (Supabase ${reminderRes.status})`;
    }

    return json({ ok: true, id: thoughtId, mode, category, cleanup, error: refineError });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, 502);
  }
}

// When a deadline's reminder should first fire, and the same rule the write API uses: see
// reminderTimes in ./reminders.

// POST /api/note/move { id, category, due? } -> files the row under another category. The move
// is the row itself, not a change that is forgotten on the next load. A move
// to Deadline schedules the same reminder the composer would, and a move away closes the one
// that was pinging, so the note and the thing that reminds you cannot disagree.
async function moveApi(request: Request, env: Env): Promise<Response> {
  if (!(await signedIn(request, env))) {
    return json({ ok: false, need: 'login', error: 'Sign in to move a note.' }, 401);
  }
  let body: { id?: unknown; category?: unknown; due?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'Send JSON: { "id": "...", "category": "..." }' }, 400);
  }
  const id = typeof body.id === 'string' ? body.id : '';
  // The id goes into a query string and must be a row id, not something that changes the query.
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    return json({ ok: false, error: 'That note id is not one this diary issued.' }, 400);
  }
  const asked = typeof body.category === 'string' ? body.category : '';
  if (!(UI_CATEGORIES as readonly string[]).includes(asked)) {
    return json({ ok: false, error: 'Pick one of the diary categories.' }, 400);
  }
  const category = asked as Category;
  const due = typeof body.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.due) ? body.due : null;
  if (category === 'deadline' && !due) {
    return json({ ok: false, error: 'A deadline needs a due date. Pick one and try again.' }, 400);
  }

  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  const now = new Date();
  try {
    const patch = await fetch(`${base}/thoughts?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({ category, category_source: 'manual' }),
    });
    if (!patch.ok) {
      return json({ ok: false, error: `Supabase ${patch.status}: ${await patch.text()}` }, 502);
    }
    const rows = (await patch.json()) as { id: string; capture_id: string | null; clean_text?: string }[];
    if (!rows.length) return json({ ok: false, error: 'No note with that id.' }, 404);
    const row = rows[0];

    let reminder: 'set' | 'moved' | 'closed' | 'none' = 'none';
    const pendingUrl = `${base}/reminders?thought_id=eq.${id}&status=eq.pending`;
    if (category === 'deadline' && due) {
      const { dueAt, next } = reminderTimes(due, now);
      const existing = await fetch(`${pendingUrl}&select=id`, { headers });
      const open = existing.ok ? (await existing.json()) as { id: string }[] : [];
      if (open.length) {
        // The note already had a reminder (moved out of Deadline and back, say): reschedule it
        // instead of stacking a second ping on the same note.
        const res = await fetch(`${base}/reminders?id=eq.${open[0].id}`, {
          method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ due_at: dueAt.toISOString(), next_remind_at: next.toISOString() }),
        });
        reminder = res.ok ? 'moved' : 'none';
      } else if (row.capture_id) {
        const res = await fetch(`${base}/reminders`, {
          method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify([{
            capture_id: row.capture_id,
            thought_id: row.id,
            kind: 'deadline',
            title: (row.clean_text ?? 'Deadline').slice(0, 140),
            due_at: dueAt.toISOString(),
            next_remind_at: next.toISOString(),
            status: 'pending',
            source: 'explicit',
          }]),
        });
        reminder = res.ok ? 'set' : 'none';
      }
      // No capture to hang a reminder on: the move still happened, and the answer says the
      // reminder did not.
    } else {
      // No longer a deadline, so the due badge and the ping go with it. Deleted rather than
      // marked done: a closed reminder would still be attached to the note and would keep
      // drawing a due date on a Life entry.
      const res = await fetch(`${base}/reminders?thought_id=eq.${id}`, {
        method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' },
      });
      reminder = res.ok ? 'closed' : 'none';
    }
    return json({ ok: true, id: row.id, category, due, reminder });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, 502);
  }
}

// POST /api/reminder/done { id, done } -> closes the deadline on a note, or reopens it. The
// page used to only report this state, because the Telegram Done button owned the write; a
// diary that can file and move a note but not finish one is half a diary. The reminder is
// found through the note's capture, which is how both the bot and the composer attach it.
// Reopening pushes the next ping a day out, so reopening a mistake does not page you at once.
async function reminderDoneApi(request: Request, env: Env): Promise<Response> {
  if (!(await signedIn(request, env))) {
    return json({ ok: false, need: 'login', error: 'Sign in to change a deadline.' }, 401);
  }
  let body: { id?: unknown; done?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'Send JSON: { "id": "...", "done": true }' }, 400);
  }
  const id = typeof body.id === 'string' ? body.id : '';
  // The id goes into a query string, so it has to be a row id and not a query.
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    return json({ ok: false, error: 'That note id is not one this diary issued.' }, 400);
  }
  if (typeof body.done !== 'boolean') {
    return json({ ok: false, error: 'Say whether the deadline is done.' }, 400);
  }
  const done = body.done;

  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  try {
    const rowRes = await fetch(`${base}/thoughts?id=eq.${id}&select=capture_id`, { headers });
    if (!rowRes.ok) throw new Error(`Supabase ${rowRes.status}: ${await rowRes.text()}`);
    const rows = (await rowRes.json()) as { capture_id: string | null }[];
    const captureId = rows[0]?.capture_id;
    if (!captureId) return json({ ok: false, error: 'There is no deadline on this note.' }, 404);

    const findRes = await fetch(`${base}/reminders?capture_id=eq.${captureId}&kind=eq.deadline&select=id&limit=1`, { headers });
    if (!findRes.ok) throw new Error(`Supabase ${findRes.status}: ${await findRes.text()}`);
    const found = (await findRes.json()) as { id: string }[];
    if (!found.length) return json({ ok: false, error: 'There is no deadline on this note.' }, 404);

    const now = new Date();
    const patch = done
      ? { status: 'done', done_at: now.toISOString() }
      : { status: 'pending', done_at: null, next_remind_at: new Date(now.getTime() + 86400000).toISOString() };
    const res = await fetch(`${base}/reminders?id=eq.${found[0].id}`, {
      method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    return json({ ok: true, id, done });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, 502);
  }
}

// The host a browser stamped an Origin with, or an empty string when it is not a URL at all —
// which then fails the comparison and is refused, rather than throwing.
function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}

// Key management for Settings. These answer to the page's session, not to a key: a key can
// only read the diary, never mint or revoke another key. POST also refuses a foreign Origin,
// because minting a credential is heavier than changing a preference and the cookie is enough
// to do it.
async function keysApi(request: Request, env: Env): Promise<Response> {
  if (!(await signedIn(request, env))) {
    return json({ ok: false, need: 'login', error: 'Sign in to manage API keys.' }, 401);
  }
  const path = new URL(request.url).pathname;
  try {
    if (request.method === 'GET' && path === '/api/keys') {
      return json({ ok: true, keys: await listApiKeys(env) });
    }
    const origin = request.headers.get('Origin');
    if (origin && originHost(origin) !== new URL(request.url).host) {
      return json({ ok: false, error: 'That request came from another site.' }, 403);
    }
    if (request.method === 'POST' && path === '/api/keys') {
      const body = (await request.json().catch(() => null)) as
        { name?: unknown; scopes?: unknown; expiresInDays?: unknown; policy?: unknown } | null;
      if (!body) return json({ ok: false, error: 'Send JSON: { "name": "...", "scopes": [...] }' }, 400);
      const nameProblem = keyNameProblem(body.name);
      if (nameProblem) return json({ ok: false, error: nameProblem }, 400);
      const scopes = normaliseScopes(body.scopes);
      if ('error' in scopes) return json({ ok: false, error: scopes.error }, 400);
      const expiry = expiryFrom(body.expiresInDays, new Date());
      if ('error' in expiry) return json({ ok: false, error: expiry.error }, 400);
      // Omitted limits mean the whole diary, which is what every key did before they existed.
      const policy = normalisePolicy(body.policy);
      if ('error' in policy) return json({ ok: false, error: policy.error }, 400);
      // Original text is text: a counts-only key that also holds raw:read would be two
      // answers to one question, so the pair is refused here rather than silently resolved.
      if (policy.policy.text === 'none' && scopes.scopes.includes('raw:read')) {
        return json({ ok: false, error: 'A counts-only key cannot read original text. Untick Original text.' }, 400);
      }
      const created = await createApiKey(env, {
        name: (body.name as string).trim(), scopes: scopes.scopes, policy: policy.policy, expiresAt: expiry.at,
      });
      // The one response that ever carries the key itself.
      return json({ ok: true, ...created });
    }
    const revoke = /^\/api\/keys\/([^/]+)\/revoke$/.exec(path);
    if (request.method === 'POST' && revoke) {
      // Checked here, not by Postgres: a cast error would answer as a database failure.
      if (!isRowId(revoke[1])) return json({ ok: false, error: 'That is not a key id this diary issued.' }, 400);
      const done = await revokeApiKey(env, revoke[1]);
      if (!done) return json({ ok: false, error: 'No live key with that id.' }, 404);
      return json({ ok: true });
    }
    return json({ ok: false, error: 'No such key route.' }, 404);
  } catch (err) {
    console.error('api keys failed', err);
    const message = err instanceof Error ? err.message : '';
    // A missing table is worth saying out loud: it names the migration to run.
    return json({ ok: false, error: message.includes('0007') ? message : 'Could not reach the database.' }, 502);
  }
}

// The Settings card's two questions: when the diary was last copied, and take one now. This is a
// session route like the others and never a key route — a snapshot is the whole diary in one
// document, which is the last thing a leaked read key should be able to reach.
async function backupApi(request: Request, env: Env): Promise<Response> {
  if (!(await signedIn(request, env))) {
    return json({ ok: false, need: 'login', error: 'Sign in to see the backups.' }, 401);
  }
  const store = supabaseStore(env);
  if (!store.latestBackup) return json({ ok: false, error: 'This build cannot take backups.' }, 503);
  try {
    if (request.method === 'POST') {
      if (!store.takeBackup) return json({ ok: false, error: 'This build cannot take backups.' }, 503);
      await store.takeBackup('manual');
    }
    const { available, backup } = await store.latestBackup();
    return json({
      ok: true,
      available,
      backup: backup ? { id: backup.id, at: backup.taken_at, reason: backup.reason, counts: backup.counts } : null,
    });
  } catch (err) {
    console.error('backup api failed', err);
    return json({ ok: false, error: 'The database did not answer. Nothing was taken.' }, 502);
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
        // The toast above the button follows the same grammar as the messages: a verdict first.
        await answerCallback(env, q.id, '✓ Marked done — no more pings');
      } else {
        await answerCallback(env, q.id, '✓ Nothing to do');
      }
      return new Response('ok');
    }
    // Say the message landed, and keep saying it while the note is cleaned and stored: a few
    // seconds of silence reads the same as a message that never arrived.
    const typing = chatId === ownerId ? await keepTyping(notifier, chatId) : null;
    try {
      await handleUpdate(update, store, notifier, {
        allowedChatId: Number(env.ALLOWED_CHAT_ID),
        timeZone: env.DIARY_TZ || 'UTC',
      }, new Date(), env.AI ? workersAiRefiner(env.AI) : undefined, {
        repair: (limit: number) => repairUntouched(env, limit),
      });
    } finally {
      typing?.stop();
    }
    return new Response('ok');
  } catch (err) {
    // Tell the owner instead of failing silently. Answering 200 stops Telegram from
    // retrying the same update every few minutes for a day, which would turn one
    // failure into dozens of identical error messages.
    console.error('update failed', err);
    const reason = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'unknown error';
    if (chatId !== ownerId) return new Response('retry', { status: 500 });
    await notifier.reply(ownerId, failedMessage('Something failed', reason, 'Send /heartbeat to check whether the diary is reachable.'));
    return new Response('ok');
  }
}

async function runDue(env: Env): Promise<void> {
  const store = supabaseStore(env);
  const notifier = telegramNotifier(env);
  const chatId = Number(env.ALLOWED_CHAT_ID);
  if (!store.listDueReminders) return;
  const due = await store.listDueReminders(new Date().toISOString());
  // The due date is read on the diary's clock, so a deadline set for 09:00 UTC cannot show as
  // the day before. A failed read falls back to the Worker's own zone rather than to no message.
  const tz = (await store.getTimeZone().catch(() => null)) ?? (env.DIARY_TZ || 'UTC');
  for (const r of due) {
    const text = reminderMessage(r.kind, r.title, r.due_at, tz);
    if (notifier.remind) await notifier.remind(chatId, r.id, text);
    else await notifier.reply(chatId, text);
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

// The 10pm summary. Two cron entries cover CET and CEST; whichever one lands at 22:00 in
// the diary's timezone sends, and the settings row stops a second one on the day the
// clocks go back. A database that refuses the reads sends nothing at all, rather than a
// summary that claims the day was empty.
async function dailySummary(env: Env): Promise<void> {
  const store = supabaseStore(env);
  if (!store.dayNotes || !store.openReminders || !store.summarySentOn || !store.markSummarySent) return;
  const tz = (await store.getTimeZone()) ?? (env.DIARY_TZ || 'UTC');
  const now = new Date();
  const day = localDay(now, tz);
  const sentOn = await store.summarySentOn();
  if (!summaryDue(hourIn(now, tz), sentOn, day)) return;
  const [notes, reminders] = await Promise.all([store.dayNotes(day), store.openReminders(6)]);
  await telegramNotifier(env).reply(Number(env.ALLOWED_CHAT_ID), summaryMessage({ day, timeZone: tz, notes, reminders }));
  await store.markSummarySent(day);
}

// The keep-alive beat: three heartbeat rows a day, so the free Supabase project never sees a
// quiet week and pauses. Every heartbeat is said out loud as it is written, from whichever
// source wrote it: this one, and /heartbeat when it is asked for by hand.
//
// A beat belongs to a slot, and the first run at or after that slot writes it — once, because the
// slot it satisfied is recorded in settings. Both of the day's paired cron entries resolve to the
// same slot from the diary's clock, and a run that comes late still beats rather than being
// skipped, which is what requiring the exact minute used to do whenever a trigger was missing or
// the clocks had moved.
async function heartbeat(env: Env): Promise<void> {
  const store = supabaseStore(env);
  if (!store.heartbeatMark || !store.markHeartbeat) return;
  const tz = (await store.getTimeZone()) ?? (env.DIARY_TZ || 'UTC');
  const now = new Date();
  const slot = beatSlot(now, tz);
  if (!slot) return;                                        // before the first slot of the day
  if ((await store.heartbeatMark()) === slot.key) return;   // this slot already has its row
  // The beat is the write; the counts are what make the message worth opening. A failed count
  // read must not cost the beat, so the row still goes in and the message falls back to the line
  // that says only what happened.
  let stats: HealthStats | null = null;
  if (store.health) {
    try {
      stats = await store.health(localDay(now, tz), 'cron');
    } catch (err) {
      console.error('beat counts failed', err);
    }
  }
  if (!stats) {
    if (!store.beat) return;
    await store.beat('cron');
  }
  await telegramNotifier(env).reply(Number(env.ALLOWED_CHAT_ID), beatMessage(slot, tz, stats));
  await store.markHeartbeat(slot.key);
}

// The copy that leaves. Once a week, on the Monday run: the snapshot pg_cron made at 03:00 is
// already in the table by the first tick of the day, so the usual case is a read and an upload.
// If that snapshot is missing or old the Worker takes a fresh one first — a stale document sent
// as if it were this week's would be worse than no message at all.
async function exportBackup(env: Env): Promise<void> {
  const store = supabaseStore(env);
  if (!store.latestBackup || !store.backupExportedOn || !store.markBackupExported) return;
  const tz = (await store.getTimeZone()) ?? (env.DIARY_TZ || 'UTC');
  const now = new Date();
  if (!exportDue(now, tz, await store.backupExportedOn())) return;

  let latest = await store.latestBackup();
  if (!latest.available) return;                       // 0013 has not been run: nothing to send
  if (!latest.backup || staleSnapshot(latest.backup.taken_at, now)) {
    if (!store.takeBackup) return;
    await store.takeBackup('weekly export');
    latest = await store.latestBackup();
  }
  const snapshot = latest.backup;
  if (!snapshot?.payload) return;

  const day = localDay(now, tz);
  const sent = await sendDocument(
    env, Number(env.ALLOWED_CHAT_ID),
    backupFileName(day),
    typeof snapshot.payload === 'string' ? snapshot.payload : JSON.stringify(snapshot.payload),
    backupCaption(snapshot.taken_at, snapshot.counts, tz),
  );
  if (!sent) return;                                   // a later run this week tries again
  await store.markBackupExported(weekKey(day));
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
    if (url.pathname === '/api/note' && request.method === 'POST') return noteApi(request, env);
    if (url.pathname === '/api/note/move' && request.method === 'POST') return moveApi(request, env);
    if (url.pathname === '/api/reminder/done' && request.method === 'POST') return reminderDoneApi(request, env);
    if (url.pathname === '/api/passphrase' && request.method === 'POST') return passphraseApi(request, env);
    if (url.pathname === '/api/ai-check' && request.method === 'GET') return aiCheck(request, env);
    if (url.pathname === '/api/reclean' && request.method === 'POST') return reclean(request, env);
    // The read API for other projects, and the key management the page drives. Both are matched
    // by prefix before the assets fallback, which would otherwise answer them with a 404 page.
    // The write half of the API needs the same store and notifier the bot uses, plus the
    // cleanup the composer runs: an API note is the same kind of row as a typed one.
    if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
      return publicApi(request, env, {
        store: supabaseStore(env),
        refiner: env.AI ? workersAiRefiner(env.AI) : undefined,
        notify: (text: string) => sendTelegram(env, { chat_id: Number(env.ALLOWED_CHAT_ID), text, parse_mode: 'HTML' }),
        timeZone: env.DIARY_TZ || 'UTC',
      });
    }
    if (url.pathname === '/api/backup') return backupApi(request, env);
    if (url.pathname === '/api/keys' || url.pathname.startsWith('/api/keys/')) return keysApi(request, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    // Each step stands on its own: the reminders must not be able to cancel the beat, and the beat
    // must not be able to cancel the summary. One failing step used to take the rest of the run
    // down with it, and a beat that never ran was invisible precisely because the summary it
    // silenced is the thing that would have shown it.
    for (const [name, step] of [['reminders', runDue], ['heartbeat', heartbeat], ['summary', dailySummary], ['backup', exportBackup]] as const) {
      try {
        await step(env);
      } catch (err) {
        console.error(`scheduled ${name} failed`, err);
      }
    }
  },
};

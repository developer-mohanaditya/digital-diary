import {
  handleUpdate, localDay, type TelegramUpdate, type Store, type Notifier, type RepairResult, type ThoughtInput,
} from './handler';
import type { Category, Mode } from './parse';
import { MAX_INPUT_CHARS, sameWords } from './refine';
import { UI_CATEGORIES, groupByDay, type DeadlineMark, type ThoughtRow } from './api';
import { BACKUP_MODEL, BIG_MODEL, SMALL_MODEL, readOutput, workersAiRefiner, type AiRunner } from './refine';
import {
  SESSION_COOKIE, clearedCookie, issueSession, readCookie, sameSecret, sessionCookie, sessionValid,
} from './session';
import { PASSPHRASE_KEY, hashPassphrase, passphraseProblem, verifyPassphrase } from './auth';

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
      const write = (body: ThoughtInput) => fetch(`${base}/thoughts`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(body),
      });
      let res = await write(t);
      // The usage columns arrive with 0006, and a deploy can reach production before the
      // migration does. The note matters more than what it cost, so a 400 retries without
      // them — the fallback the web paths already take.
      if (res.status === 400) {
        const { tokens_in: _in, tokens_out: _out, cleanup_model: _model, ...bare } = t;
        res = await write(bare);
      }
      await check(res);
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
  // If Cloudflare Access is ever enabled, it authenticates visitors before the Worker
  // and stamps this header. The cookie covers the case where Access is not set up.
  if (request.headers.get('Cf-Access-Jwt-Assertion')) return true;
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
      const out = await refiner.refine({ text: r.raw_text!, mode: r.mode as 'refine' | 'reason' | 'think', category: r.category });
      if (!out || out.text === r.clean_text) continue;
      // The repair spends neurons too, so it records what it cost on the row it rewrote.
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
      });
      // The rewrite matters more than its cost, so a missing 0006 costs the counters, not the repair.
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
  // The usage columns arrive with migration 0006. Asking for a column that does not exist
  // yet is a 400 from PostgREST, and that would blank the diary page for everyone between a
  // deploy and the migration being run, so the read falls back to the older column set.
  const readThoughts = async (select: string) =>
    fetch(`${base}/thoughts?day=gte.${from}&day=lte.${to}&select=${select}&order=day.asc&limit=1000`, { headers });
  const withUsage = 'id,day,category,category_source,mode,clean_text,raw_text,created_at,capture_id,tokens_in,tokens_out,cleanup_model';
  const withoutUsage = 'id,day,category,category_source,mode,clean_text,raw_text,created_at,capture_id';
  try {
    const [thoughtsRes, remindersRes] = await Promise.all([
      (async () => {
        const first = await readThoughts(withUsage);
        return first.status === 400 ? readThoughts(withoutUsage) : first;
      })(),
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

// What the page reports after a save, so the message under the box is about the note it
// just typed rather than a generic "saved".
type NoteCleanup = 'formatted' | 'unchanged' | 'verbatim' | 'unavailable' | 'failed';

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
  // failure only changes the wording: the raw text is saved either way.
  let clean = text;
  let cleanup: NoteCleanup = 'unavailable';
  let refineError: string | null = null;
  let usage: { tokensIn: number | null; tokensOut: number | null; model: string | null } =
    { tokensIn: null, tokensOut: null, model: null };
  if (mode === 'verbatim') {
    cleanup = 'verbatim';
  } else if (env.AI) {
    try {
      const out = await workersAiRefiner(env.AI).refine({ text, mode, category });
      if (out) usage = { tokensIn: out.tokensIn, tokensOut: out.tokensOut, model: out.model };
      if (out && !sameWords(out.text, text)) {
        clean = out.text;
        cleanup = 'formatted';
      } else {
        cleanup = 'unchanged';
      }
    } catch (err) {
      cleanup = 'failed';
      refineError = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'unknown error';
      console.error('refine failed', err);
    }
  }

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
    });
    // Same reason as the read above: a deploy can reach production before the migration
    // does, and a note that was captured must still be stored.
    if (thoughtRes.status === 400) thoughtRes = await writeThought(row);
    if (!thoughtRes.ok) {
      return json({ ok: false, error: `Supabase ${thoughtRes.status}: ${await thoughtRes.text()}` }, 502);
    }
    const thoughtRows = (await thoughtRes.json()) as { id: string }[];
    const thoughtId = thoughtRows[0]?.id ?? null;

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

// When a deadline's reminder should first fire: three days before the due date, or now when
// that day has already passed. Shared by the composer, which sets one at capture time, and
// by a move to Deadline, which has to add one afterwards.
function reminderTimes(due: string, now: Date): { dueAt: Date; next: Date } {
  const dueAt = new Date(`${due}T09:00:00.000Z`);
  const first = new Date(dueAt.getTime() - 3 * 86400000);
  return { dueAt, next: first.getTime() < now.getTime() ? now : first };
}

// POST /api/note/move { id, category, due? } -> files the row under another category. The demo's
// Move button only rewrote its own array and forgot the move on reload; this is the row. A move
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
    }, new Date(), env.AI ? workersAiRefiner(env.AI) : undefined, {
      repair: (limit: number) => repairUntouched(env, limit),
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
    if (url.pathname === '/api/session') {
      if (request.method === 'POST') return signIn(request, env);
      if (request.method === 'DELETE') return json({ ok: true }, 200, { 'Set-Cookie': clearedCookie() });
    }
    if (url.pathname === '/api/entries' && request.method === 'GET') return entriesApi(request, env);
    if (url.pathname === '/api/note' && request.method === 'POST') return noteApi(request, env);
    if (url.pathname === '/api/note/move' && request.method === 'POST') return moveApi(request, env);
    if (url.pathname === '/api/passphrase' && request.method === 'POST') return passphraseApi(request, env);
    if (url.pathname === '/api/ai-check' && request.method === 'GET') return aiCheck(request, env);
    if (url.pathname === '/api/reclean' && request.method === 'POST') return reclean(request, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await runDue(env);
  },
};

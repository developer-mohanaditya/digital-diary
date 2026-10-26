// The public read API under /api/v1.
//
// One place holds everything a second project needs to read the diary without the page and
// without the passphrase: key authentication with its rate limit, the filter language, the
// query it turns into, and the response envelope. The router at the bottom owns the paths.
//
// Two rules run through the file. Nothing the caller sends reaches a query unfiltered — every
// value is validated against a shape and rebuilt server-side. And every answer carries
// `Cache-Control: private, no-store` with no CORS header at all, so neither the edge nor a
// foreign page can hold on to a single note.

import { sameSecret } from './session';
import {
  DEFAULT_SCOPES, SCOPE_LABEL, SCOPES, generateKey, hashKey, hasScope, keyShaped, lookupPrefix,
  type Scope,
} from './apikey';
import { UI_CATEGORIES, clock, displayMode, type ThoughtRow } from './api';
import { localDay } from './handler';
import type { Env } from './index';

export const API_VERSION = 'v1';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_Q = 60;
const MAX_CAPTURES = 500;   // ids in one in.(...) filter
const MAX_EXPORT = 5000;    // notes in one export, so a range cannot pull the whole diary by accident
const CHUNK = 100;          // ids per reminders lookup

const NOTE_FIELDS = [
  'id', 'day', 'time', 'at', 'category', 'type', 'source', 'text', 'words',
  'due', 'done', 'doneAt', 'usage', 'raw',
] as const;
type NoteField = (typeof NOTE_FIELDS)[number];

const TYPE_INPUT = ['refine', 'refined', 'verbatim', 'reason', 'think'];
const SOURCE_INPUT = ['tag', 'auto', 'manual'];
const STAT_BY = ['day', 'week', 'month', 'year', 'category', 'type', 'source'] as const;
type StatBy = (typeof STAT_BY)[number];

/* ---------- Answers ---------- */

export function apiJson(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

export function apiFail(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return apiJson({ ok: false, error: { code, message } }, status, extra);
}

// A refusal raised deep in a read, answered once by the router. Keeping the status and the
// reason together means a filter rejection cannot accidentally answer 200 with an empty list.
class Problem extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, string> = {}) {
    super(message);
  }
}

/* ---------- Keys ---------- */

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string[] | null;
  per_minute: number | null;
  per_day: number | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface KeySession {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  perMinute: number;
  perDay: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

interface Rate {
  limit: number;
  remaining: number;
  reset: number; // epoch seconds, end of the minute window
}

export interface Authed {
  key: KeySession;
  rate: Rate | null;
}

function db(env: Env) {
  return {
    base: `${env.SUPABASE_URL}/rest/v1`,
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
  };
}

// PostgREST answers 404 for a table or function that does not exist yet, and 400 with a
// Postgres code when the schema is half-migrated. Both mean the same thing to the owner.
const isMissing = (res: Response, text: string) =>
  res.status === 404 || /PGRST20[25]|42P01|42883/.test(text);

// Resolves a bearer key to a session, or refuses. Everything that can be wrong with a
// credential answers the same 401, so a caller cannot tell a revoked key from a made-up one,
// an expired key from a mistyped one.
export async function authenticate(request: Request, env: Env): Promise<Authed> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const unauthorised = () => new Problem(401, 'unauthorized', 'Send a valid API key: Authorization: Bearer ddk_live_…', {
    'WWW-Authenticate': 'Bearer realm="diary"',
  });
  if (!match) throw unauthorised();
  const given = match[1].trim();
  if (!keyShaped(given)) throw unauthorised();

  const { base, headers } = db(env);
  const res = await fetch(
    `${base}/api_keys?prefix=eq.${encodeURIComponent(lookupPrefix(given))}` +
      '&select=id,name,prefix,hash,scopes,per_minute,per_day,last_used_at,expires_at,revoked_at&limit=1',
    { headers },
  );
  if (!res.ok) {
    const text = await res.text();
    if (isMissing(res, text)) {
      throw new Problem(503, 'setup', 'API keys are not set up yet: run migrations/0007_api_keys.sql.');
    }
    console.error('api key lookup failed', res.status);
    throw new Problem(502, 'upstream', 'The diary database did not answer.');
  }
  const rows = (await res.json()) as KeyRow[];
  const row = rows[0];
  if (!row) throw unauthorised();
  if (!sameSecret(row.hash, await hashKey(given))) throw unauthorised();

  const now = Date.now();
  if (row.revoked_at) throw unauthorised();
  if (row.expires_at && Date.parse(row.expires_at) <= now) throw unauthorised();

  const key: KeySession = {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: (row.scopes ?? DEFAULT_SCOPES) as Scope[],
    perMinute: row.per_minute ?? 60,
    perDay: row.per_day ?? 5000,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };

  const rate = await bumpUsage(env, key);
  // Recorded at most once a minute: it is here so Settings can say which key is live, not a
  // request log, and one write per request would be a second database round trip each time.
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > 60000) {
    try {
      await fetch(`${base}/api_keys?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ last_used_at: new Date(now).toISOString() }),
      });
    } catch (err) {
      console.error('api key touch failed', err);
    }
  }
  return { key, rate };
}

// Counts the request and enforces both limits in one round trip. A missing function means the
// migration has not run, which is a setup problem worth naming; any other failure lets the
// request through uncounted rather than taking a working key offline.
async function bumpUsage(env: Env, key: KeySession): Promise<Rate | null> {
  const { base, headers } = db(env);
  const res = await fetch(`${base}/rpc/bump_api_usage`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ k: key.id }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (isMissing(res, text)) {
      throw new Problem(503, 'setup', 'The API counter is missing: run migrations/0007_api_keys.sql.');
    }
    console.error('api usage bump failed', res.status);
    return null;
  }
  const rows = (await res.json()) as { minute_count: number; day_count: number }[];
  const used = rows[0];
  if (!used) return null;
  const reset = Math.floor(Date.now() / 60000) * 60 + 60;
  const minute = Number(used.minute_count) || 0;
  const day = Number(used.day_count) || 0;
  if (minute > key.perMinute || day > key.perDay) {
    const over = minute > key.perMinute ? 'minute' : 'day';
    const wait = over === 'minute' ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 3600;
    throw new Problem(429, 'rate_limited', `This key has used its ${over === 'minute' ? 'per-minute' : 'daily'} allowance.`, {
      'Retry-After': String(wait),
      'X-RateLimit-Limit': String(over === 'minute' ? key.perMinute : key.perDay),
      'X-RateLimit-Remaining': '0',
    });
  }
  return {
    limit: key.perMinute,
    remaining: Math.max(0, key.perMinute - minute),
    reset,
  };
}

function rateHeaders(rate: Rate | null): Record<string, string> {
  if (!rate) return {};
  return {
    'X-RateLimit-Limit': String(rate.limit),
    'X-RateLimit-Remaining': String(rate.remaining),
    'X-RateLimit-Reset': String(rate.reset),
  };
}

function requireScope(key: KeySession, need: Scope): void {
  if (hasScope(key.scopes, need)) return;
  throw new Problem(403, 'forbidden', `This key cannot do that: it needs the ${need} scope.`);
}

export interface CreatedKey {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  expiresAt: string | null;
  key: string;
}

export async function createApiKey(
  env: Env,
  input: { name: string; scopes: Scope[]; expiresAt: string | null },
): Promise<CreatedKey> {
  const key = generateKey();
  const { base, headers } = db(env);
  const res = await fetch(`${base}/api_keys`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify([{
      name: input.name,
      prefix: lookupPrefix(key),
      hash: await hashKey(key),
      scopes: input.scopes,
      expires_at: input.expiresAt,
    }]),
  });
  if (!res.ok) {
    const text = await res.text();
    if (isMissing(res, text)) throw new Error('The api_keys table is missing. Run migrations/0007_api_keys.sql.');
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  const rows = (await res.json()) as KeyRow[];
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: (row.scopes ?? input.scopes) as Scope[],
    expiresAt: row.expires_at,
    key,
  };
}

export interface KeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export async function listApiKeys(env: Env): Promise<KeySummary[]> {
  const { base, headers } = db(env);
  const res = await fetch(
    `${base}/api_keys?select=id,name,prefix,scopes,created_at,last_used_at,expires_at,revoked_at&order=created_at.desc&limit=50`,
    { headers },
  );
  if (!res.ok) {
    const text = await res.text();
    // Not an empty list: a table that was never created is a setup problem, and Settings
    // should say which migration fixes it rather than claim there are no keys.
    if (isMissing(res, text)) throw new Error('The api_keys table is missing. Run migrations/0007_api_keys.sql.');
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  }
  const rows = (await res.json()) as (KeyRow & { created_at: string })[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes ?? [],
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  }));
}

export async function revokeApiKey(env: Env, id: string): Promise<boolean> {
  const { base, headers } = db(env);
  const res = await fetch(`${base}/api_keys?id=eq.${id}&revoked_at=is.null`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as { id: string }[];
  return rows.length > 0;
}

/* ---------- Dates ---------- */

export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// A day, a month, a year, or an explicit from/to — never two ways of saying the same thing.
export interface Period {
  from?: string;
  to?: string;
}

export function parsePeriod(params: URLSearchParams): Period {
  const day = params.get('day');
  const month = params.get('month');
  const year = params.get('year');
  const from = params.get('from');
  const to = params.get('to');
  const named = [day, month, year, from, to].filter((v) => v !== null && v !== '');
  if (named.length > 1 && (day || month || year)) {
    throw new Problem(400, 'bad_filter', 'Pick one time selector: day, month, year, or from/to.');
  }
  if (day !== null && day !== '') {
    if (!isDay(day)) throw new Problem(400, 'bad_filter', 'day must be a real date, like 2026-10-25.');
    return { from: day, to: day };
  }
  if (month !== null && month !== '') {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    const num = m ? Number(m[2]) : 0;
    if (!m || num < 1 || num > 12) throw new Problem(400, 'bad_filter', 'month must look like 2026-10.');
    const last = new Date(Date.UTC(Number(m[1]), num, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${pad2(last)}` };
  }
  if (year !== null && year !== '') {
    const y = Number(year);
    if (!/^\d{4}$/.test(year) || y < 2000 || y > 2100) throw new Problem(400, 'bad_filter', 'year must be four digits, like 2026.');
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  if ((from && !isDay(from)) || (to && !isDay(to))) {
    throw new Problem(400, 'bad_filter', 'from and to must be real dates, like 2026-01-01.');
  }
  if (from && to && from > to) throw new Problem(400, 'bad_filter', 'from is after to.');
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

/* ---------- Filters ---------- */

export type DeadlineFilter = 'any' | 'has' | 'open' | 'done';

export interface NoteFilters {
  period: Period;
  categories?: string[];
  types?: string[];
  sources?: string[];
  q?: string;
  deadline: DeadlineFilter;
  limit: number;
  cursor?: { at: string; id: string };
  order: 'asc' | 'desc';
  fields?: NoteField[];
}

function listParam(raw: string | null): string[] | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// What the caller typed, checked until it is one of the shapes the database understands.
export function parseNoteFilters(params: URLSearchParams): NoteFilters {
  const period = parsePeriod(params);

  const categories = listParam(params.get('category'));
  if (categories) {
    const unknown = categories.filter((c) => !(UI_CATEGORIES as readonly string[]).includes(c));
    if (unknown.length) throw new Problem(400, 'bad_filter', `Unknown category: ${unknown.join(', ')}.`);
  }

  const types = listParam(params.get('type'));
  if (types) {
    const unknown = types.filter((t) => !TYPE_INPUT.includes(t));
    if (unknown.length) throw new Problem(400, 'bad_filter', `Unknown type: ${unknown.join(', ')}.`);
  }

  const sources = listParam(params.get('source'));
  if (sources) {
    const unknown = sources.filter((s) => !SOURCE_INPUT.includes(s));
    if (unknown.length) throw new Problem(400, 'bad_filter', `Unknown source: ${unknown.join(', ')}.`);
  }

  let q: string | undefined;
  const rawQ = params.get('q');
  if (rawQ !== null && rawQ.trim() !== '') {
    // Only what a word search needs. `%`, `_`, `*` and the PostgREST punctuation stay out, so
    // the value cannot become a wildcard or a second filter.
    const cleaned = rawQ.replace(/[^\p{L}\p{N} '\-.?!]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length < 2) throw new Problem(400, 'bad_filter', 'q needs at least two letters or digits.');
    if (cleaned.length > MAX_Q) throw new Problem(400, 'bad_filter', `q is limited to ${MAX_Q} characters.`);
    q = cleaned;
  }

  const has = params.get('has');
  if (has !== null && has !== 'deadline') {
    throw new Problem(400, 'bad_filter', 'has understands one value: deadline.');
  }
  let deadline: DeadlineFilter = has === 'deadline' ? 'has' : 'any';
  const done = params.get('done');
  if (done !== null) {
    if (done !== 'true' && done !== 'false') throw new Problem(400, 'bad_filter', 'done is true or false.');
    deadline = done === 'true' ? 'done' : 'open';
  }

  let limit = DEFAULT_LIMIT;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1) throw new Problem(400, 'bad_filter', 'limit is a whole number of notes, 1 or more.');
    limit = Math.min(n, MAX_LIMIT);
  }

  const orderRaw = params.get('order');
  if (orderRaw !== null && orderRaw !== 'asc' && orderRaw !== 'desc') {
    throw new Problem(400, 'bad_filter', 'order is asc or desc.');
  }
  const order = orderRaw === 'asc' ? 'asc' : 'desc';

  let cursor: { at: string; id: string } | undefined;
  const rawCursor = params.get('cursor');
  if (rawCursor !== null && rawCursor !== '') cursor = decodeCursor(rawCursor);

  let fields: NoteField[] | undefined;
  const rawFields = listParam(params.get('fields'));
  if (rawFields) {
    const unknown = rawFields.filter((f) => !(NOTE_FIELDS as readonly string[]).includes(f));
    if (unknown.length) {
      throw new Problem(400, 'bad_filter', `Unknown field: ${unknown.join(', ')}. The fields are ${NOTE_FIELDS.join(', ')}.`);
    }
    fields = rawFields as NoteField[];
  }

  return {
    period,
    ...(categories ? { categories } : {}),
    // 'refined' is what the page calls refine; both name the same stored mode.
    ...(types ? { types: types.map((t) => (t === 'refined' ? 'refine' : t)) } : {}),
    ...(sources ? { sources } : {}),
    ...(q ? { q } : {}),
    deadline,
    limit,
    ...(cursor ? { cursor } : {}),
    order,
    ...(fields ? { fields } : {}),
  };
}

function encodeCursor(at: string, id: string): string {
  return btoa(`${at}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(value: string): { at: string; id: string } {
  let text = '';
  try {
    text = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    text = '';
  }
  const [at, id] = text.split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    throw new Problem(400, 'bad_cursor', 'That page cursor is not one this API issued.');
  }
  return { at, id };
}

/* ---------- Queries ---------- */

const NOTE_COLUMNS =
  'id,day,category,category_source,mode,clean_text,raw_text,created_at,capture_id,tokens_in,tokens_out,cleanup_model';
const NOTE_COLUMNS_NO_USAGE = 'id,day,category,category_source,mode,clean_text,raw_text,created_at,capture_id';

// The whole filter language as one PostgREST query string. `captureIds` narrows to the notes a
// deadline filter already selected; null means every note.
export function notesQuery(f: NoteFilters, captureIds: string[] | null, withUsage = true): string {
  const q: string[] = [`select=${withUsage ? NOTE_COLUMNS : NOTE_COLUMNS_NO_USAGE}`];
  if (f.period.from) q.push(`day=gte.${f.period.from}`);
  if (f.period.to) q.push(`day=lte.${f.period.to}`);
  if (f.categories?.length) q.push(`category=in.(${f.categories.join(',')})`);
  if (f.types?.length) q.push(`mode=in.(${f.types.join(',')})`);
  if (f.sources?.length) q.push(`category_source=in.(${f.sources.join(',')})`);
  if (f.q) q.push(`clean_text=ilike.*${encodeURIComponent(f.q)}*`);
  if (captureIds) q.push(`capture_id=in.(${captureIds.join(',')})`);
  if (f.cursor) {
    // Keyset paging: stable while notes are still arriving, unlike an offset.
    const at = encodeURIComponent(f.cursor.at);
    const id = f.cursor.id;
    q.push(f.order === 'desc'
      ? `or=(created_at.lt.${at},and(created_at.eq.${at},id.lt.${id}))`
      : `or=(created_at.gt.${at},and(created_at.eq.${at},id.gt.${id}))`);
  }
  q.push(`order=created_at.${f.order},id.${f.order}`);
  // One extra row tells the answer whether a next page exists without a second count query.
  q.push(`limit=${f.limit + 1}`);
  return q.join('&');
}

async function get(env: Env, path: string): Promise<Response> {
  const { base, headers } = db(env);
  return fetch(`${base}/${path}`, { headers });
}

async function getJson<T>(env: Env, path: string): Promise<T> {
  const res = await get(env, path);
  if (!res.ok) {
    console.error('api read failed', res.status);
    throw new Problem(502, 'upstream', 'The diary database did not answer.');
  }
  return (await res.json()) as T;
}

async function readNotes(env: Env, f: NoteFilters, captureIds: string[] | null): Promise<ThoughtRow[]> {
  const first = await get(env, `thoughts?${notesQuery(f, captureIds)}`);
  if (first.ok) return (await first.json()) as ThoughtRow[];
  // The usage columns arrive with 0006; a read that asks for them before they exist is a 400.
  if (first.status === 400) {
    const retry = await get(env, `thoughts?${notesQuery(f, captureIds, false)}`);
    if (retry.ok) return (await retry.json()) as ThoughtRow[];
  }
  console.error('api notes read failed', first.status);
  throw new Problem(502, 'upstream', 'The diary database did not answer.');
}

interface ReminderRow {
  id: string;
  capture_id: string | null;
  thought_id: string | null;
  title: string;
  due_at: string | null;
  status: string;
  done_at: string | null;
  created_at: string;
}

// Which notes carry a deadline, for `has=deadline` and `done=`.
async function deadlineCaptures(env: Env, mode: Exclude<DeadlineFilter, 'any'>): Promise<string[]> {
  const status = mode === 'done' ? '&status=eq.done' : mode === 'open' ? '&status=eq.pending' : '';
  const rows = await getJson<{ capture_id: string | null }[]>(
    env,
    `reminders?kind=eq.deadline${status}&select=capture_id&limit=${MAX_CAPTURES}`,
  );
  const ids = Array.from(new Set(rows.map((r) => r.capture_id).filter((id): id is string => !!id)));
  if (ids.length >= MAX_CAPTURES) {
    throw new Problem(413, 'too_many', 'Too many deadlines to filter by. Narrow the dates and try again.');
  }
  return ids;
}

// The deadline attached to each of these notes, keyed by the capture they were made from, which
// is how both the bot and the composer attach one.
async function deadlineMarks(env: Env, rows: ThoughtRow[]): Promise<Map<string, ReminderRow>> {
  const marks = new Map<string, ReminderRow>();
  const captures = Array.from(new Set(rows.map((r) => r.capture_id).filter((id): id is string => !!id)));
  for (let i = 0; i < captures.length; i += CHUNK) {
    const slice = captures.slice(i, i + CHUNK);
    const found = await getJson<ReminderRow[]>(
      env,
      `reminders?capture_id=in.(${slice.join(',')})&kind=eq.deadline&select=id,capture_id,thought_id,title,due_at,status,done_at,created_at`,
    );
    for (const r of found) if (r.capture_id && !marks.has(r.capture_id)) marks.set(r.capture_id, r);
  }
  return marks;
}

/* ---------- Mapping ---------- */

const words = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0);

export interface ApiNote {
  id: string;
  day: string;
  time: string;
  at: string;
  category: string;
  type: string;
  source: string;
  text: string;
  words: number;
  due?: string | null;
  done?: boolean;
  doneAt?: string | null;
  usage?: { tokensIn: number | null; tokensOut: number | null; model: string | null };
  raw?: string;
}

// One row as a caller sees it. `fields` cuts the shape down but the values are the same; the
// original text only appears when the key was granted it.
export function toApiNote(
  row: ThoughtRow,
  timeZone: string,
  deadline?: ReminderRow,
  opts: { raw: boolean; fields?: NoteField[] } = { raw: false },
): ApiNote {
  const full: ApiNote = {
    id: row.id,
    day: row.day,
    time: clock(row.created_at, timeZone),
    at: row.created_at,
    category: (UI_CATEGORIES as readonly string[]).includes(row.category) ? row.category : 'inbox',
    type: displayMode(row.mode),
    source: row.category_source === 'tag' ? 'tag' : row.category_source === 'manual' ? 'manual' : 'auto',
    text: row.clean_text,
    words: words(row.clean_text),
  };
  if (deadline) {
    full.due = deadline.due_at ? deadline.due_at.slice(0, 10) : null;
    full.done = deadline.status === 'done';
    full.doneAt = deadline.done_at;
  }
  if (row.tokens_in != null || row.tokens_out != null || row.cleanup_model) {
    full.usage = {
      tokensIn: row.tokens_in ?? null,
      tokensOut: row.tokens_out ?? null,
      model: row.cleanup_model ?? null,
    };
  }
  if (opts.raw) full.raw = row.raw_text || row.clean_text;
  if (!opts.fields) return full;
  const picked: Record<string, unknown> = {};
  for (const f of opts.fields) if (f in full) picked[f] = full[f];
  return picked as unknown as ApiNote;
}

// The original text is returned only when a note read both holds the scope and asks for the
// field, so a key granted raw:read does not carry every unfiltered draft into every payload.
function noteOptions(key: KeySession, f: { fields?: NoteField[] }): { raw: boolean; fields?: NoteField[] } {
  const asked = Boolean(f.fields?.includes('raw'));
  if (asked && !hasScope(key.scopes, 'raw:read')) {
    throw new Problem(403, 'forbidden', 'This key cannot read the original text: it needs the raw:read scope.');
  }
  return { raw: asked, ...(f.fields ? { fields: f.fields } : {}) };
}

/* ---------- Endpoints ---------- */

interface Ctx {
  env: Env;
  key: KeySession;
  tz: string;
  today: string;
  rate: Rate | null;
}

const meta = (ctx: Ctx, extra: Record<string, unknown> = {}) => ({
  version: API_VERSION,
  timeZone: ctx.tz,
  ...extra,
});

async function listNotes(ctx: Ctx, url: URL): Promise<Response> {
  requireScope(ctx.key, 'notes:read');
  const f = parseNoteFilters(url.searchParams);
  const opts = noteOptions(ctx.key, f);
  const captures = f.deadline === 'any' ? null : await deadlineCaptures(ctx.env, f.deadline);
  if (captures && !captures.length) {
    return apiJson({ ok: true, meta: meta(ctx, { count: 0, next: null }), notes: [] }, 200, rateHeaders(ctx.rate));
  }
  const rows = await readNotes(ctx.env, f, captures);
  const page = rows.slice(0, f.limit);
  const marks = page.length ? await deadlineMarks(ctx.env, page) : new Map<string, ReminderRow>();
  const notes = page.map((r) => toApiNote(r, ctx.tz, r.capture_id ? marks.get(r.capture_id) : undefined, opts));
  const next = rows.length > f.limit ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id) : null;
  return apiJson({ ok: true, meta: meta(ctx, { count: notes.length, next }), notes }, 200, rateHeaders(ctx.rate));
}

async function oneNote(ctx: Ctx, id: string): Promise<Response> {
  requireScope(ctx.key, 'notes:read');
  const rows = await getJson<ThoughtRow[]>(ctx.env, `thoughts?id=eq.${id}&select=${NOTE_COLUMNS}&limit=1`);
  const row = rows[0];
  if (!row) throw new Problem(404, 'not_found', 'No note with that id.');
  const marks = await deadlineMarks(ctx.env, [row]);
  const note = toApiNote(row, ctx.tz, row.capture_id ? marks.get(row.capture_id) : undefined, noteOptions(ctx.key, {}));
  return apiJson({ ok: true, meta: meta(ctx), note }, 200, rateHeaders(ctx.rate));
}

async function days(ctx: Ctx, url: URL): Promise<Response> {
  requireScope(ctx.key, 'stats:read');
  const period = parsePeriod(url.searchParams);
  const from = period.from ?? '2000-01-01';
  const to = period.to ?? ctx.today;
  const answer = await rpc(ctx.env, 'diary_days', { p_from: from, p_to: to });
  const list = (answer as { day: string; notes: number; words: number; categories: Record<string, number>; first_at: string; last_at: string }[])
    .map((d) => ({
      day: d.day,
      notes: Number(d.notes),
      words: Number(d.words),
      categories: d.categories,
      firstAt: d.first_at,
      lastAt: d.last_at,
    }));
  return apiJson(
    { ok: true, meta: meta(ctx, { from, to, count: list.length }), days: list },
    200,
    rateHeaders(ctx.rate),
  );
}

async function stats(ctx: Ctx, url: URL): Promise<Response> {
  requireScope(ctx.key, 'stats:read');
  const period = parsePeriod(url.searchParams);
  const byRaw = url.searchParams.get('by') ?? 'category';
  if (!(STAT_BY as readonly string[]).includes(byRaw)) {
    throw new Problem(400, 'bad_filter', `by is one of ${STAT_BY.join(', ')}.`);
  }
  const by = byRaw as StatBy;
  const from = period.from ?? '2000-01-01';
  const to = period.to ?? ctx.today;
  const answer = await rpc(ctx.env, 'diary_stats', { p_from: from, p_to: to, p_by: by });
  const groups = (answer as { bucket: string; notes: number; words: number; days: number }[]).map((g) => ({
    key: byRaw === 'type' ? displayMode(g.bucket) : g.bucket,
    notes: Number(g.notes),
    words: Number(g.words),
    days: Number(g.days),
  }));
  const totals = groups.reduce((a, g) => ({ notes: a.notes + g.notes, words: a.words + g.words }), { notes: 0, words: 0 });
  return apiJson(
    { ok: true, meta: meta(ctx, { by, from, to, count: groups.length, totals }), groups },
    200,
    rateHeaders(ctx.rate),
  );
}

// One RPC call, refusing clearly when the function itself is missing.
async function rpc(env: Env, name: string, body: Record<string, unknown>): Promise<unknown> {
  const { base, headers } = db(env);
  const res = await fetch(`${base}/rpc/${name}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (isMissing(res, text)) {
      throw new Problem(503, 'setup', `The ${name} function is missing: run migrations/0007_api_keys.sql.`);
    }
    console.error('api rpc failed', name, res.status);
    throw new Problem(502, 'upstream', 'The diary database did not answer.');
  }
  return res.json();
}

async function categories(ctx: Ctx): Promise<Response> {
  requireScope(ctx.key, 'notes:read');
  const rows = await getJson<{ id: string; label: string; sort_order: number }[]>(
    ctx.env,
    'categories?select=id,label,sort_order&order=sort_order.asc',
  );
  return apiJson(
    { ok: true, meta: meta(ctx, { count: rows.length }), categories: rows.map((r) => ({ id: r.id, label: r.label, order: r.sort_order })) },
    200,
    rateHeaders(ctx.rate),
  );
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

function toApiDeadline(r: ReminderRow, ctx: Ctx, note?: ThoughtRow) {
  const due = r.due_at ? r.due_at.slice(0, 10) : null;
  const done = r.status === 'done';
  const doneDay = r.done_at ? localDay(new Date(r.done_at), ctx.tz) : null;
  const openDay = localDay(new Date(r.created_at), ctx.tz);
  return {
    id: r.id,
    title: r.title,
    due,
    dueAt: r.due_at,
    status: r.status,
    done,
    doneAt: r.done_at,
    createdAt: r.created_at,
    // Whole days, so a caller does not have to do calendar arithmetic in the diary's timezone.
    daysLeft: due && !done ? dayDiff(due, ctx.today) : null,
    daysLate: due && doneDay ? dayDiff(doneDay, due) : null,
    openDays: dayDiff(doneDay ?? ctx.today, openDay),
    ...(note ? { note: { id: note.id, day: note.day, text: note.clean_text } } : {}),
    ...(r.thought_id ? { noteId: r.thought_id } : {}),
  };
}

// The notes behind a page of deadlines, so a client can see what the deadline was about.
async function notesById(env: Env, ids: string[]): Promise<Map<string, ThoughtRow>> {
  const byId = new Map<string, ThoughtRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = await getJson<ThoughtRow[]>(
      env,
      `thoughts?id=in.(${slice.join(',')})&select=id,day,category,clean_text,created_at`,
    );
    for (const r of rows) byId.set(r.id, r);
  }
  return byId;
}

async function deadlines(ctx: Ctx, url: URL): Promise<Response> {
  requireScope(ctx.key, 'deadlines:read');
  const status = url.searchParams.get('status') ?? 'open';
  if (!['open', 'done', 'all'].includes(status)) {
    throw new Problem(400, 'bad_filter', 'status is open, done or all.');
  }
  let limit = DEFAULT_LIMIT;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1) throw new Problem(400, 'bad_filter', 'limit is a whole number, 1 or more.');
    limit = Math.min(n, MAX_LIMIT);
  }
  const dueBefore = url.searchParams.get('due_before');
  const dueAfter = url.searchParams.get('due_after');
  if ((dueBefore && !isDay(dueBefore)) || (dueAfter && !isDay(dueAfter))) {
    throw new Problem(400, 'bad_filter', 'due_before and due_after must be real dates, like 2026-11-03.');
  }

  const q = [
    'kind=eq.deadline',
    'select=id,capture_id,thought_id,title,due_at,status,done_at,created_at',
    status === 'open' ? 'status=eq.pending' : status === 'done' ? 'status=eq.done' : '',
    dueBefore ? `due_at=lt.${dueBefore}T23:59:59Z` : '',
    dueAfter ? `due_at=gte.${dueAfter}T00:00:00Z` : '',
    'order=due_at.asc',
    `limit=${limit}`,
  ].filter(Boolean).join('&');
  const rows = await getJson<ReminderRow[]>(ctx.env, `reminders?${q}`);
  const ids = rows.map((r) => r.thought_id).filter((id): id is string => !!id);
  const notes = ids.length ? await notesById(ctx.env, ids) : new Map<string, ThoughtRow>();
  const list = rows.map((r) => toApiDeadline(r, ctx, r.thought_id ? notes.get(r.thought_id) : undefined));
  return apiJson({ ok: true, meta: meta(ctx, { status, count: list.length }), deadlines: list }, 200, rateHeaders(ctx.rate));
}

async function oneDeadline(ctx: Ctx, id: string): Promise<Response> {
  requireScope(ctx.key, 'deadlines:read');
  const rows = await getJson<ReminderRow[]>(
    ctx.env,
    `reminders?id=eq.${id}&kind=eq.deadline&select=id,capture_id,thought_id,title,due_at,status,done_at,created_at&limit=1`,
  );
  const row = rows[0];
  if (!row) throw new Problem(404, 'not_found', 'No deadline with that id.');
  const notes = row.thought_id ? await notesById(ctx.env, [row.thought_id]) : new Map<string, ThoughtRow>();
  const deadline = toApiDeadline(row, ctx, row.thought_id ? notes.get(row.thought_id) : undefined);
  return apiJson({ ok: true, meta: meta(ctx), deadline }, 200, rateHeaders(ctx.rate));
}

/* ---------- Export ---------- */

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const MD_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function markdownDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCDate()} ${MD_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Every note in the range, page by page, until the range is exhausted or the cap is reached.
async function readAllNotes(env: Env, base: NoteFilters): Promise<ThoughtRow[]> {
  const out: ThoughtRow[] = [];
  let cursor: NoteFilters['cursor'];
  for (;;) {
    const page = await readNotes(env, { ...base, cursor, limit: MAX_LIMIT }, null);
    out.push(...page.slice(0, MAX_LIMIT));
    if (page.length <= MAX_LIMIT) return out;
    if (out.length >= MAX_EXPORT) {
      throw new Problem(413, 'too_many', `That range holds more than ${MAX_EXPORT} notes. Narrow it.`);
    }
    const last = page[MAX_LIMIT - 1];
    cursor = { at: last.created_at, id: last.id };
  }
}

async function exportNotes(ctx: Ctx, url: URL): Promise<Response> {
  requireScope(ctx.key, 'notes:read');
  const f = parseNoteFilters(url.searchParams);
  const format = url.searchParams.get('format') ?? 'json';
  if (!['json', 'csv', 'md'].includes(format)) {
    throw new Problem(400, 'bad_filter', 'format is json, csv or md.');
  }
  const opts = noteOptions(ctx.key, f);
  const rows = await readAllNotes(ctx.env, f);
  const marks = rows.length ? await deadlineMarks(ctx.env, rows) : new Map<string, ReminderRow>();
  const notes = rows.map((r) => toApiNote(r, ctx.tz, r.capture_id ? marks.get(r.capture_id) : undefined, { ...opts, fields: undefined }));
  const label = f.period.from && f.period.to && f.period.from === f.period.to
    ? f.period.from
    : f.period.from && f.period.to
      ? `${f.period.from}_${f.period.to}`
      : 'all';

  if (format === 'json') {
    return apiJson(
      { ok: true, meta: meta(ctx, { ...f.period, count: notes.length }), notes },
      200,
      { ...rateHeaders(ctx.rate), 'Content-Disposition': `attachment; filename="diary-${label}.json"` },
    );
  }
  if (format === 'csv') {
    const head = ['day', 'time', 'at', 'category', 'type', 'source', 'words', 'due', 'done', 'text'];
    const body = notes.map((n) => [n.day, n.time, n.at, n.category, n.type, n.source, n.words, n.due ?? '', n.done ?? '', n.text].map(csvCell).join(','));
    return new Response([head.join(','), ...body].join('\r\n') + '\r\n', {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="diary-${label}.csv"`,
        ...rateHeaders(ctx.rate),
      },
    });
  }
  // Markdown: one heading a day, one bullet a note — the shape a person reads.
  const lines: string[] = [`# Diary · ${label}`, ''];
  let current = '';
  for (const n of notes) {
    if (n.day !== current) {
      current = n.day;
      lines.push(`## ${markdownDay(n.day)}`, '');
    }
    const flags = [n.due ? `due ${n.due}` : '', n.done ? 'done' : ''].filter(Boolean).join(', ');
    lines.push(`- **${n.time} · ${n.category}** — ${n.text.replace(/\s*\n\s*/g, ' ')}${flags ? ` _(${flags})_` : ''}`);
  }
  if (!notes.length) lines.push('_No notes in this range._');
  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="diary-${label}.md"`,
      ...rateHeaders(ctx.rate),
    },
  });
}

/* ---------- Discovery ---------- */

// What the API is and how to call it. No note content, so it can answer without a key: a
// caller holding a new key can read the shape before it sends its first query.
export function describe(tz: string) {
  return {
    ok: true,
    api: {
      name: 'Digital Diary',
      version: API_VERSION,
      timeZone: tz,
      readOnly: true,
      baseUrl: '/api/v1',
    },
    auth: {
      header: 'Authorization: Bearer <key>',
      keys: 'Create and revoke keys in the diary under Settings → Access.',
      notes: 'Responses are private and uncached, and carry no CORS header, so other origins cannot read them.',
    },
    scopes: Object.fromEntries(SCOPES.map((s) => [s, SCOPE_LABEL[s]])),
    endpoints: [
      { method: 'GET', path: '/api/v1', scope: null, about: 'This document.' },
      { method: 'GET', path: '/api/v1/me', scope: null, about: 'The key: name, scopes, limits, last use.' },
      { method: 'GET', path: '/api/v1/notes', scope: 'notes:read', about: 'Notes, filtered and paged. Filters: day, month, year, from, to, category, type, source, q, has=deadline, done, fields, limit, cursor, order.' },
      { method: 'GET', path: '/api/v1/notes/{id}', scope: 'notes:read', about: 'One note.' },
      { method: 'GET', path: '/api/v1/days', scope: 'stats:read', about: 'Per-day counts, words and category tally. Filters: day, month, year, from, to.' },
      { method: 'GET', path: '/api/v1/stats', scope: 'stats:read', about: 'Grouped counts. by=day|week|month|year|category|type|source.' },
      { method: 'GET', path: '/api/v1/deadlines', scope: 'deadlines:read', about: 'Deadlines with days left, days late and the note behind each. status=open|done|all, due_before, due_after.' },
      { method: 'GET', path: '/api/v1/deadlines/{id}', scope: 'deadlines:read', about: 'One deadline.' },
      { method: 'GET', path: '/api/v1/categories', scope: 'notes:read', about: 'The categories: id, label, order.' },
      { method: 'GET', path: '/api/v1/export', scope: 'notes:read', about: 'A range as json, csv or md. Same time filters as notes.' },
    ],
    errors: ['unauthorized', 'forbidden', 'bad_filter', 'bad_cursor', 'not_found', 'method', 'rate_limited', 'too_many', 'setup', 'upstream'],
    envelope: { ok: true, meta: { version: API_VERSION, timeZone: tz, count: 0, next: null } },
  };
}

/* ---------- Router ---------- */

const ID = /^[A-Za-z0-9-]{8,64}$/;

export async function publicApi(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tz = env.DIARY_TZ || 'UTC';
    if (url.pathname === '/api/v1' || url.pathname === '/api/v1/') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new Problem(405, 'method', 'The API is read-only.', { Allow: 'GET, HEAD' });
      }
      return apiJson(describe(tz));
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new Problem(405, 'method', 'The API is read-only.', { Allow: 'GET, HEAD' });
    }

    const { key, rate } = await authenticate(request, env);
    const today = localDay(new Date(), tz);
    const ctx: Ctx = { env, key, tz, today, rate };
    const path = url.pathname;

    if (path === '/api/v1/me') {
      return apiJson({
        ok: true,
        meta: meta(ctx),
        key: {
          name: key.name,
          prefix: key.prefix,
          scopes: key.scopes,
          perMinute: key.perMinute,
          perDay: key.perDay,
          lastUsedAt: key.lastUsedAt,
          expiresAt: key.expiresAt,
        },
      }, 200, rateHeaders(rate));
    }
    if (path === '/api/v1/notes') return await listNotes(ctx, url);
    if (path === '/api/v1/days') return await days(ctx, url);
    if (path === '/api/v1/stats') return await stats(ctx, url);
    if (path === '/api/v1/categories') return await categories(ctx);
    if (path === '/api/v1/deadlines') return await deadlines(ctx, url);
    if (path === '/api/v1/export') return await exportNotes(ctx, url);

    const note = /^\/api\/v1\/notes\/([^/]+)$/.exec(path);
    if (note) {
      if (!ID.test(note[1])) throw new Problem(400, 'bad_filter', 'That note id is not one this diary issued.');
      return await oneNote(ctx, note[1]);
    }
    const deadline = /^\/api\/v1\/deadlines\/([^/]+)$/.exec(path);
    if (deadline) {
      if (!ID.test(deadline[1])) throw new Problem(400, 'bad_filter', 'That deadline id is not one this diary issued.');
      return await oneDeadline(ctx, deadline[1]);
    }

    throw new Problem(404, 'not_found', `No endpoint at ${path.slice(0, 80)}. Start at /api/v1.`);
  } catch (err) {
    if (err instanceof Problem) return apiFail(err.status, err.code, err.message, err.extra);
    console.error('public api failed', err);
    return apiFail(502, 'upstream', 'The diary could not answer that.');
  }
}

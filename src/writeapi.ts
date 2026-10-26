// The write half of /api/v1: another app filing notes into the diary.
//
// A note written here is the same thing a note sent to the bot is — a capture holding exactly
// what arrived, then one thought, and a reminder when the note is a deadline — so an entry
// from Claude Code sits in the same day page, with the same cleanup, as one typed on a phone.
// What is different is the answer. The caller is a program, so it gets a receipt: per note,
// what was stored, what the cleanup did, and what it cost. The owner gets the same receipt on
// Telegram, which is what makes an unattended write something they can check at a glance.
//
// Three properties this file is built around.
// A retry cannot file a note twice: the capture's uniqueness (source, source_update_id) is
// derived from the caller's Idempotency-Key, and the request is answered with the receipt of
// the first one.
// A write key cannot read. Nothing here answers with a note the caller did not just write;
// the read endpoints are refused separately, by scope.
// A failed cleanup, reminder or acknowledgement never costs the note. The raw text is stored
// first and the receipt says out loud which part went wrong.

import { UI_CATEGORIES, isDay } from './api';
import { MODES, type Category, type Mode } from './parse';
import { MAX_INPUT_CHARS, cleanNote, type CleanupKind, type Refiner } from './refine';
import { localDay, storedPreview, type ExistingCapture, type Store, type WrittenNote } from './handler';
import { hasScope } from './apikey';
import { reminderTimes } from './reminders';
import type { KeyPolicy, KeySession } from './publicapi';

// One request carries a session's worth of notes, not an export. The ceilings are here rather
// than in the database so the refusal happens before anything is written.
export const MAX_NOTES = 25;
export const MAX_BATCH_CHARS = 40000;
const MAX_DEDUPE = 200;
const CLIENT_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// What a caller asked for, validated and resolved: the day and the moment are worked out here
// so nothing downstream has to know the diary's timezone.
export interface WriteNote {
  text: string;
  category: Category;
  categorySource: 'tag' | 'auto';
  mode: Mode;
  day: string;
  at: string;
  due: string | null;
}

export interface WriteInput {
  notes: WriteNote[];
  client: string;
  dedupeKey: string | null;
  ack: boolean;
}

export type WriteProblem = { code: string; message: string };
export type WriteResult = WriteInput | { problem: WriteProblem };

const bad = (code: string, message: string): WriteResult => ({ problem: { code, message } });
export const isProblem = (r: WriteResult): r is { problem: WriteProblem } => 'problem' in r;

/* ---------- What arrived ---------- */

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The whole request, checked until there is nothing left to interpret. Every refusal names the
// thing to fix, because the caller reading it is a model that will otherwise guess.
export function normaliseWrite(body: unknown, opts: { timeZone: string; now: Date; headerKey?: string | null }): WriteResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return bad('bad_note', 'Send JSON: { "notes": [ { "text": "..." } ] }');
  }
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.notes) || raw.notes.length === 0) {
    return bad('bad_note', 'notes is a list holding at least one note.');
  }
  if (raw.notes.length > MAX_NOTES) {
    return bad('too_many', `One request carries up to ${MAX_NOTES} notes; that one holds ${raw.notes.length}. Send them over two requests.`);
  }

  const client = raw.client === undefined || raw.client === null ? 'api' : raw.client;
  if (typeof client !== 'string' || !CLIENT_SHAPE.test(client)) {
    return bad('bad_note', 'client is a short name for the sending app, like "claude-code".');
  }

  const bodyKey = raw.idempotencyKey;
  if (bodyKey !== undefined && bodyKey !== null && typeof bodyKey !== 'string') {
    return bad('bad_note', 'idempotencyKey is a string: the same one on a retry means the notes are already stored.');
  }
  const dedupeKey = (typeof bodyKey === 'string' && bodyKey !== '' ? bodyKey : opts.headerKey) || null;
  if (dedupeKey !== null && (dedupeKey.length > MAX_DEDUPE || !/^[\x20-\x7e]+$/.test(dedupeKey))) {
    return bad('bad_note', `An Idempotency-Key is up to ${MAX_DEDUPE} printable characters.`);
  }

  if (raw.ack !== undefined && typeof raw.ack !== 'boolean') {
    return bad('bad_note', 'ack is true or false: whether the diary should confirm this on Telegram.');
  }

  const today = localDay(opts.now, opts.timeZone);
  const latest = addDays(today, 1); // a day of slack for a clock in another timezone
  const notes: WriteNote[] = [];
  let chars = 0;

  for (const item of raw.notes) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return bad('bad_note', 'Every note is an object with a text field.');
    }
    const n = item as Record<string, unknown>;

    const text = typeof n.text === 'string' ? n.text.trim() : '';
    if (!text) return bad('bad_note', 'Every note needs text.');
    if (text.length > MAX_INPUT_CHARS) {
      return bad('too_many', `A note is up to ${MAX_INPUT_CHARS} characters; that one is ${text.length}. Split it in two.`);
    }
    chars += text.length;
    if (chars > MAX_BATCH_CHARS) {
      return bad('too_many', `One request carries up to ${MAX_BATCH_CHARS} characters of notes. Send this session as two requests.`);
    }

    const asked = n.category === undefined || n.category === null ? 'inbox' : n.category;
    if (typeof asked !== 'string' || !(UI_CATEGORIES as readonly string[]).includes(asked)) {
      return bad('bad_note', `Unknown category: ${String(asked).slice(0, 40)}. The categories are ${UI_CATEGORIES.join(', ')}.`);
    }
    const category = asked as Category;

    const mode = n.mode === undefined || n.mode === null ? 'refine' : n.mode;
    if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
      return bad('bad_note', `Unknown mode: ${String(mode).slice(0, 40)}. The modes are ${MODES.join(', ')}.`);
    }

    if (n.day !== undefined && n.day !== null && (typeof n.day !== 'string' || !isDay(n.day))) {
      return bad('bad_note', 'day must be a real date, like 2026-10-26.');
    }
    let at = opts.now;
    if (n.at !== undefined && n.at !== null) {
      if (typeof n.at !== 'string' || Number.isNaN(Date.parse(n.at))) {
        return bad('bad_note', 'at must be a timestamp, like 2026-10-26T21:40:00Z.');
      }
      at = new Date(n.at);
    }
    const day = typeof n.day === 'string' ? n.day : localDay(at, opts.timeZone);
    // The pair has to agree: a note stamped 23:50 that claims to belong to yesterday would be
    // filed on one day and shown at another time on it.
    if (typeof n.day === 'string' && localDay(at, opts.timeZone) !== n.day) {
      return bad('bad_note', `day ${n.day} and at ${at.toISOString()} disagree in the diary's timezone.`);
    }
    if (day < '2000-01-01' || day > latest) {
      return bad('bad_note', `day must be between 2000-01-01 and ${latest}.`);
    }

    if (n.due !== undefined && n.due !== null && (typeof n.due !== 'string' || !isDay(n.due))) {
      return bad('bad_note', 'due must be a real date, like 2026-10-30.');
    }
    const due = typeof n.due === 'string' ? n.due : null;
    if (due && category !== 'deadline') {
      return bad('bad_note', 'due only means something on a deadline note: set category to deadline too.');
    }
    if (category === 'deadline' && !due) {
      return bad('bad_note', 'A deadline needs a due date. Add "due": "2026-10-30".');
    }

    notes.push({
      text,
      category,
      categorySource: typeof n.category === 'string' ? 'tag' : 'auto',
      mode: mode as Mode,
      day,
      at: at.toISOString(),
      due,
    });
  }

  return { notes, client, dedupeKey, ack: raw.ack === undefined ? true : raw.ack };
}

// The limits a key carries decide what it may file. A key limited to work cannot write a life
// note, exactly as it cannot read one: the two directions of the same promise.
export function writeRefusal(policy: KeyPolicy, note: WriteNote): string | null {
  if (policy.categories && !policy.categories.includes(note.category)) {
    return `This key cannot write into ${note.category}: it is limited to ${policy.categories.join(', ')}.`;
  }
  if (policy.from && note.day < policy.from) return `This key cannot write a note dated before ${policy.from}.`;
  if (policy.to && note.day > policy.to) return `This key cannot write a note dated after ${policy.to}.`;
  return null;
}

/* ---------- The receipt ---------- */

export interface ReceiptNote {
  id: string | null;
  day: string;
  category: string;
  mode: string;
  status: 'stored' | 'duplicate' | 'failed';
  cleanup: CleanupKind | 'duplicate';
  words: number;
  error: string | null;
}

export interface Receipt {
  code: string;
  duplicate: boolean;
  notes: ReceiptNote[];
  counts: { notes: number; words: number; byCategory: Record<string, number> };
  reminders: { due: string; firstPingAt: string; set: boolean }[];
  usage: { tokensIn: number | null; tokensOut: number | null; models: string[] };
  telegram: 'sent' | 'failed' | 'skipped';
  // The line the owner's phone showed, so the caller can see what was confirmed rather than
  // only that something was.
  preview: string | null;
}

export interface WriteDeps {
  store: Store;
  refiner?: Refiner;
  notify?: (text: string) => Promise<boolean>;
  timeZone: string;
}

export type WriteOutcome =
  | { ok: true; receipt: Receipt }
  | { ok: false; status: number; code: string; message: string };

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

// The id the capture's uniqueness runs on. With an Idempotency-Key it is a digest of the key's
// own id, that key and the note's place in the batch, so a retry lands on the same row and the
// note is stored once — the same mechanism the bot gets from Telegram's update_id. The key id
// is in the seed so two apps cannot dedupe each other by happening to use the same words.
async function seedFor(keyId: string, dedupeKey: string, index: number): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${keyId}|${dedupeKey}|${index}`));
  const bytes = new Uint8Array(digest);
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + bytes[i]; // 48 bits: exact in a number, inside bigint
  return n;
}

// The code on the receipt, and on the Telegram message that says the same thing. Derived from
// the idempotency key when there is one, so a retry answers with the receipt the owner already
// saw rather than a second one they cannot match to anything.
async function receiptCode(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return `rc_${[...new Uint8Array(digest)].slice(0, 3).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const titleCase = (slug: string) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function dayLabel(days: string[], timeZone: string): string {
  const format = (day: string) =>
    new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(new Date(`${day}T12:00:00Z`));
  const sorted = [...new Set(days)].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return first === last ? format(first) : `${format(first)}–${format(last)}`;
}

// What the phone shows. Three or four short lines: who wrote, how much and where, the first
// note in the words the diary stored, and the receipt code that ties it to the API's answer.
export function ackMessage(receipt: Receipt, client: string, timeZone: string): string {
  const stored = receipt.notes.filter((n) => n.status === 'stored');
  const who = client === 'api' ? 'An app' : titleCase(client);
  const lines = [`${who} filed ${stored.length} note${stored.length === 1 ? '' : 's'} · ${dayLabel(stored.map((n) => n.day), timeZone)}`];
  const tally = Object.entries(receipt.counts.byCategory).map(([c, n]) => `${c} ${n}`).join(' · ');
  const deadline = receipt.reminders.length
    ? ` · ${receipt.reminders.length} deadline${receipt.reminders.length === 1 ? '' : 's'} (first ping ${dayLabel(receipt.reminders.map((r) => r.due), timeZone)})`
    : '';
  lines.push(`${tally}${deadline}`);
  if (receipt.preview) lines.push(`· ${receipt.preview}`);
  lines.push(`Receipt ${receipt.code}`);
  return lines.join('\n');
}

/* ---------- The write ---------- */

// One note becomes one capture, then one thought: the same rows the bot writes, in the same
// order, so a failure anywhere after the capture still leaves what was typed.
export async function writeNotes(deps: WriteDeps, key: KeySession, input: WriteInput): Promise<WriteOutcome> {
  if (!hasScope(key.scopes, 'notes:write')) {
    return { ok: false, status: 403, code: 'forbidden', message: 'This key cannot add notes: it needs the notes:write scope.' };
  }
  for (const note of input.notes) {
    const refusal = writeRefusal(key.policy, note);
    if (refusal) return { ok: false, status: 403, code: 'out_of_policy', message: refusal };
  }
  const { store } = deps;
  if (!store.findCaptures || !store.writtenNotes) {
    return { ok: false, status: 503, code: 'setup', message: 'This build cannot file notes from another app.' };
  }

  const now = new Date();
  // Without a key every request is its own row, which is what a caller that wants a retry to be
  // a no-op has to ask for. The millisecond stamp plus a random tail cannot collide with it.
  const seeds = input.dedupeKey
    ? await Promise.all(input.notes.map((_, i) => seedFor(key.id, input.dedupeKey!, i)))
    : input.notes.map((_, i) => Date.now() * 1000 + Math.floor(Math.random() * 1000) + i);
  const code = await receiptCode(input.dedupeKey ? `${key.id}|${input.dedupeKey}` : `${key.id}|${seeds[0]}`);

  let already: ExistingCapture[] = [];
  try {
    already = await store.findCaptures('api', seeds);
  } catch {
    return { ok: false, status: 502, code: 'upstream', message: 'The diary database did not answer.' };
  }
  const seen = new Map(already.map((c) => [c.sourceUpdateId, c.id]));

  const captureAt = new Map<number, string>();
  const cleanupAt = new Map<number, { cleanup: CleanupKind; tokensIn: number | null; tokensOut: number | null; model: string | null }>();
  const reminders: Receipt['reminders'] = [];
  const notes: ReceiptNote[] = [];
  const failures: string[] = [];
  let stored = 0;

  for (const [i, note] of input.notes.entries()) {
    const seed = seeds[i];
    const existing = seen.get(seed);
    if (existing) {
      captureAt.set(i, existing);
      notes.push({ id: null, day: note.day, category: note.category, mode: note.mode, status: 'duplicate', cleanup: 'duplicate', words: words(note.text), error: null });
      continue;
    }
    try {
      const capture = await store.insertCapture({
        update_id: seed,
        chat_id: 0,
        raw_text: note.text,
        mode: note.mode,
        category: note.categorySource === 'tag' ? note.category : null,
        status: 'received',
        source: 'api',
        client: input.client,
        dedupeKey: input.dedupeKey,
      });
      if (!capture.inserted || !capture.id) continue; // another request got there first
      captureAt.set(i, capture.id);

      const cleaned = await cleanNote(deps.refiner, { text: note.text, mode: note.mode, category: note.category });
      cleanupAt.set(i, { cleanup: cleaned.cleanup, tokensIn: cleaned.tokensIn, tokensOut: cleaned.tokensOut, model: cleaned.model });
      await store.insertThought({
        capture_id: capture.id,
        day: note.day,
        captured_at: note.at,
        category: note.category,
        category_source: note.categorySource,
        mode: note.mode,
        clean_text: cleaned.clean,
        raw_text: note.text,
        tokens_in: cleaned.tokensIn,
        tokens_out: cleaned.tokensOut,
        cleanup_model: cleaned.model,
      });

      // A deadline gets the ping the composer would set: three days before the due date, or now
      // when that day has already passed. A reminder that fails is reported; the note stays.
      let reminderSet = false;
      let reminderError: string | null = null;
      if (note.due) {
        const { dueAt, next } = reminderTimes(note.due, now);
        if (store.insertReminder) {
          try {
            await store.insertReminder({
              captureId: capture.id,
              thoughtId: null,
              kind: 'deadline',
              title: cleaned.clean.slice(0, 140),
              dueAt: dueAt.toISOString(),
              nextRemindAt: next.toISOString(),
              source: 'explicit',
            });
            reminderSet = true;
          } catch (err) {
            reminderError = err instanceof Error ? err.message.split('\n')[0].slice(0, 160) : 'unknown error';
            console.error('api reminder insert failed', err);
          }
        }
        reminders.push({ due: note.due, firstPingAt: next.toISOString(), set: reminderSet });
      }

      await store.setCaptureStatus(capture.id, 'done', cleaned.error ?? reminderError ?? undefined);
      stored++;
      notes.push({
        id: capture.id,
        day: note.day,
        category: note.category,
        mode: note.mode,
        status: 'stored',
        cleanup: cleaned.cleanup,
        words: words(cleaned.clean),
        error: cleaned.error,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'unknown error';
      failures.push(reason);
      console.error('api note failed', err);
      notes.push({ id: null, day: note.day, category: note.category, mode: note.mode, status: 'failed', cleanup: 'failed', words: 0, error: reason });
    }
  }

  const byCategory: Record<string, number> = {};
  for (const n of notes) if (n.status === 'stored') byCategory[n.category] = (byCategory[n.category] ?? 0) + 1;

  const receipt: Receipt = {
    code,
    duplicate: stored === 0 && notes.some((n) => n.status === 'duplicate'),
    notes,
    counts: {
      notes: stored,
      words: notes.filter((n) => n.status === 'stored').reduce((sum, n) => sum + n.words, 0),
      byCategory,
    },
    reminders,
    usage: {
      tokensIn: sum(cleanupAt, 'tokensIn'),
      tokensOut: sum(cleanupAt, 'tokensOut'),
      models: [...new Set([...cleanupAt.values()].map((c) => c.model).filter((m): m is string => Boolean(m)))],
    },
    telegram: 'skipped',
    preview: null,
  };

  if (stored === 0 && failures.length) {
    return { ok: false, status: 502, code: 'upstream', message: `Nothing was stored. ${failures[0]}` };
  }

  // What the diary actually holds, read back once for both halves of the receipt: a retry needs
  // the ids of the notes the first request filed, and the acknowledgement needs the words that
  // were stored rather than the ones that were sent.
  const read = await store.writtenNotes([...captureAt.values()]).catch(() => [] as WrittenNote[]);
  const byCapture = new Map(read.map((r) => [r.captureId, r]));
  for (const [i, captureId] of captureAt) {
    const note = notes.find((_, index) => index === i);
    const row = byCapture.get(captureId);
    if (note && row && note.status === 'duplicate') {
      note.id = row.id;
      note.words = words(row.text);
    }
  }

  // The acknowledgement is the owner's half of the receipt. A retry that stored nothing is
  // answered silently: they have seen that message already. A failed send is reported, never
  // fatal — the notes are in the diary either way.
  if (input.ack && stored > 0 && deps.notify) {
    const first = read
      .filter((r) => notes.some((n, index) => n.status === 'stored' && captureAt.get(index) === r.captureId))
      .sort((a, b) => a.at.localeCompare(b.at))[0];
    if (first) receipt.preview = storedPreview(first.text);
    receipt.telegram = (await deps.notify(ackMessage(receipt, input.client, deps.timeZone))) ? 'sent' : 'failed';
  }

  return { ok: true, receipt };
}

// The totals across the notes of one request. A model that reported no usage leaves the total
// null rather than zero: a zero reads as "this was free", which is a figure the page would
// then draw.
function sum(map: Map<number, { tokensIn: number | null; tokensOut: number | null }>, field: 'tokensIn' | 'tokensOut'): number | null {
  const values = [...map.values()].map((v) => v[field]).filter((v): v is number => v !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

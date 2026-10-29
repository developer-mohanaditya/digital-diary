import { parseCommand, type Category, type Mode } from './parse';
import { parseTimeZoneCommand } from './timezone';
import { detectReminder, type DetectedReminder } from './reminders';
import type { Refiner } from './refine';
import type { SummaryNote, SummaryReminder } from './summary';
import {
  failedMessage, healthMessage, notSavedCategory, notSavedCommand, notSavedEmpty, notSavedMode,
  notSavedVoice, recleanedMessage, savedMessage, startMessage, timezoneRefusedMessage,
  timezoneSetMessage, timezoneShownMessage, type SaveState,
} from './receipts';

// Telegram update shape (only the fields we use).
export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; date: number; text?: string; chat: { id: number } };
}

export interface CaptureInput {
  update_id: number;
  chat_id: number;
  raw_text: string;
  mode: Mode | null;
  category: Category | null;
  status: 'received';
  // An API write is a capture too, and these say where it came from. Telegram and the page
  // leave them out, so their rows are unchanged.
  source?: 'telegram' | 'web' | 'api';
  client?: string | null;    // the app that sent an API write: "claude-code", "codex"
  dedupeKey?: string | null; // the caller's Idempotency-Key, kept for the retry lookup
}

export interface ThoughtInput {
  capture_id: string;
  day: string;          // YYYY-MM-DD in the diary's timezone
  captured_at: string;  // ISO timestamp
  category: Category;
  category_source: 'tag' | 'auto';
  mode: Mode;
  clean_text: string;
  raw_text: string;
  // Recorded from the cleanup, so the web page can show what a note cost instead of
  // inventing a figure. Absent for verbatim notes and for anything older than 0006.
  tokens_in?: number | null;
  tokens_out?: number | null;
  cleanup_model?: string | null;
  // How long the cleanup took (0012). Absent for verbatim notes, for a build with no refiner,
  // and for anything older than the column — the page shows nothing rather than a zero.
  cleanup_ms?: number | null;
}

// Storage and reply ports. The Supabase and Telegram adapters implement these.
export interface ReminderInput {
  captureId: string;
  thoughtId: string | null;
  kind: 'deadline' | 'review';
  title: string;
  dueAt: string | null;
  nextRemindAt: string;
  source: 'explicit' | 'heuristic' | 'ai';
}

// Result of the /heartbeat database round-trip: reads plus one heartbeat write.
export interface HealthStats {
  captures: number;
  thoughts: number;
  todayThoughts: number;
  pendingReminders: number;
  lastCaptureAt: string | null;
  heartbeatOk: boolean;
}

// What the write API reads back to answer a caller: the captures it already made for a retried
// request, and the notes those captures hold. Both are optional — a store without them simply
// cannot file API notes, and nothing else has to know.
export interface ExistingCapture {
  id: string;
  sourceUpdateId: number;
}

export interface WrittenNote {
  id: string;
  captureId: string;
  day: string;
  category: string;
  mode: string;
  text: string;
  at: string;
  tokensIn: number | null;
  tokensOut: number | null;
  model: string | null;
}

export interface Store {
  insertCapture(c: CaptureInput): Promise<{ inserted: boolean; id?: string }>;
  insertThought(t: ThoughtInput): Promise<void>;
  insertReminder?(r: ReminderInput): Promise<void>;
  listDueReminders?(nowIso: string): Promise<{ id: string; kind: string; title: string; due_at: string | null; snooze_count?: number }[]>;
  markReminderDone?(id: string): Promise<void>;
  snoozeReminder?(id: string, nextIso: string): Promise<void>;
  // The optional note is what the row is labelled with in the database: the cron's beat writes
  // 'cron', the on-demand check keeps its own mark. Passing it keeps one beat to one row.
  health?(day: string, note?: string): Promise<HealthStats>;
  // The cron's keep-alive write: one heartbeat row, confirmed on Telegram as it is made.
  // Optional, so a store without it simply never beats instead of failing the schedule.
  beat?(note: string): Promise<void>;
  // The beat's marker: the slot that has already been beaten, e.g. "2026-10-27T12:30". Optional
  // like the rest — and a store without it never beats, rather than beating twice.
  heartbeatMark?(): Promise<string | null>;
  markHeartbeat?(slot: string): Promise<void>;
  // The 10pm summary. Optional, so a store without them has no summary instead of a
  // failing cron.
  dayNotes?(day: string): Promise<SummaryNote[]>;
  openReminders?(limit: number): Promise<SummaryReminder[]>;
  summarySentOn?(): Promise<string | null>;
  markSummarySent?(day: string): Promise<void>;
  findCaptures?(source: 'api', sourceUpdateIds: number[]): Promise<ExistingCapture[]>;
  writtenNotes?(captureIds: string[]): Promise<WrittenNote[]>;
  setCaptureStatus(id: string, status: 'done' | 'failed', error?: string): Promise<void>;
  getTimeZone(): Promise<string | null>;
  setTimeZone(zone: string): Promise<void>;
}
export interface Notifier {
  reply(chatId: number, text: string): Promise<void>;
  remind?(chatId: number, reminderId: string, text: string): Promise<void>;
  // "typing…", shown while a note is being cleaned and stored. Optional, so a notifier without
  // it is simply never told that work is in progress.
  typing?(chatId: number): Promise<void>;
}

// The one-time repair: re-run the cleanup over notes an earlier, broken model left with
// clean_text identical to raw_text. Kept behind a port so the handler can offer it as a
// command without knowing about Supabase or Workers AI.
export interface RepairResult {
  scanned: number;
  cleaned: number;
  failed: string[];
}
export interface Repairer {
  repair(limit: number): Promise<RepairResult>;
}

export interface Settings {
  allowedChatId: number;
  timeZone: string;
}

export type Outcome = 'saved' | 'rejected' | 'duplicate' | 'ignored';

// Local calendar day (YYYY-MM-DD) for a timestamp in the given IANA timezone.
export function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Messages that are instructions rather than notes: they get a reply and never touch the
// database, so the diary cannot fill up with /start and /heartbeat rows. A bare slash word is
// treated the same way, because a mistyped command is not a diary entry either.
export function isInstruction(text: string): boolean {
  return /^\s*\/[A-Za-z][\w]*\s*$/.test(text);
}

/**
 * Handles one Telegram update. The raw capture is stored before anything else,
 * so a failure afterwards never loses the input. Storage errors are rethrown so the
 * webhook can return a non-200 and Telegram will retry the update.
 */
export async function handleUpdate(
  update: TelegramUpdate,
  store: Store,
  notifier: Notifier,
  settings: Settings,
  now: Date = new Date(),
  refiner?: Refiner,
  repairer?: Repairer,
): Promise<Outcome> {
  const msg = update.message;
  if (!msg || msg.chat.id !== settings.allowedChatId) return 'ignored';
  if (msg.text === undefined) {
    await notifier.reply(msg.chat.id, notSavedVoice());
    return 'ignored';
  }

  if (msg.text.trim().split(/\s/)[0].split('@')[0] === '/start') {
    await notifier.reply(msg.chat.id, startMessage());
    return 'ignored';
  }

  // /heartbeat: read a few counts and write one heartbeat, then report them. It is never
  // stored as a diary entry: the reply is the whole point, and a failure is replied
  // with the real error instead of a silent 500.
  if (msg.text.trim().split(/\s/)[0].split('@')[0] === '/heartbeat') {
    // Everything, the timezone read included, sits inside the try: a diagnostic that
    // dies silently is worse than no diagnostic at all.
    let tz = settings.timeZone;
    try {
      if (!store.health) throw new Error('database check is not available in this build');
      tz = (await store.getTimeZone()) ?? settings.timeZone;
      const stats = await store.health(localDay(now, tz));
      await notifier.reply(msg.chat.id, healthMessage(stats, tz, now));
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'unknown error';
      await notifier.reply(msg.chat.id, failedMessage('Database check failed', reason));
    }
    return 'ignored';
  }

  // /reclean re-runs the cleanup over notes an earlier model left untouched. It is the
  // repair path for history, not something the normal flow needs, and it writes only
  // clean_text: the raw text of every note is left exactly as it was.
  if (msg.text.trim().split(/\s/)[0].split('@')[0] === '/reclean') {
    if (!repairer) {
      await notifier.reply(msg.chat.id, failedMessage('Re-clean is not available', 'This build has no repair bound.', 'Nothing was changed.'));
      return 'ignored';
    }
    const asked = Number(msg.text.trim().split(/\s+/)[1]);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 25) : 5;
    try {
      const result = await repairer.repair(limit);
      await notifier.reply(msg.chat.id, recleanedMessage(result));
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'unknown error';
      await notifier.reply(msg.chat.id, failedMessage('Re-clean failed', reason));
    }
    return 'ignored';
  }

  // The timezone command is an instruction, not a note: it is answered before anything
  // is written, so "set my timezone" never shows up in the diary.
  const tzCommand = parseTimeZoneCommand(msg.text);
  if (tzCommand) {
    const current = (await store.getTimeZone()) ?? settings.timeZone;
    if (tzCommand.kind === 'show') {
      await notifier.reply(msg.chat.id, timezoneShownMessage(current));
    } else if (tzCommand.kind === 'invalid') {
      await notifier.reply(msg.chat.id, timezoneRefusedMessage(tzCommand.input));
    } else {
      await store.setTimeZone(tzCommand.zone);
      await notifier.reply(msg.chat.id, timezoneSetMessage(tzCommand.zone));
    }
    return 'saved';
  }

  // A bare slash word (/push, /work, /nonsense) or an empty message is not a note.
  // Nothing is captured, and the reply says so, because a row in the diary that only
  // says "/start" is noise the owner has to clean up by hand later.
  if (msg.text.trim() === '' || isInstruction(msg.text)) {
    await notifier.reply(msg.chat.id, notSavedCommand());
    return 'rejected';
  }

  const parsed = parseCommand(msg.text);
  if (!parsed.ok) {
    const text =
      parsed.error === 'empty' ? notSavedEmpty()
      : parsed.error === 'conflict_mode' ? notSavedMode(parsed.options)
      : notSavedCategory(parsed.options);
    await notifier.reply(msg.chat.id, text);
    return 'rejected';
  }

  // Only now, with a real note in hand, is anything written to the database.
  const capture = await store.insertCapture({
    update_id: update.update_id,
    chat_id: msg.chat.id,
    raw_text: msg.text,
    mode: parsed.mode,
    category: parsed.category,
    status: 'received',
  });
  if (!capture.inserted || !capture.id) return 'duplicate';

  // Deadlines + reviews: detect from explicit /deadline, due-words, or review phrases.
  // Heuristic now, AI upgrade later without schema change.
  const tz = (await store.getTimeZone()) ?? settings.timeZone;
  const detected: DetectedReminder | null = detectReminder(msg.text, now, tz);
  const category: Category = detected?.categoryHint ?? parsed.category ?? 'inbox';

  // Cleanup. The raw text is what gets stored alongside the result, so a model that
  // fails or answers with nothing at all costs a tidy line, never the note.
  let clean = parsed.body;
  let refineError: string | null = null;
  let usage: { tokensIn: number | null; tokensOut: number | null; model: string | null; ms: number | null } =
    { tokensIn: null, tokensOut: null, model: null, ms: null };
  if (refiner && parsed.mode !== 'verbatim') {
    const started = Date.now();
    try {
      const out = await refiner.refine({ text: parsed.body, mode: parsed.mode, category });
      const ms = Date.now() - started;
      if (out) {
        clean = out.text;
        usage = { tokensIn: out.tokensIn, tokensOut: out.tokensOut, model: out.model, ms };
      } else {
        usage.ms = ms;
      }
    } catch (err) {
      // Timed even when the cleanup failed: the reply says what went wrong, and the row says how
      // long the attempt cost the owner.
      usage.ms = Date.now() - started;
      // The message goes into the reply: a failed cleanup that reports only "failed"
      // leaves the owner with no way to tell a missing model from a missing binding.
      refineError = err instanceof Error ? err.message.split('\n')[0].slice(0, 160) : 'unknown error';
      console.error('refine failed', err);
    }
  }

  await store.insertThought({
    capture_id: capture.id,
    day: localDay(now, tz),
    captured_at: new Date(msg.date * 1000).toISOString(),
    category,
    category_source: parsed.categorySource === 'tag' ? 'tag' : detected ? 'auto' : 'auto',
    mode: parsed.mode,
    clean_text: clean,
    raw_text: parsed.body,
    tokens_in: usage.tokensIn,
    tokens_out: usage.tokensOut,
    cleanup_model: usage.model,
    cleanup_ms: usage.ms,
  });
  if (detected && store.insertReminder) {
    try {
      await store.insertReminder({
        captureId: capture.id,
        thoughtId: null,
        kind: detected.kind,
        title: detected.title,
        dueAt: detected.dueAt,
        nextRemindAt: detected.nextRemindAt,
        source: detected.source,
      });
    } catch (err) {
      console.error('reminder insert failed', err);
    }
  }
  // A cleanup failure is kept next to the capture as well as in the reply: the reply is
  // only seen once, and the reason is what makes the next fix possible.
  await store.setCaptureStatus(capture.id, 'done', refineError ?? undefined);
  // One shape for every save: the verdict, the note as stored, and what the wait cost. A
  // cleanup that failed is said on the fact line, because the note is stored either way.
  const ran = Boolean(refiner) && parsed.mode !== 'verbatim';
  const state: SaveState = refineError ? 'failed'
    : parsed.mode === 'verbatim' ? 'verbatim'
    : !ran ? 'unavailable'
    : clean === parsed.body ? 'unchanged' : 'formatted';
  await notifier.reply(msg.chat.id, savedMessage({
    category,
    note: clean,
    state,
    error: refineError,
    ms: usage.ms,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    model: usage.model,
    due: detected?.dueAt ? localDay(new Date(detected.dueAt), tz) : null,
  }));
  return 'saved';
}

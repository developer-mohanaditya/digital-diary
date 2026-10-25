import { parseCommand, type Category, type Mode } from './parse';
import { parseTimeZoneCommand } from './timezone';
import { detectReminder, type DetectedReminder } from './reminders';
import type { Refiner } from './refine';
import type { SummaryNote, SummaryReminder } from './summary';

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

export interface Store {
  insertCapture(c: CaptureInput): Promise<{ inserted: boolean; id?: string }>;
  insertThought(t: ThoughtInput): Promise<void>;
  insertReminder?(r: ReminderInput): Promise<void>;
  listDueReminders?(nowIso: string): Promise<{ id: string; kind: string; title: string; due_at: string | null; snooze_count?: number }[]>;
  markReminderDone?(id: string): Promise<void>;
  snoozeReminder?(id: string, nextIso: string): Promise<void>;
  health?(day: string): Promise<HealthStats>;
  // The 10pm summary. Optional, so a store without them has no summary instead of a
  // failing cron.
  dayNotes?(day: string): Promise<SummaryNote[]>;
  openReminders?(limit: number): Promise<SummaryReminder[]>;
  summarySentOn?(): Promise<string | null>;
  markSummarySent?(day: string): Promise<void>;
  setCaptureStatus(id: string, status: 'done' | 'failed', error?: string): Promise<void>;
  getTimeZone(): Promise<string | null>;
  setTimeZone(zone: string): Promise<void>;
}
export interface Notifier {
  reply(chatId: number, text: string): Promise<void>;
  remind?(chatId: number, reminderId: string, text: string): Promise<void>;
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

export function repairLine(r: RepairResult): string {
  if (r.scanned === 0) return 'Nothing to re-clean: every note has a formatted version already.';
  const head = `Re-cleaned ${r.cleaned} of ${r.scanned} untouched note${r.scanned === 1 ? '' : 's'}.`;
  return r.failed.length ? `${head}\nFailed: ${r.failed.slice(0, 3).join('; ')}` : head;
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

// The /heartbeat reply: what the database actually holds, so a silent bot is distinguishable
// from an empty database.
export function formatHealth(stats: HealthStats, timeZone: string): string {
  const last = stats.lastCaptureAt
    ? new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(stats.lastCaptureAt))
    : null;
  return [
    'Database ok.',
    `Entries ${stats.thoughts} (${stats.todayThoughts} today)`,
    `Messages captured ${stats.captures}`,
    `Reminders pending ${stats.pendingReminders}`,
    last ? `Last note ${last} (${timeZone})` : 'Last note: none yet',
    stats.heartbeatOk ? 'Heartbeat written.' : 'Heartbeat not written.',
  ].join('\n');
}

// The reply preview: enough of the stored note to recognise it on a phone, flattened to
// one line, with three dots marking where it was cut.
export const PREVIEW_CHARS = 180;

export function storedPreview(text: string, limit = PREVIEW_CHARS): string {
  const flat = text
    .replace(/\*\*|==/g, '')
    .replace(/^\s*[-\u2022]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}...` : flat;
}

export interface CleanupReport {
  raw: string;
  clean: string;
  mode: Mode;
  error: string | null;
  ran: boolean; // false when there was no refiner at all: not the same as "no change"
}

// What the cleanup did, in one line. A missing model must never read as a successful
// cleanup that found nothing to do, which is exactly how the bug hid the first time.
export function cleanupLine(r: CleanupReport): string {
  if (r.error) return `Cleanup failed (${r.error}), saved as written.`;
  if (r.mode === 'verbatim') return 'Saved as written, no cleanup.';
  if (!r.ran) return 'Cleanup unavailable, saved as written.';
  if (r.clean === r.raw) return 'Cleaned up, no change needed.';
  return `Formatted, ${r.raw.length} -> ${r.clean.length} characters.`;
}

// Messages that are instructions rather than notes: they get a reply and never touch the
// database, so the diary cannot fill up with /start and /heartbeat rows. A bare slash word is
// treated the same way, because a mistyped command is not a diary entry either.
export function isInstruction(text: string): boolean {
  return /^\s*\/[A-Za-z][\w]*\s*$/.test(text);
}

const CATEGORY_LABEL: Record<Category, string> = {
  class: 'Class', learning: 'Learning', thought: 'Thought', quote: 'Quote', work: 'Work',
  project: 'Project', life: 'Life', task: 'Task', inbox: 'Inbox', deadline: 'Deadline',
};

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
    await notifier.reply(msg.chat.id, 'Voice and photos are not wired up yet. Send text for now.');
    return 'ignored';
  }

  if (msg.text.trim().split(/\s/)[0].split('@')[0] === '/start') {
    await notifier.reply(
      msg.chat.id,
      'Send any note and it goes into your diary. Start with /push, /learn, /thought, /quote, /work, /project, /life or /task to pick a category. Use /reason or /think for a longer take. Set your timezone with /timezone Europe/Paris. Send /heartbeat to check the database connection.',
    );
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
      await notifier.reply(msg.chat.id, formatHealth(stats, tz));
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'unknown error';
      await notifier.reply(msg.chat.id, `Database check failed. ${reason}`);
    }
    return 'ignored';
  }

  // /reclean re-runs the cleanup over notes an earlier model left untouched. It is the
  // repair path for history, not something the normal flow needs, and it writes only
  // clean_text: the raw text of every note is left exactly as it was.
  if (msg.text.trim().split(/\s/)[0].split('@')[0] === '/reclean') {
    if (!repairer) {
      await notifier.reply(msg.chat.id, 'Re-clean is not available in this build.');
      return 'ignored';
    }
    const asked = Number(msg.text.trim().split(/\s+/)[1]);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 25) : 5;
    try {
      const result = await repairer.repair(limit);
      await notifier.reply(msg.chat.id, repairLine(result));
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'unknown error';
      await notifier.reply(msg.chat.id, `Re-clean failed. ${reason}`);
    }
    return 'ignored';
  }

  // The timezone command is an instruction, not a note: it is answered before anything
  // is written, so "set my timezone" never shows up in the diary.
  const tzCommand = parseTimeZoneCommand(msg.text);
  if (tzCommand) {
    const current = (await store.getTimeZone()) ?? settings.timeZone;
    if (tzCommand.kind === 'show') {
      await notifier.reply(msg.chat.id, `Your timezone is ${current}.`);
    } else if (tzCommand.kind === 'invalid') {
      await notifier.reply(msg.chat.id, `"${tzCommand.input}" is not a timezone I know. Use a name like Europe/Paris or Asia/Kolkata.`);
    } else {
      await store.setTimeZone(tzCommand.zone);
      await notifier.reply(msg.chat.id, `Timezone set to ${tzCommand.zone}. New entries use it; older entries keep their day.`);
    }
    return 'saved';
  }

  // A bare slash word (/push, /work, /nonsense) or an empty message is not a note.
  // Nothing is captured, and the reply says so, because a row in the diary that only
  // says "/start" is noise the owner has to clean up by hand later.
  if (msg.text.trim() === '' || isInstruction(msg.text)) {
    await notifier.reply(
      msg.chat.id,
      'Nothing saved: that is a command, not a note. Send the note after the command, like /push /thought the exact words.',
    );
    return 'rejected';
  }

  const parsed = parseCommand(msg.text);
  if (!parsed.ok) {
    const text =
      parsed.error === 'empty' ? 'Nothing saved: no note text after the command. Add your text after it.'
      : parsed.error === 'conflict_mode' ? `Nothing saved. Pick one mode: ${parsed.options.map((o) => `/${o === 'verbatim' ? 'push' : o}`).join(' or ')}.`
      : `Nothing saved. Pick one category: ${parsed.options.map((o) => `/${o === 'learning' ? 'learn' : o}`).join(' or ')}.`;
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
  let usage: { tokensIn: number | null; tokensOut: number | null; model: string | null } =
    { tokensIn: null, tokensOut: null, model: null };
  if (refiner && parsed.mode !== 'verbatim') {
    try {
      const out = await refiner.refine({ text: parsed.body, mode: parsed.mode, category });
      if (out) {
        clean = out.text;
        usage = { tokensIn: out.tokensIn, tokensOut: out.tokensOut, model: out.model };
      }
    } catch (err) {
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
  // Three lines: where it was filed, what the cleanup did (a failure is said out loud,
  // with its reason), and the start of what was actually stored.
  const reminder = detected?.kind === 'deadline' ? "I'll ping you daily from 3 days before."
    : detected?.kind === 'review' ? "I'll remind you to review it."
    : '';
  const detail = [cleanupLine({
    raw: parsed.body,
    clean,
    mode: parsed.mode,
    error: refineError,
    ran: Boolean(refiner) && parsed.mode !== 'verbatim',
  }), reminder]
    .filter(Boolean)
    .join(' ');
  await notifier.reply(
    msg.chat.id,
    [`Saved to ${CATEGORY_LABEL[category]}.`, detail, storedPreview(clean)].join('\n'),
  );
  return 'saved';
}

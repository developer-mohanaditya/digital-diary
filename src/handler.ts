import { parseCommand, type Category, type Mode } from './parse';
import { parseTimeZoneCommand } from './timezone';
import { detectReminder, type DetectedReminder } from './reminders';

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

// Result of the /test database round-trip: reads plus one heartbeat write.
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
  setCaptureStatus(id: string, status: 'done' | 'failed', error?: string): Promise<void>;
  getTimeZone(): Promise<string | null>;
  setTimeZone(zone: string): Promise<void>;
}
export interface Notifier {
  reply(chatId: number, text: string): Promise<void>;
  remind?(chatId: number, reminderId: string, text: string): Promise<void>;
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

// The /test reply: what the database actually holds, so a silent bot is distinguishable
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
      'Send any note and it goes into your diary. Start with /push, /learn, /thought, /quote, /work, /project, /life or /task to pick a category. Use /reason or /think for a longer take. Set your timezone with /timezone Europe/Paris. Send /test to check the database connection.',
    );
    return 'ignored';
  }

  // /test: read a few counts and write one heartbeat, then report them. It is never
  // stored as a diary entry: the reply is the whole point, and a failure is replied
  // with the real error instead of a silent 500.
  if (msg.text.trim().split(/\s/)[0].split('@')[0] === '/test') {
    if (!store.health) {
      await notifier.reply(msg.chat.id, 'Database check is not available in this build.');
      return 'ignored';
    }
    const tz = (await store.getTimeZone()) ?? settings.timeZone;
    try {
      const stats = await store.health(localDay(now, tz));
      await notifier.reply(msg.chat.id, formatHealth(stats, tz));
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'unknown error';
      await notifier.reply(msg.chat.id, `Database check failed. ${reason}`);
    }
    return 'ignored';
  }

  const parsed = parseCommand(msg.text);
  const capture = await store.insertCapture({
    update_id: update.update_id,
    chat_id: msg.chat.id,
    raw_text: msg.text,
    mode: parsed.ok ? parsed.mode : null,
    category: parsed.ok ? parsed.category : null,
    status: 'received',
  });
  if (!capture.inserted || !capture.id) return 'duplicate';

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
    await store.setCaptureStatus(capture.id, 'done');
    return 'saved';
  }

  if (!parsed.ok) {
    await store.setCaptureStatus(capture.id, 'failed', parsed.error);
    const text =
      parsed.error === 'empty' ? 'Nothing to save after the command. Add your text after it.'
      : parsed.error === 'conflict_mode' ? `Pick one mode: ${parsed.options.map((o) => `/${o === 'verbatim' ? 'push' : o}`).join(' or ')}.`
      : `Pick one category: ${parsed.options.map((o) => `/${o === 'learning' ? 'learn' : o}`).join(' or ')}.`;
    await notifier.reply(msg.chat.id, text);
    return 'rejected';
  }

  // Deadlines + reviews: detect from explicit /deadline, due-words, or review phrases.
  // Heuristic now, AI upgrade later without schema change.
  const tz = (await store.getTimeZone()) ?? settings.timeZone;
  const detected: DetectedReminder | null = detectReminder(msg.text, now, tz);
  const category: Category = detected?.categoryHint ?? parsed.category ?? 'inbox';
  await store.insertThought({
    capture_id: capture.id,
    day: localDay(now, tz),
    captured_at: new Date(msg.date * 1000).toISOString(),
    category,
    category_source: parsed.categorySource === 'tag' ? 'tag' : detected ? 'auto' : 'auto',
    mode: parsed.mode,
    clean_text: parsed.body,
    raw_text: parsed.body,
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
  await store.setCaptureStatus(capture.id, 'done');
  if (detected?.kind === 'deadline') {
    await notifier.reply(msg.chat.id, `Saved to Deadline. I'll ping you daily from 3 days before.`);
  } else if (detected?.kind === 'review') {
    await notifier.reply(msg.chat.id, `Saved to ${CATEGORY_LABEL[category]}. I'll remind you to review it.`);
  } else {
    await notifier.reply(msg.chat.id, `Saved to ${CATEGORY_LABEL[category]}.`);
  }
  return 'saved';
}

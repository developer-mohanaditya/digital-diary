import { parseCommand, type Category, type Mode } from './parse';
import { parseTimeZoneCommand } from './timezone';

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
export interface Store {
  insertCapture(c: CaptureInput): Promise<{ inserted: boolean; id?: string }>;
  insertThought(t: ThoughtInput): Promise<void>;
  setCaptureStatus(id: string, status: 'done' | 'failed', error?: string): Promise<void>;
  getTimeZone(): Promise<string | null>;
  setTimeZone(zone: string): Promise<void>;
}
export interface Notifier {
  reply(chatId: number, text: string): Promise<void>;
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

const CATEGORY_LABEL: Record<Category, string> = {
  class: 'Class', learning: 'Learning', thought: 'Thought', quote: 'Quote', work: 'Work',
  project: 'Project', life: 'Life', task: 'Task', inbox: 'Inbox',
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
      'Send any note and it goes into your diary. Start with /push, /learn, /thought, /quote, /work, /project, /life or /task to pick a category. Use /reason or /think for a longer take. Set your timezone with /timezone Europe/Paris.',
    );
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

  // Auto-classification and cleanup come later. Until then, untagged text goes to Inbox.
  const category: Category = parsed.category ?? 'inbox';
  await store.insertThought({
    capture_id: capture.id,
    day: localDay(now, (await store.getTimeZone()) ?? settings.timeZone),
    captured_at: new Date(msg.date * 1000).toISOString(),
    category,
    category_source: parsed.categorySource === 'tag' ? 'tag' : 'auto',
    mode: parsed.mode,
    clean_text: parsed.body,
    raw_text: parsed.body,
  });
  await store.setCaptureStatus(capture.id, 'done');
  await notifier.reply(msg.chat.id, `Saved to ${CATEGORY_LABEL[category]}.`);
  return 'saved';
}

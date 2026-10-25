// The shapes the web interface consumes, and the mapping from database rows onto
// them. Kept out of the Worker entry point so it can be tested without fetch.

export const UI_CATEGORIES = [
  'class', 'learning', 'thought', 'quote', 'work', 'project', 'life', 'task', 'deadline', 'inbox',
] as const;

// Only the columns the interface needs.
export interface ThoughtRow {
  id: string;
  day: string;
  category: string;
  category_source?: string | null;
  mode: string;
  clean_text: string;
  raw_text?: string | null;
  created_at: string;
  capture_id?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cleanup_model?: string | null;
}

// A reminder attached to the note that created it, keyed by capture id.
export interface DeadlineMark {
  due: string | null;   // YYYY-MM-DD
  done: boolean;
}

export interface UiEntry {
  id: string;
  time: string;   // HH:MM in the diary timezone
  cat: string;
  mode: string;
  src: string;
  text: string;
  raw: string;
  due?: string | null;
  done?: boolean;
  // What the cleanup cost, only when there is something to say. A verbatim note was never
  // sent to a model and an old note predates the columns, so the page gets no field at all
  // rather than three zeroes it would draw as a free note.
  usage?: { tokensIn: number | null; tokensOut: number | null; model: string | null };
}

// Stored modes are the command names; the interface shows the friendlier label.
const MODE_UI: Record<string, string> = {
  refine: 'refined',
  refined: 'refined',
  verbatim: 'verbatim',
  reason: 'reason',
  think: 'think',
};

export function clock(stamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(stamp));
}

// The label on the chip is the mode the note was received with. A note that went through
// the cleanup stays refined/reason/think even when the result happens to be the same
// words: the Raw control is still offered for it, which is the only way to see that.
export function displayMode(stored: string): string {
  return MODE_UI[stored] ?? 'refined';
}

export function toUiEntry(row: ThoughtRow, timeZone: string, deadline?: DeadlineMark): UiEntry {
  const raw = row.raw_text || row.clean_text;
  const entry: UiEntry = {
    id: row.id,
    time: clock(row.created_at, timeZone),
    // A category the interface has no colour for would crash its renderer.
    cat: (UI_CATEGORIES as readonly string[]).includes(row.category) ? row.category : 'inbox',
    mode: displayMode(row.mode),
    // 'tag' and 'manual' are the two ways a person filed a note by hand; everything else was
    // the classifier's guess. The sheet names them differently.
    src: row.category_source === 'tag' ? 'tag' : row.category_source === 'manual' ? 'manual' : 'auto',
    text: row.clean_text,
    raw,
  };
  if (deadline) {
    entry.due = deadline.due;
    entry.done = deadline.done;
  }
  if (row.tokens_in != null || row.tokens_out != null || row.cleanup_model) {
    entry.usage = {
      tokensIn: row.tokens_in ?? null,
      tokensOut: row.tokens_out ?? null,
      model: row.cleanup_model ?? null,
    };
  }
  return entry;
}

export function groupByDay(
  rows: ThoughtRow[],
  timeZone: string,
  deadlines: Record<string, DeadlineMark> = {},
): Record<string, UiEntry[]> {
  const days: Record<string, UiEntry[]> = {};
  for (const row of rows) {
    const mark = row.capture_id ? deadlines[row.capture_id] : undefined;
    (days[row.day] ||= []).push(toUiEntry(row, timeZone, mark));
  }
  for (const list of Object.values(days)) list.sort((a, b) => a.time.localeCompare(b.time));
  return days;
}

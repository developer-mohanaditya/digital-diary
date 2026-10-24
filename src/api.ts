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

// The label on the chip. A note the cleanup left exactly as written is called verbatim,
// because that is what it is on screen: the Raw control would show the same words twice.
// Only notes that went through the formatting keep their refined/reason/think label.
export function displayMode(stored: string, clean: string, raw: string): string {
  if (stored === 'verbatim') return 'verbatim';
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (flat(clean) === flat(raw)) return 'verbatim';
  return MODE_UI[stored] ?? 'refined';
}

export function toUiEntry(row: ThoughtRow, timeZone: string, deadline?: DeadlineMark): UiEntry {
  const raw = row.raw_text || row.clean_text;
  const entry: UiEntry = {
    id: row.id,
    time: clock(row.created_at, timeZone),
    // A category the interface has no colour for would crash its renderer.
    cat: (UI_CATEGORIES as readonly string[]).includes(row.category) ? row.category : 'inbox',
    mode: displayMode(row.mode, row.clean_text, raw),
    src: row.category_source === 'tag' ? 'tag' : 'auto',
    text: row.clean_text,
    raw,
  };
  if (deadline) {
    entry.due = deadline.due;
    entry.done = deadline.done;
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

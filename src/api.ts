// The shapes the web interface consumes, and the mapping from database rows onto
// them. Kept out of the Worker entry point so it can be tested without fetch.

export const UI_CATEGORIES = [
  'class', 'learning', 'thought', 'quote', 'work', 'project', 'life', 'task', 'deadline', 'inbox',
] as const;

// A real calendar day, not just four digits and two dashes: 2026-02-30 and 2026-13-01 both
// match the shape and neither is a day. Shared by the read API's filters and the write API's
// notes, so the two doors cannot disagree about what a date is.
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

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
  cleanup_ms?: number | null;
  // The capture the note arrived in, embedded by the read. Present from the moment the embed
  // is asked for; the column set without it is the fallback for a database that predates
  // captures.client, and then a note simply has no origin to show.
  captures?: { source: string; client?: string | null } | null;
}

// Where a note came from: the door it came through, and — for the API door — the app that
// filed it ("claude-code"). The words on screen are the page's business; this is what the
// capture recorded.
export interface NoteOrigin {
  source: string;        // telegram | web | api
  client: string | null; // set by a write key, null on the other two doors
}

// A reminder attached to the note that created it, keyed by capture id.
export interface DeadlineMark {
  due: string | null;   // YYYY-MM-DD
  done: boolean;
  doneAt?: string | null; // when it was ticked: the one thing a closed note keeps that a to-do app does not
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
  doneLabel?: string | null; // "24 Oct · 05:36", already in the diary's timezone
  // Absent when the read could not reach the capture, which is the one case where the page
  // shows no mark at all rather than guessing a channel.
  origin?: NoteOrigin;
  // What the cleanup cost, only when there is something to say. A verbatim note was never
  // sent to a model and an old note predates the columns, so the page gets no field at all
  // rather than three zeroes it would draw as a free note. `ms` is the same rule: how long the
  // cleanup took, null when nothing measured it.
  usage?: { tokensIn: number | null; tokensOut: number | null; model: string | null; ms: number | null };
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

// A closed deadline's moment, in the diary's timezone: "24 Oct · 05:36".
function stamp(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso)).replace(',', ' ·');
}

export function toUiEntry(
  row: ThoughtRow,
  timeZone: string,
  deadline?: DeadlineMark,
  origin?: NoteOrigin,
): UiEntry {
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
    // Formatted here because the page has no idea which timezone the diary runs on, and a
    // closed deadline stamped in the browser's zone could name the wrong day.
    entry.doneLabel = deadline.doneAt ? stamp(deadline.doneAt, timeZone) : null;
  }
  if (origin) entry.origin = origin;
  if (row.tokens_in != null || row.tokens_out != null || row.cleanup_model || row.cleanup_ms != null) {
    entry.usage = {
      tokensIn: row.tokens_in ?? null,
      tokensOut: row.tokens_out ?? null,
      model: row.cleanup_model ?? null,
      ms: row.cleanup_ms ?? null,
    };
  }
  return entry;
}

export function groupByDay(
  rows: ThoughtRow[],
  timeZone: string,
  deadlines: Record<string, DeadlineMark> = {},
  origins: Record<string, NoteOrigin> = {},
): Record<string, UiEntry[]> {
  const days: Record<string, UiEntry[]> = {};
  for (const row of rows) {
    const mark = row.capture_id ? deadlines[row.capture_id] : undefined;
    const origin = row.capture_id ? origins[row.capture_id] : undefined;
    (days[row.day] ||= []).push(toUiEntry(row, timeZone, mark, origin));
  }
  for (const list of Object.values(days)) list.sort((a, b) => a.time.localeCompare(b.time));
  return days;
}

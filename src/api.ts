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
}

export interface UiEntry {
  id: string;
  time: string;   // HH:MM in the diary timezone
  cat: string;
  mode: string;
  src: string;
  text: string;
  raw: string;
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

export function toUiEntry(row: ThoughtRow, timeZone: string): UiEntry {
  return {
    id: row.id,
    time: clock(row.created_at, timeZone),
    // A category the interface has no colour for would crash its renderer.
    cat: (UI_CATEGORIES as readonly string[]).includes(row.category) ? row.category : 'inbox',
    mode: MODE_UI[row.mode] ?? 'refined',
    src: row.category_source === 'tag' ? 'tag' : 'auto',
    text: row.clean_text,
    raw: row.raw_text || row.clean_text,
  };
}

export function groupByDay(rows: ThoughtRow[], timeZone: string): Record<string, UiEntry[]> {
  const days: Record<string, UiEntry[]> = {};
  for (const row of rows) {
    (days[row.day] ||= []).push(toUiEntry(row, timeZone));
  }
  for (const list of Object.values(days)) list.sort((a, b) => a.time.localeCompare(b.time));
  return days;
}

// The 10pm summary: one message about the day just lived, arriving when the day is over.
// Kept pure so the wording can be tested without a Worker, a database or a phone.

import { clock } from './api';
import type { Category } from './parse';

export interface SummaryNote {
  category: Category;
  text: string;
  at: string; // ISO timestamp of the note
}

export interface SummaryReminder {
  kind: string;
  title: string;
  dueAt: string | null;
}

const SHOWN_NOTES = 8; // more than this is a scroll, not a glance
const NOTE_CHARS = 90;

const label = (category: string) => category.charAt(0).toUpperCase() + category.slice(1);

// The day is already the diary's local date, so noon UTC keeps the formatter away from
// both midnights: no weekday can silently shift by a day.
function dayLine(day: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(`${day}T12:00:00Z`));
}

function dueLine(dueAt: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(dueAt));
}

// One line per note: collapse the newlines a note may carry, and cut at a word boundary so
// a long note reads as a beginning rather than as a severed word.
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= NOTE_CHARS) return flat;
  const cut = flat.slice(0, NOTE_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function summaryMessage(input: {
  day: string;
  timeZone: string;
  notes: SummaryNote[];
  reminders: SummaryReminder[];
}): string {
  const { day, timeZone, notes, reminders } = input;
  const lines: string[] = [dayLine(day)];

  if (notes.length === 0) {
    lines[0] += ' — no notes today.';
  } else {
    lines[0] += ` — ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`;
    const counts = new Map<string, number>();
    for (const note of notes) counts.set(note.category, (counts.get(note.category) ?? 0) + 1);
    lines.push(
      [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${label(c)} ${n}`).join(' · '),
    );
    lines.push('');
    for (const note of notes.slice(0, SHOWN_NOTES)) {
      lines.push(`${clock(note.at, timeZone)} · ${label(note.category)} · ${oneLine(note.text)}`);
    }
    if (notes.length > SHOWN_NOTES) lines.push(`…and ${notes.length - SHOWN_NOTES} more.`);
  }

  if (reminders.length > 0) {
    lines.push('', `Still open (${reminders.length}):`);
    for (const reminder of reminders) {
      const due = reminder.dueAt ? ` — ${dueLine(reminder.dueAt)}` : '';
      lines.push(`• ${reminder.title}${due}`);
    }
  }
  return lines.join('\n');
}

// Two cron entries cover CET and CEST, so the run speaks only once the local clock has
// reached 22:00 — and only once per day, because the hour clocks go back can match twice.
export function summaryDue(localHour: number, sentOn: string | null, day: string): boolean {
  return localHour >= 22 && sentOn !== day;
}

export function hourIn(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(now));
}

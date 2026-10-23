import type { Category } from './parse';

// Unified reminder: deadlines (explicit due date, daily T-3 pings)
// and reviews (relative later, 1-2 pings with Done).
export type ReminderKind = 'deadline' | 'review';

export interface DetectedReminder {
  kind: ReminderKind;
  title: string;
  dueAt: string | null; // ISO, deadlines only
  nextRemindAt: string; // ISO
  source: 'explicit' | 'heuristic' | 'ai';
  categoryHint: Category | null; // deadline -> 'deadline', review keeps original
}

const DEADLINE_WORDS = /\b(deadline|due date|due by|due on|submit by|finish .* by|complete .* by|in \d+ days?)\b/i;
const EXPLICIT_DEADLINE_CMD = /^\s*\/deadline\b/i;

// Matches: by 3rd nov, by this weekend, in 3 days, tomorrow, etc.
// We extract a rough date heuristically; AI refines it later.
function parseRelativeDue(text: string, now: Date, timeZone: string): Date | null {
  const lower = text.toLowerCase();
  const day = new Date(now);
  const mInDays = /in (\d+) days?/.exec(lower);
  if (mInDays) {
    day.setDate(day.getDate() + Number(mInDays[1]));
    return day;
  }
  if (/\btomorrow\b/.test(lower)) {
    day.setDate(day.getDate() + 1);
    return day;
  }
  if (/\bthis weekend\b/.test(lower)) {
    // Saturday of this week.
    const dow = day.getDay();
    day.setDate(day.getDate() + ((6 - dow + 7) % 7 || 7));
    return day;
  }
  // "by 3rd nov" / "by Nov 3"
  const mDate = /by (\d{1,2})(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/.exec(lower);
  if (mDate) {
    const months: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const month = months[mDate[3].slice(0, 3)];
    const d = new Date(Date.UTC(now.getUTCFullYear(), month, Number(mDate[1]), 9, 0, 0));
    if (d.getTime() < now.getTime()) d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d;
  }
  void timeZone;
  return null;
}

const REVIEW_PHRASES = [
  /review .* later/i,
  /come back to/i,
  /read .* again/i,
  /check this (again|later)/i,
  /revisit/i,
  /follow up/i,
  /\blater\b.*review/i,
];

// Evening 18:30 local -> UTC approx via timezone offset is complex on edge.
// We store next_remind_at in UTC: same-day 18:30 diary-TZ ~= 13:00 UTC for Europe/Paris winter,
// but cron runs daily so exact hour drifts gracefully. Keep it simple:
// - note before 15:00 local -> same day evening
// - note after 15:00 -> next day evening
// AI urgency can pull it earlier; never later than +2 days.
export function nextReviewAt(now: Date, urgent: boolean): Date {
  const d = new Date(now);
  const hourUTC = now.getUTCHours();
  // Rough local-evening mapping: 18:30 Europe/Paris ~= 17:30 UTC.
  if (urgent) {
    d.setUTCHours(17, 30, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }
  if (hourUTC < 14) {
    d.setUTCHours(17, 30, 0, 0);
    return d;
  }
  d.setDate(d.getDate() + 1);
  d.setUTCHours(17, 30, 0, 0);
  return d;
}

export function detectReminder(
  rawText: string,
  now: Date,
  timeZone: string,
): DetectedReminder | null {
  const text = rawText.trim();
  const explicit = EXPLICIT_DEADLINE_CMD.test(text);
  const body = explicit ? text.replace(EXPLICIT_DEADLINE_CMD, '').trim() : text;

  if (explicit || DEADLINE_WORDS.test(body)) {
    const due = parseRelativeDue(body, now, timeZone);
    const dueAt = due ?? new Date(now.getTime() + 3 * 86400000);
    // First ping: T-3 (or now if due sooner).
    const first = new Date(dueAt.getTime() - 3 * 86400000);
    const next = first.getTime() < now.getTime() ? now : first;
    return {
      kind: 'deadline',
      title: body.slice(0, 140),
      dueAt: dueAt.toISOString(),
      nextRemindAt: next.toISOString(),
      source: explicit ? 'explicit' : 'heuristic',
      categoryHint: 'deadline',
    };
  }

  if (REVIEW_PHRASES.some((re) => re.test(body))) {
    const urgent = /\b(urgent|important|asap|tonight|today)\b/i.test(body);
    return {
      kind: 'review',
      title: body.slice(0, 140),
      dueAt: null,
      nextRemindAt: nextReviewAt(now, urgent).toISOString(),
      source: 'heuristic',
      categoryHint: null, // keep original category; AI may set later
    };
  }
  return null;
}

// AI hook shape: same OpenAI-compatible driver as refine.
// Input: raw note. Output: { kind, due_in_days?, urgent? }.
// Kept separate so heuristic ships first, AI upgrades without schema change.
export interface ReminderAi {
  classifyReminder(body: string): Promise<{ kind: ReminderKind | null; dueInDays?: number; urgent?: boolean } | null>;
}

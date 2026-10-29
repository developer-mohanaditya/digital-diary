// Every message the bot sends is built here, and only here.
//
// Two things make a chat message readable on a phone: a first line that says what happened, and
// the same order after it every time. Both are easy to lose when each call site writes its own
// sentence — which is how the bot ended up with three voices saying the same kind of thing (a
// full stop, a `key value` dump, and a run of `·`-joined fragments). So the shape lives here:
//
//   ✓ Saved to Inbox                 <- the verdict: one glyph, one bold line
//                                    <- blank
//   "Had coffee with Ram."           <- the note itself, quoted
//                                    <- blank
//   2.1 s · 210 in / 48 out · …      <- facts, joined by ·
//
// Everything leaves as Telegram HTML, which means every user-supplied string is escaped on its
// way in: a note holding "<" would otherwise make Telegram reject the whole message, and the
// receipt for a note that was stored is not worth losing. sendMessage still falls back to plain
// text if the markup is ever refused, so a formatting bug costs the bold, never the message.

import type { HealthStats } from './handler';
import type { BackupCounts } from './backup';

/* ---------- Text that is safe to send ---------- */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The same message with the markup taken off, for the plain-text retry.
export function stripHtml(text: string): string {
  return text
    .replace(/<\/?(?:b|i|code|pre|u|s)>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const heading = (glyph: string, title: string) => `${glyph} <b>${escapeHtml(title)}</b>`;

const CATEGORY_LABEL: Record<string, string> = {
  class: 'Class', learning: 'Learning', thought: 'Thought', quote: 'Quote', work: 'Work',
  project: 'Project', life: 'Life', task: 'Task', inbox: 'Inbox', deadline: 'Deadline',
};

// One spelling of a category everywhere: the page, the receipt, the summary, the API's
// acknowledgement. The lower-case slug stays in the database and in the JSON.
export const categoryLabel = (category: string): string =>
  CATEGORY_LABEL[category] ?? category.charAt(0).toUpperCase() + category.slice(1);

/* ---------- Facts ---------- */

// A wait under a second reads in milliseconds; anything slower reads in seconds with one
// decimal, which is the precision that matters when the question is "did it hang?".
export function duration(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function clockOf(instant: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(typeof instant === 'string' ? new Date(instant) : instant);
}

// "27 Oct": the day a note was received, without a year to read past.
function monthDay(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' })
    .format(new Date(instant));
}

// "Thu, 30 Oct": a day that still has to arrive.
function weekdayDay(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(instant));
}

// A calendar day (YYYY-MM-DD) has no time of its own, so noon UTC keeps the formatter away from
// both midnights: no weekday can silently shift by a day.
export function dayStamp(day: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(`${day}T12:00:00Z`));
}

/* ---------- The note itself ---------- */

// Enough of the stored note to recognise it on a phone, flattened to one line, with three dots
// marking where it was cut.
export const PREVIEW_CHARS = 180;

export function storedPreview(text: string, limit = PREVIEW_CHARS): string {
  const flat = text
    .replace(/\*\*|==/g, '')
    .replace(/^\s*[-\u2022]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}...` : flat;
}

const quoted = (text: string) => `<i>"${escapeHtml(storedPreview(text) || '—')}"</i>`;

/* ---------- Saved ---------- */

// How the cleanup ended, which is the only thing the third line of a receipt has to explain.
export type SaveState = 'formatted' | 'unchanged' | 'verbatim' | 'unavailable' | 'failed';

export interface SaveFacts {
  category: string;
  note: string;
  state: SaveState;
  error?: string | null;
  ms?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  model?: string | null;
  due?: string | null; // YYYY-MM-DD
}

export function savedMessage(f: SaveFacts): string {
  const facts: string[] = [];
  if (f.due) facts.push(`due ${dayStamp(f.due)}`);
  if (f.state === 'verbatim') facts.push('as written');
  else if (f.state === 'unavailable') facts.push('no cleanup available');
  else if (f.state === 'failed') facts.push(`cleanup failed — ${escapeHtml((f.error ?? 'unknown error').slice(0, 160))}`);
  if (f.ms != null) facts.push(duration(f.ms));
  if (f.tokensIn != null || f.tokensOut != null) facts.push(`${f.tokensIn ?? '–'} in / ${f.tokensOut ?? '–'} out`);
  if (f.model) facts.push(escapeHtml(f.model));

  const lines = [heading('✓', `Saved to ${categoryLabel(f.category)}`), '', quoted(f.note)];
  if (facts.length) lines.push('', facts.join(' · '));
  return lines.join('\n');
}

/* ---------- Not saved, and failed ---------- */

// A refusal always names what did not happen, then what to type instead. `hint` is markup the
// caller builds from fixed strings, so it may carry <code>.
export function notSavedMessage(headline: string, hint?: string): string {
  const lines = [`⚠️ <b>Not saved</b> — ${escapeHtml(headline)}`];
  if (hint) lines.push('', hint);
  return lines.join('\n');
}

export function failedMessage(title: string, reason: string, hint?: string): string {
  const lines = [heading('⚠️', title), '', escapeHtml(reason.slice(0, 200))];
  if (hint) lines.push('', hint);
  return lines.join('\n');
}

export function notSavedCommand(): string {
  return notSavedMessage('that is a command, not a note', 'Send the note after it: <code>/push /thought the exact words</code>');
}

export function notSavedEmpty(): string {
  return notSavedMessage('no note text after the command', 'Add your text after it, like <code>/work finished the API review</code>.');
}

export function notSavedMode(options: string[]): string {
  const picks = options.map((o) => `<code>/${o === 'verbatim' ? 'push' : escapeHtml(o)}</code>`);
  return notSavedMessage('pick one mode', picks.join(' or '));
}

export function notSavedCategory(options: string[]): string {
  const picks = options.map((o) => `<code>/${o === 'learning' ? 'learn' : escapeHtml(o)}</code>`);
  return notSavedMessage('pick one category', picks.join(' or '));
}

export function notSavedVoice(): string {
  return notSavedMessage('voice and photos are not wired up yet', 'Send text for now.');
}

/* ---------- The diary itself ---------- */

export function startMessage(): string {
  return [
    '<b>Ink</b>',
    'Send any text and it becomes a note.',
    '',
    '<b>Categories</b>',
    '/push /thought /learn /quote /work',
    '/project /life /task /deadline',
    '',
    '<b>Longer takes</b>',
    '/reason — a point, then why',
    '/think — sharpened until it holds',
    '',
    '<b>The diary</b>',
    '/heartbeat — database and schedule check',
    '/timezone Europe/Paris — set your clock',
    '/reclean — re-run the cleanup on old notes',
  ].join('\n');
}

// The one line a beat exists to show: how much is in the diary, and how much arrived today.
export function statsLine(stats: HealthStats): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [
    plural(stats.thoughts, 'note'),
    `${stats.todayThoughts} today`,
    `${plural(stats.pendingReminders, 'reminder')} open`,
  ].join(' · ');
}

export function lastNoteLine(lastCaptureAt: string | null, timeZone: string): string {
  if (!lastCaptureAt) return 'Last note: none yet';
  return `Last note ${monthDay(lastCaptureAt, timeZone)}, ${clockOf(lastCaptureAt, timeZone)}`;
}

export function healthMessage(stats: HealthStats, timeZone: string, at: Date): string {
  return [`❤️ ${clockOf(at, timeZone)}`, statsLine(stats), lastNoteLine(stats.lastCaptureAt, timeZone)].join('\n');
}

export function reminderMessage(kind: string, title: string, dueAt: string | null, timeZone: string): string {
  const deadline = kind === 'deadline';
  const head = deadline
    ? `${heading('⏳', 'Deadline')}${dueAt ? ` · due ${weekdayDay(dueAt, timeZone)}` : ''}`
    : heading('↻', 'Review');
  return [head, '', `<i>${escapeHtml(title)}</i>`].join('\n');
}

export function recleanedMessage(r: { scanned: number; cleaned: number; failed: string[] }): string {
  if (r.scanned === 0) return [`✓ <b>Nothing to re-clean</b>`, '', 'Every note already has a formatted version.'].join('\n');
  const lines = [heading('✓', `Re-cleaned ${r.cleaned} of ${r.scanned} note${r.scanned === 1 ? '' : 's'}`)];
  if (r.failed.length) lines.push('', `Failed: ${escapeHtml(r.failed.slice(0, 3).join('; '))}`);
  return lines.join('\n');
}

// The weekly copy on its way to Telegram. A document with no words around it would be a mystery
// three months later, so it arrives with the same first line as everything else.
export function backupCaption(at: string, counts: BackupCounts, timeZone: string): string {
  return [
    `🧷 <b>Backup</b> · ${monthDay(at, timeZone)}`,
    `${counts.thoughts} note${counts.thoughts === 1 ? '' : 's'} · ${counts.archived_notes} archived`,
    'The copy that leaves the database.',
  ].join('\n');
}

/* ---------- The clock ---------- */

export function timezoneShownMessage(zone: string): string {
  return `Your timezone · <b>${escapeHtml(zone)}</b>`;
}

export function timezoneSetMessage(zone: string): string {
  return [
    `✓ <b>Timezone set</b> · ${escapeHtml(zone)}`,
    '',
    'New notes use it. Older notes keep their day.',
  ].join('\n');
}

export function timezoneRefusedMessage(input: string): string {
  return notSavedMessage(
    `not a timezone I know — "${input}"`,
    'Use a name like <code>Europe/Paris</code> or <code>Asia/Kolkata</code>.',
  );
}

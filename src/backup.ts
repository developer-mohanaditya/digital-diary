// When the weekly copy leaves the database, and what it is called.
//
// The snapshot itself is taken inside Postgres by pg_cron (migration 0013). Getting a copy *out*
// is the Worker's job, because the Worker is the only thing here that can reach Telegram — and a
// backup that lives only in the project it protects is half a backup. The rule is one export a
// week: the first cron run on a Monday sends the snapshot the 03:00 job just took, and the
// settings marker keeps the rest of that day's runs quiet.

import { localDay } from './handler';

export interface BackupCounts {
  thoughts: number;
  captures: number;
  reminders: number;
  archived_notes: number;
}

// One row of diary_backups. `payload` is the diary itself, present only where the export needs
// the document to send.
export interface Backup {
  id: number;
  taken_at: string;
  reason: string;
  counts: BackupCounts;
  payload?: string;
}

// The ISO week a day falls in, e.g. "2026-W44". A week is the unit that matters here: whichever
// run comes first once the new snapshot exists sends the copy, and a Monday whose upload failed
// is retried by any later run in the same week instead of being lost until the next one.
export function weekKey(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return '';
  const target = new Date(d);
  const monday = (d.getUTCDay() + 6) % 7;                  // 0 for Monday
  target.setUTCDate(d.getUTCDate() - monday + 3);           // the Thursday names the ISO year
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    (target.getTime() - firstThursday.getTime()) / 86400000
      - 3 + (firstThursday.getUTCDay() + 6) % 7,
  ) / 7;
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Due when this week's copy has not left yet. The marker holds the ISO week, so a run late in the
// week finds the work already done, and a failed upload is retried rather than skipped.
export function exportDue(now: Date, timeZone: string, exportedWeek: string | null): boolean {
  return exportedWeek !== weekKey(localDay(now, timeZone));
}

// A snapshot older than this is not the one this week's job made, so it is taken again rather
// than sent quietly as if it were fresh. Twenty hours covers the 03:00 job and anything the
// Worker does before the day is out.
export const SNAPSHOT_FRESH_HOURS = 20;

export function staleSnapshot(takenAt: string, now: Date, hours = SNAPSHOT_FRESH_HOURS): boolean {
  const age = now.getTime() - new Date(takenAt).getTime();
  return !Number.isFinite(age) || age > hours * 3600 * 1000;
}

// The name it arrives under on Telegram. Leading with the day means twelve of them sort in the
// chat the way they were taken.
export function backupFileName(day: string): string {
  return `ink-backup-${day}.json`;
}

// The keep-alive beat: three heartbeat rows a day, so the free Supabase project never sees a
// quiet week and pauses. Each one is confirmed on Telegram as it is written, the same way
// /heartbeat answers on demand: a heartbeat is worth having only if you can see it.

// 08:45, 12:30 and 17:00 on the diary's clock.
//
// A beat belongs to a slot, and the first cron run at or after that slot writes it — once, which
// is what the marker in settings records. Matching the exact minute instead meant that a trigger
// that was never registered, an entry an hour out after a clock change, or a run that landed a
// little late each turned the beat off silently. That is how this feature died twice: an empty
// table, and no message to show for it.
export const HEARTBEAT_SLOTS: readonly (readonly [number, number])[] = [[8, 45], [12, 30], [17, 0]];

const pad = (n: number) => String(n).padStart(2, '0');

export interface BeatSlot {
  // The local day and slot, e.g. "2026-10-27T12:30": what the marker holds, so one slot is beaten
  // once and the same time on a new day beats again.
  key: string;
  hour: number;
  minute: number;
  // How late the run that satisfied the slot is, in minutes; zero at the slot itself. It is on
  // the message because a beat that had to be caught up is the one thing that says the schedule
  // is not what it looks like.
  lateBy: number;
}

// The slot a run at this moment satisfies: the latest one whose local time has passed today, or
// null before the first slot of the day. The diary's own clock decides which of the paired cron
// entries (CET and CEST) is the one that lands, so the same slot answers either side of a clock
// change instead of one of the two being "the right one".
export function beatSlot(now: Date, timeZone: string): BeatSlot | null {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  const minutes = Number(part('hour')) * 60 + Number(part('minute'));
  const reached = HEARTBEAT_SLOTS.filter(([h, m]) => h * 60 + m <= minutes);
  if (!reached.length) return null;
  const [hour, minute] = reached[reached.length - 1];
  return { key: `${day}T${pad(hour)}:${pad(minute)}`, hour, minute, lateBy: minutes - (hour * 60 + minute) };
}

// The line the phone gets when the beat lands. It names the slot rather than the moment the run
// happened, because the slot is what the beat is for; a run that had to catch a slot up says how
// late it was, so a schedule that has drifted looks like one.
export function beatMessage(slot: BeatSlot, timeZone: string): string {
  const late = slot.lateBy ? ` (${slot.lateBy}m late)` : '';
  return `Heartbeat ${pad(slot.hour)}:${pad(slot.minute)}${late} (${timeZone}) · keep-alive written.`;
}

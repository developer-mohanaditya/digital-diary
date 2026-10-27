// The keep-alive beat: three silent heartbeat rows a day, so the free Supabase project never
// sees a quiet week and pauses. Unlike /heartbeat these say nothing on Telegram — three
// "still here" texts a day would be noise, and the 22:00 summary is the message that matters.

// 08:45, 12:30 and 17:00 on the diary's clock. Each slot has a cron entry for its UTC hour
// under CET and one under CEST, so on any given day one of the pair lands on the slot and the
// other runs an hour out; matching the local clock is what picks between them, exactly as the
// summary decides which of its two evening runs sends.
export const HEARTBEAT_SLOTS: readonly (readonly [number, number])[] = [[8, 45], [12, 30], [17, 0]];

export function heartbeatDue(now: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const part = (type: 'hour' | 'minute') => Number(parts.find((p) => p.type === type)?.value);
  const hour = part('hour');
  const minute = part('minute');
  return HEARTBEAT_SLOTS.some(([h, m]) => h === hour && m === minute);
}

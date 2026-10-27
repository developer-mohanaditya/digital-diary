import { describe, expect, it } from 'vitest';
import { beatMessage, beatSlot } from '../src/heartbeat';

const PARIS = 'Europe/Paris';
// The same local slot either side of the clock change, as the UTC instant a cron entry fires on.
const cest = (hour: number, minute: number) => new Date(Date.UTC(2026, 6, 15, hour - 2, minute));
const cet = (hour: number, minute: number) => new Date(Date.UTC(2026, 0, 15, hour - 1, minute));

describe('beatSlot', () => {
  it('holds its fire until the first slot of the day', () => {
    expect(beatSlot(cest(8, 44), PARIS)).toBeNull();
    expect(beatSlot(cet(6, 30), PARIS)).toBeNull(); // 07:30 Paris
    expect(beatSlot(new Date('2026-07-15T06:45:00Z'), 'UTC')).toBeNull();
  });

  it('satisfies each slot at its own minute, on either side of the clock change', () => {
    expect(beatSlot(cest(8, 45), PARIS)).toMatchObject({ hour: 8, minute: 45, lateBy: 0 });
    expect(beatSlot(cet(12, 30), PARIS)).toMatchObject({ hour: 12, minute: 30, lateBy: 0 });
    expect(beatSlot(cet(17, 0), PARIS)).toMatchObject({ hour: 17, minute: 0, lateBy: 0 });
  });

  it('still answers with a slot for a run that lands late, rather than skipping the beat', () => {
    // 13:30 Paris with nothing beaten at 12:30: the noon slot is still the one owed.
    expect(beatSlot(cest(13, 30), PARIS)).toMatchObject({ hour: 12, minute: 30, lateBy: 60 });
    // 22:00, when the summary entry fires: the evening slot, if it is still unbeaten.
    expect(beatSlot(cet(22, 0), PARIS)).toMatchObject({ hour: 17, minute: 0, lateBy: 300 });
  });

  it('never invents a slot of its own after the last one', () => {
    expect(beatSlot(cet(23, 59), PARIS)).toMatchObject({ hour: 17, minute: 0 });
  });

  it('names the slot by local day and time, so a new day beats again', () => {
    expect(beatSlot(cest(12, 30), PARIS)?.key).toBe('2026-07-15T12:30');
    expect(beatSlot(cet(12, 30), PARIS)?.key).toBe('2026-01-15T12:30');
  });

  it('reads the diary timezone, not UTC', () => {
    expect(beatSlot(new Date('2026-07-15T06:45:00Z'), PARIS)).toMatchObject({ hour: 8, minute: 45, lateBy: 0 });
    // The same instant is 12:15 in Kolkata, where the noon slot has not been reached yet.
    expect(beatSlot(new Date('2026-07-15T06:45:00Z'), 'Asia/Kolkata')).toMatchObject({ hour: 8, minute: 45, lateBy: 210 });
  });
});

describe('beatMessage', () => {
  it('names the slot on the diary clock', () => {
    expect(beatMessage(beatSlot(cest(12, 30), PARIS)!, PARIS)).toBe(
      'Heartbeat 12:30 (Europe/Paris) · keep-alive written.',
    );
  });

  it('says how late it was when it had to catch a slot up', () => {
    expect(beatMessage(beatSlot(cest(13, 30), PARIS)!, PARIS)).toBe(
      'Heartbeat 12:30 (60m late) (Europe/Paris) · keep-alive written.',
    );
  });
});

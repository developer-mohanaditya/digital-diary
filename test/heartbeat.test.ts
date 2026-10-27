import { describe, expect, it } from 'vitest';
import { heartbeatDue } from '../src/heartbeat';

const PARIS = 'Europe/Paris';

describe('heartbeatDue', () => {
  it('fires at all three slots on CEST days', () => {
    expect(heartbeatDue(new Date('2026-07-15T06:45:00Z'), PARIS)).toBe(true); // 08:45
    expect(heartbeatDue(new Date('2026-07-15T10:30:00Z'), PARIS)).toBe(true); // 12:30
    expect(heartbeatDue(new Date('2026-07-15T15:00:00Z'), PARIS)).toBe(true); // 17:00
  });

  it('fires at all three slots on CET days, an hour later in UTC', () => {
    expect(heartbeatDue(new Date('2026-01-15T07:45:00Z'), PARIS)).toBe(true);
    expect(heartbeatDue(new Date('2026-01-15T11:30:00Z'), PARIS)).toBe(true);
    expect(heartbeatDue(new Date('2026-01-15T16:00:00Z'), PARIS)).toBe(true);
  });

  it('skips the twin run that is an hour off the local slot', () => {
    expect(heartbeatDue(new Date('2026-01-15T06:45:00Z'), PARIS)).toBe(false); // 07:45
    expect(heartbeatDue(new Date('2026-01-15T10:30:00Z'), PARIS)).toBe(false); // 11:30
    expect(heartbeatDue(new Date('2026-01-15T15:00:00Z'), PARIS)).toBe(false); // 16:00
  });

  it('matches the minute, not just the hour', () => {
    expect(heartbeatDue(new Date('2026-07-15T06:44:00Z'), PARIS)).toBe(false);
    expect(heartbeatDue(new Date('2026-07-15T06:46:00Z'), PARIS)).toBe(false);
  });

  it('reads the diary timezone, not UTC', () => {
    expect(heartbeatDue(new Date('2026-07-15T06:45:00Z'), 'UTC')).toBe(false);
    expect(heartbeatDue(new Date('2026-07-15T08:45:00Z'), 'UTC')).toBe(true);
  });
});

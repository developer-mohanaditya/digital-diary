import { describe, expect, it } from 'vitest';
import { isValidTimeZone, parseTimeZoneCommand } from '../src/timezone';

describe('parseTimeZoneCommand', () => {
  it('shows the zone when no name is given', () => {
    expect(parseTimeZoneCommand('/timezone')).toEqual({ kind: 'show' });
  });
  it('sets a valid IANA zone', () => {
    expect(parseTimeZoneCommand('/timezone Asia/Kolkata')).toEqual({ kind: 'set', zone: 'Asia/Kolkata' });
  });
  it('rejects an unknown zone', () => {
    expect(parseTimeZoneCommand('/timezone Mars/Olympus')).toEqual({ kind: 'invalid', input: 'Mars/Olympus' });
  });
  it('ignores other messages', () => {
    expect(parseTimeZoneCommand('/push hello')).toBeNull();
    expect(parseTimeZoneCommand('the timezone is nice')).toBeNull();
  });
});

describe('isValidTimeZone', () => {
  it('accepts real zones and rejects made-up ones', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });
});

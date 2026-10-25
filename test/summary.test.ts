import { describe, expect, it } from 'vitest';
import { hourIn, summaryDue, summaryMessage } from '../src/summary';

const PARIS = 'Europe/Paris';

describe('summaryMessage', () => {
  it('counts the day, tallies the categories and lists each note with its hour', () => {
    const text = summaryMessage({
      day: '2026-10-25',
      timeZone: PARIS,
      notes: [
        { category: 'life', text: 'Woke at 2:30, body and brain at odds.', at: '2026-10-25T00:48:00Z' },
        { category: 'work', text: 'Merged the release candidate.', at: '2026-10-25T20:41:00Z' },
        { category: 'work', text: 'Wrote the summary.', at: '2026-10-25T21:05:00Z' },
      ],
      reminders: [],
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Sunday 25 October — 3 notes');
    expect(lines[1]).toBe('Work 2 · Life 1');
    // A CEST note and a CET one: both hours come from the diary's timezone, not UTC.
    expect(lines[3]).toBe('02:48 · Life · Woke at 2:30, body and brain at odds.');
    expect(lines[5]).toBe('22:05 · Work · Wrote the summary.');
    expect(text).not.toContain('Still open');
  });

  it('says so when nothing was written, and still shows what is open', () => {
    const text = summaryMessage({
      day: '2026-10-25',
      timeZone: PARIS,
      notes: [],
      reminders: [{ kind: 'deadline', title: 'Submit the tax form', dueAt: '2026-10-27T09:00:00Z' }],
    });
    expect(text.split('\n')[0]).toBe('Sunday 25 October — no notes today.');
    expect(text).toContain('Still open (1):');
    expect(text).toContain('• Submit the tax form — Tue 27 Oct');
  });

  it('leaves a review without a due date as a plain bullet', () => {
    const text = summaryMessage({
      day: '2026-10-25',
      timeZone: PARIS,
      notes: [{ category: 'learning', text: 'Reread chapter 4.', at: '2026-10-25T10:00:00Z' }],
      reminders: [{ kind: 'review', title: 'Reread the chapter', dueAt: null }],
    });
    expect(text.endsWith('• Reread the chapter')).toBe(true);
    expect(text).not.toContain('• Reread the chapter —');
  });

  it('keeps one note to one line and cuts long text at a word boundary', () => {
    const long = `${'word '.repeat(40)}end`;
    const text = summaryMessage({
      day: '2026-10-25',
      timeZone: PARIS,
      notes: [{ category: 'thought', text: `first line\nsecond line ${long}`, at: '2026-10-25T09:00:00Z' }],
      reminders: [],
    });
    const line = text.split('\n').find((l) => l.includes('· Thought ·'));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(120);
    expect(line).toContain('first line second line');
    expect(line!.endsWith('…')).toBe(true);
  });

  it('shows eight notes and counts the rest instead of scrolling', () => {
    const notes = Array.from({ length: 11 }, (_, i) => ({
      category: 'inbox' as const,
      text: `note ${i + 1}`,
      at: `2026-10-25T${String(8 + i).padStart(2, '0')}:00:00Z`,
    }));
    const text = summaryMessage({ day: '2026-10-25', timeZone: PARIS, notes, reminders: [] });
    expect(text).toContain('— 11 notes');
    expect(text).toContain('…and 3 more.');
    expect(text.split('\n').filter((l) => l.includes('· Inbox ·'))).toHaveLength(8);
  });

  it('uses the singular for a one-note day', () => {
    const text = summaryMessage({
      day: '2026-10-25',
      timeZone: PARIS,
      notes: [{ category: 'life', text: 'One thing.', at: '2026-10-25T12:00:00Z' }],
      reminders: [],
    });
    expect(text.split('\n')[0]).toBe('Sunday 25 October — 1 note');
  });
});

describe('summaryDue', () => {
  it('waits until the local clock reaches 22:00', () => {
    expect(summaryDue(21, null, '2026-10-25')).toBe(false);
    expect(summaryDue(22, null, '2026-10-25')).toBe(true);
  });

  it('sends once a day, so the fall-back hour cannot repeat it', () => {
    expect(summaryDue(22, '2026-10-25', '2026-10-25')).toBe(false);
    expect(summaryDue(23, '2026-10-24', '2026-10-25')).toBe(true);
  });
});

describe('hourIn', () => {
  it('reads 22:00 from both the summer and the winter cron', () => {
    expect(hourIn(new Date('2026-07-14T20:00:00Z'), PARIS)).toBe(22);
    expect(hourIn(new Date('2026-01-14T21:00:00Z'), PARIS)).toBe(22);
  });

  it('reads the hour after midnight as 0, not 24', () => {
    expect(hourIn(new Date('2026-01-14T23:00:00Z'), PARIS)).toBe(0);
  });
});

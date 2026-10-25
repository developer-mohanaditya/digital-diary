import { describe, expect, it } from 'vitest';
import { clock, groupByDay, toUiEntry, type ThoughtRow } from '../src/api';

const row = (overrides: Partial<ThoughtRow> = {}): ThoughtRow => ({
  id: 'th-1',
  day: '2026-10-23',
  category: 'thought',
  category_source: 'auto',
  mode: 'refine',
  clean_text: 'A thought',
  raw_text: 'a thought, and yeah',
  created_at: '2026-10-23T05:27:28.000Z',
  ...overrides,
});

describe('toUiEntry', () => {
  it('maps the stored refine mode to the label the interface renders', () => {
    expect(toUiEntry(row(), 'UTC').mode).toBe('refined');
  });

  it('formats the time in the diary timezone', () => {
    expect(clock('2026-10-23T05:27:28.000Z', 'Europe/Paris')).toBe('07:27');
    expect(clock('2026-10-23T05:27:28.000Z', 'UTC')).toBe('05:27');
  });

  it('falls back to inbox for a category the page cannot style', () => {
    expect(toUiEntry(row({ category: 'archive' }), 'UTC').cat).toBe('inbox');
    expect(toUiEntry(row({ category: 'deadline' }), 'UTC').cat).toBe('deadline');
  });

  it('marks tagged entries as tag and everything else as auto', () => {
    expect(toUiEntry(row({ category_source: 'tag' }), 'UTC').src).toBe('tag');
    expect(toUiEntry(row({ category_source: null }), 'UTC').src).toBe('auto');
    // A note moved from the sheet is neither tagged by hand nor guessed by the classifier.
    expect(toUiEntry(row({ category_source: 'manual' }), 'UTC').src).toBe('manual');
  });

  it('keeps the raw text, falling back to the clean text when absent', () => {
    expect(toUiEntry(row(), 'UTC').raw).toBe('a thought, and yeah');
    expect(toUiEntry(row({ raw_text: null }), 'UTC').raw).toBe('A thought');
  });

  // The ground rule: the chip says what the note went through, and every mode except
  // verbatim offers Raw. A cleanup that left the words alone is still a refined note,
  // and Raw is how that becomes visible instead of invisible.
  it('keeps the label and the raw text when the cleanup left the words alone', () => {
    const same = toUiEntry(row({ clean_text: 'a thought', raw_text: 'a thought' }), 'UTC');
    expect(same.mode).toBe('refined');
    expect(same.raw).toBe('a thought');
    expect(toUiEntry(row({ clean_text: 'a thought', raw_text: ' a  thought\n' }), 'UTC').raw).toBe(' a  thought\n');
  });

  it('keeps reason and think labels when the cleanup did change the note', () => {
    expect(toUiEntry(row({ mode: 'reason' }), 'UTC').mode).toBe('reason');
    expect(toUiEntry(row({ mode: 'think' }), 'UTC').mode).toBe('think');
    expect(toUiEntry(row({ mode: 'verbatim', clean_text: 'a thought', raw_text: 'a thought' }), 'UTC').mode)
      .toBe('verbatim');
  });
});

describe('groupByDay', () => {
  it('buckets by day and sorts each day by clock time', () => {
    const days = groupByDay([
      row({ id: 'late', created_at: '2026-10-23T18:00:00.000Z', day: '2026-10-23' }),
      row({ id: 'early', created_at: '2026-10-23T07:00:00.000Z', day: '2026-10-23' }),
      row({ id: 'other', day: '2026-10-22' }),
    ], 'UTC');
    expect(Object.keys(days).sort()).toEqual(['2026-10-22', '2026-10-23']);
    expect(days['2026-10-23'].map((e) => e.id)).toEqual(['early', 'late']);
    expect(days['2026-10-22']).toHaveLength(1);
  });

  it('attaches the due date and done flag from the reminder on the same capture', () => {
    const days = groupByDay(
      [row({ id: 'a', capture_id: 'cap-1', category: 'deadline' }), row({ id: 'b', capture_id: 'cap-2' })],
      'UTC',
      { 'cap-1': { due: '2026-11-03', done: false } },
    );
    const [first, second] = days['2026-10-23'];
    expect(first.due).toBe('2026-11-03');
    expect(first.done).toBe(false);
    expect(second.due).toBeUndefined();
  });
});

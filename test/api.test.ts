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
  });

  it('keeps the raw text, falling back to the clean text when absent', () => {
    expect(toUiEntry(row(), 'UTC').raw).toBe('a thought, and yeah');
    expect(toUiEntry(row({ raw_text: null }), 'UTC').raw).toBe('A thought');
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
});

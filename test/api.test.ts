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

  it('carries the origin of the capture the note arrived in', () => {
    expect(toUiEntry(row(), 'UTC').origin).toBeUndefined();
    expect(toUiEntry(row(), 'UTC', undefined, { source: 'api', client: 'claude-code' }).origin)
      .toEqual({ source: 'api', client: 'claude-code' });
  });

  // What the cleanup cost, and how long it kept the owner waiting. The duration is the newest
  // figure of the three, so it is the one a database older than 0012 has no column for: a row
  // that carries only that column still has to produce a usage block, and a row that carries
  // none of them must produce none.
  it('carries what the cleanup cost, the duration included', () => {
    expect(toUiEntry(row({ tokens_in: 210, tokens_out: 48, cleanup_model: '@cf/m', cleanup_ms: 37100 }), 'UTC').usage)
      .toEqual({ tokensIn: 210, tokensOut: 48, model: '@cf/m', ms: 37100 });
    expect(toUiEntry(row({ cleanup_ms: 900 }), 'UTC').usage).toEqual({
      tokensIn: null, tokensOut: null, model: null, ms: 900,
    });
    expect(toUiEntry(row(), 'UTC').usage).toBeUndefined();
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

  // Each note is marked with its own capture's origin, not the page's: a day can hold a note
  // typed on the page, one sent to the bot and one filed by an agent, and they are told apart.
  it('attaches each note the origin of its own capture', () => {
    const days = groupByDay(
      [row({ id: 'a', capture_id: 'cap-1' }), row({ id: 'b', capture_id: 'cap-2' })],
      'UTC',
      {},
      { 'cap-1': { source: 'telegram', client: null }, 'cap-2': { source: 'api', client: 'codex' } },
    );
    const [first, second] = days['2026-10-23'];
    expect(first.origin).toEqual({ source: 'telegram', client: null });
    expect(second.origin).toEqual({ source: 'api', client: 'codex' });
  });

  it('shows no origin when the captures were not read', () => {
    const days = groupByDay([row({ id: 'a', capture_id: 'cap-1' })], 'UTC');
    expect(days['2026-10-23'][0].origin).toBeUndefined();
  });
});

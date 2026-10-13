import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parse';

describe('parseCommand', () => {
  it('plain text is refined and auto-categorized', () => {
    expect(parseCommand('Stay hungry, stay foolish')).toEqual({
      ok: true, mode: 'refine', category: null, categorySource: 'auto', body: 'Stay hungry, stay foolish',
    });
  });

  it('/push stores verbatim', () => {
    const r = parseCommand('/push Stay hungry, stay foolish');
    expect(r).toMatchObject({ ok: true, mode: 'verbatim', category: null, body: 'Stay hungry, stay foolish' });
  });

  it('space-separated tags combine: /push /thought', () => {
    expect(parseCommand('/push /thought Stay hungry')).toMatchObject({
      ok: true, mode: 'verbatim', category: 'thought', categorySource: 'tag', body: 'Stay hungry',
    });
  });

  it('/learn maps to the learning category', () => {
    expect(parseCommand('/learn B-trees keep keys sorted')).toMatchObject({ category: 'learning' });
  });

  it('modes: /reason and /think', () => {
    expect(parseCommand('/reason I think X because Y')).toMatchObject({ mode: 'reason' });
    expect(parseCommand('/think analyse this')).toMatchObject({ mode: 'think' });
  });

  it('commands are case-insensitive', () => {
    expect(parseCommand('/PUSH /Quote hi')).toMatchObject({ mode: 'verbatim', category: 'quote' });
  });

  it('same tag repeated is not a conflict', () => {
    expect(parseCommand('/push /push hi')).toMatchObject({ ok: true, mode: 'verbatim' });
  });

  it('two different modes conflict and list the options', () => {
    expect(parseCommand('/push /think hi')).toEqual({
      ok: false, error: 'conflict_mode', options: ['verbatim', 'think'],
    });
  });

  it('two different categories conflict', () => {
    expect(parseCommand('/class /work hi')).toEqual({
      ok: false, error: 'conflict_category', options: ['class', 'work'],
    });
  });

  it('merged slashes are not split (we use spaces between commands)', () => {
    expect(parseCommand('/push/thought hi')).toMatchObject({ ok: true, mode: 'refine', category: null, body: '/push/thought hi' });
  });

  it('unknown /words stay in the body', () => {
    expect(parseCommand('/foo bar')).toMatchObject({ ok: true, body: '/foo bar' });
  });

  it('"/." is not a command', () => {
    expect(parseCommand('/. hello')).toMatchObject({ ok: true, mode: 'refine', body: '/. hello' });
  });

  it('keeps line breaks in the body', () => {
    expect(parseCommand('/reason line one\nline two')).toMatchObject({ body: 'line one\nline two' });
  });

  it('a command with no body is reported as empty', () => {
    expect(parseCommand('/push')).toEqual({ ok: false, error: 'empty', options: [] });
    expect(parseCommand('   ')).toEqual({ ok: false, error: 'empty', options: [] });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  BIG_MODEL, BIG_TEXT_CHARS, MAX_INPUT_CHARS, SMALL_MODEL,
  buildMessages, pickModel, readOutput, workersAiRefiner,
} from '../src/refine';

const run = (answer: unknown) => vi.fn(async () => answer);

describe('pickModel', () => {
  it('uses the small model for a normal note', () => {
    expect(pickModel('Had coffee with Ram.')).toBe(SMALL_MODEL);
  });

  it('switches to the bigger model once the note is long', () => {
    expect(pickModel('x'.repeat(BIG_TEXT_CHARS))).toBe(SMALL_MODEL);
    expect(pickModel('x'.repeat(BIG_TEXT_CHARS + 1))).toBe(BIG_MODEL);
  });
});

describe('buildMessages', () => {
  it('passes the category and the note to the model', () => {
    const [, user] = buildMessages({ text: 'um so the lecture was about raft', mode: 'refine', category: 'class' });
    expect(user.content).toContain('Category: class');
    expect(user.content).toContain('um so the lecture was about raft');
    expect(user.content).toContain('Clean the note up');
  });

  it('asks for explicit reasoning in reason mode, and depth in think mode', () => {
    expect(buildMessages({ text: 'a', mode: 'reason', category: 'thought' })[1].content).toContain('reasoning explicit');
    expect(buildMessages({ text: 'a', mode: 'think', category: 'thought' })[1].content).toContain('tighten the thinking');
  });

  it('never sends more than the input cap', () => {
    const long = 'y'.repeat(MAX_INPUT_CHARS + 500);
    expect(buildMessages({ text: long, mode: 'refine', category: 'work' })[1].content.length)
      .toBeLessThan(long.length + 200);
  });
});

describe('readOutput', () => {
  it('reads the Workers AI shape', () => {
    expect(readOutput({ response: '  Cleaned note.  ' })).toBe('Cleaned note.');
  });

  it('reads the OpenAI-style shape', () => {
    expect(readOutput({ choices: [{ message: { content: 'Cleaned.' } }] })).toBe('Cleaned.');
  });

  it('strips a code fence the model wrapped around its answer', () => {
    expect(readOutput({ response: '```text\nCleaned note.\n```' })).toBe('Cleaned note.');
  });

  it('treats an empty or unreadable answer as no answer', () => {
    expect(readOutput({ response: '   ' })).toBeNull();
    expect(readOutput({})).toBeNull();
    expect(readOutput(null)).toBeNull();
    expect(readOutput({ response: 42 })).toBeNull();
  });
});

describe('workersAiRefiner', () => {
  it('returns the cleaned text and asks the right model', async () => {
    const ai = { run: run({ response: 'Had coffee with Ram.' }) };
    const refiner = workersAiRefiner(ai);
    expect(await refiner.refine({ text: 'um so i had a coffee with ram', mode: 'refine', category: 'life' }))
      .toBe('Had coffee with Ram.');
    expect(ai.run).toHaveBeenCalledTimes(1);
    const [model, input] = ai.run.mock.calls[0] as unknown as [string, { messages: { role: string }[]; max_tokens: number }];
    expect(model).toBe(SMALL_MODEL);
    expect(input.messages[0].role).toBe('system');
    expect(input.max_tokens).toBeGreaterThan(0);
  });

  it('never calls the model for a verbatim note', async () => {
    const ai = { run: run({ response: 'should not be used' }) };
    expect(await workersAiRefiner(ai).refine({ text: 'exact words', mode: 'verbatim', category: 'work' }))
      .toBeNull();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('does not call the model for empty text', async () => {
    const ai = { run: run({ response: 'x' }) };
    expect(await workersAiRefiner(ai).refine({ text: '   ', mode: 'refine', category: 'inbox' })).toBeNull();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('lets a model failure reach the caller, which saves the note as written', async () => {
    const ai = { run: vi.fn(async () => { throw new Error('AI quota exhausted'); }) };
    await expect(workersAiRefiner(ai).refine({ text: 'hi', mode: 'refine', category: 'inbox' }))
      .rejects.toThrow('AI quota exhausted');
  });
});

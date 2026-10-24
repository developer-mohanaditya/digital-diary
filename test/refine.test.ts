import { describe, expect, it, vi } from 'vitest';
import {
  BACKUP_MODEL, BIG_MODEL, BIG_TEXT_CHARS, MAX_INPUT_CHARS, SMALL_MODEL,
  buildMessages, hasCommentary, isPlausible, pickModel, readOutput, sameWords, workersAiRefiner,
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
  it('passes the note in the user turn and the category in the system turn', () => {
    const [system, user] = buildMessages({ text: 'um so the lecture was about raft', mode: 'refine', category: 'class' });
    expect(system.content).toContain('filed under "class"');
    expect(user.content).toContain('um so the lecture was about raft');
    expect(user.content).toContain('reads cleanly');
    // The category must not lead the user turn: a model continued that template and
    // stored "Category: inbox" as the note.
    expect(user.content.startsWith('Category:')).toBe(false);
  });

  it('asks for explicit reasoning in reason mode, and depth in think mode', () => {
    expect(buildMessages({ text: 'a', mode: 'reason', category: 'thought' })[1].content).toContain('reasoning explicit');
    expect(buildMessages({ text: 'a', mode: 'think', category: 'thought' })[1].content).toContain('sharpen the thinking');
  });

  it('tells the model which markup it may use, and that short notes stay plain', () => {
    const [system] = buildMessages({ text: 'a', mode: 'refine', category: 'inbox' });
    expect(system.content).toContain('"- "');
    expect(system.content).toContain('**double asterisks**');
    expect(system.content).toContain('==double equals==');
    expect(system.content).toContain('stays one plain paragraph');
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

  it('drops a preamble and a surrounding quote the model added', () => {
    expect(readOutput({ response: 'Here is the rewritten note: \"Had coffee.\"' })).toBe('Had coffee.');
  });

  it('drops a category header the model echoed back from the prompt', () => {
    expect(readOutput({ response: 'Category: inbox\nClearRoute needs a search algorithm update.' }))
      .toBe('ClearRoute needs a search algorithm update.');
  });

  it('collapses runs of blank lines so paragraphs stay paragraphs', () => {
    expect(readOutput({ response: 'One.\n\n\n\nTwo.' })).toBe('One.\n\nTwo.');
  });
});

describe('isPlausible', () => {
  it('accepts a formatted note and rejects a lecture or a much longer answer', () => {
    expect(isPlausible('**Deploy** went out.\n\n- Raw fixed', 'deploy went out and raw fixed')).toBe(true);
    expect(isPlausible('As an AI language model, I cannot', 'a note')).toBe(false);
    expect(isPlausible('word '.repeat(200), 'a short note')).toBe(false);
  });

  it('rejects an answer that explains its own edit', () => {
    const raw = 'if the diary is open to anyone, what is the cost of losing it';
    const answered = 'If the diary is open to anyone, what is the cost of losing it?\n\nThe note was rewritten to improve clarity and readability, and the phrase "the cost" was wrapped in **double asterisks**.';
    expect(hasCommentary(answered)).toBe(true);
    expect(isPlausible(answered, raw)).toBe(false);
  });

  it('still accepts a note that roughly doubles when a list is laid out', () => {
    const raw = 'need to cancel the trial, finish the proposal and email priya';
    expect(isPlausible('Three things:\n\n- Cancel the trial\n- Finish the proposal\n- Email Priya', raw)).toBe(true);
  });
});

describe('sameWords', () => {
  it('ignores whitespace, so a reflowed answer that changes nothing counts as unchanged', () => {
    expect(sameWords('a note', '  a   note\n')).toBe(true);
    expect(sameWords('a note', '**A** note')).toBe(false);
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

  it('falls back to the other model when the first one is unavailable', async () => {
    const seen: string[] = [];
    const ai = {
      run: vi.fn(async (model: string) => {
        seen.push(model);
        if (model === SMALL_MODEL) throw new Error('Model not found');
        return { response: 'Had coffee with Ram.' };
      }),
    };
    expect(await workersAiRefiner(ai).refine({ text: 'um so coffee with ram', mode: 'refine', category: 'life' }))
      .toBe('Had coffee with Ram.');
    expect(seen).toEqual([SMALL_MODEL, BIG_MODEL]);
  });

  it('falls through to the next model when the first one narrates its own edit', async () => {
    const seen: string[] = [];
    const ai = {
      run: vi.fn(async (model: string) => {
        seen.push(model);
        if (model === SMALL_MODEL) {
          return { response: 'Had coffee with Ram.\n\nThe note was rewritten to remove filler and one phrase was wrapped in ==equals==.' };
        }
        return { response: 'Had coffee with **Ram**.' };
      }),
    };
    expect(await workersAiRefiner(ai).refine({ text: 'um so coffee with ram', mode: 'refine', category: 'life' }))
      .toBe('Had coffee with **Ram**.');
    expect(seen).toEqual([SMALL_MODEL, BIG_MODEL]);
  });

  it('rejects an answer that is not a cleanup and tries the next model', async () => {
    const seen: string[] = [];
    const ai = {
      run: vi.fn(async (model: string) => {
        seen.push(model);
        if (model === SMALL_MODEL) return { response: 'As an AI language model, I cannot rewrite that.' };
        return { response: 'Had coffee with Ram.' };
      }),
    };
    expect(await workersAiRefiner(ai).refine({ text: 'um so coffee with ram', mode: 'refine', category: 'life' }))
      .toBe('Had coffee with Ram.');
    expect(seen).toEqual([SMALL_MODEL, BIG_MODEL]);
  });

  it('tries every model and names all of them when the whole catalog is blocked', async () => {
    const ai = { run: vi.fn(async () => { throw new Error('AI quota exhausted'); }) };
    const error = await workersAiRefiner(ai)
      .refine({ text: 'hi', mode: 'refine', category: 'inbox' })
      .then(() => null, (err: Error) => err);
    expect(error?.message).toContain(SMALL_MODEL);
    expect(error?.message).toContain(BIG_MODEL);
    expect(error?.message).toContain(BACKUP_MODEL);
    expect(error?.message).toContain('AI quota exhausted');
    const tried = (ai.run.mock.calls as unknown as [string][]).map(([m]) => m);
    expect(tried).toEqual([SMALL_MODEL, BIG_MODEL, BACKUP_MODEL]);
  });
});

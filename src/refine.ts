// The cleanup step: turning a quickly typed Telegram message into a diary line.
//
// The raw text is always kept by the handler and stored next to the result, so this
// module never has the only copy: if the model fails, the note is saved as written.

import type { Mode } from './parse';

// Workers AI models. Short notes go to the small model; long ones to the bigger one,
// which follows "keep it short" far more reliably on a rambling paragraph.
//
// Both must exist in the current catalog: @cf/meta/llama-3.1-8b-instruct was retired on
// 30 May 2026 along with seventeen other models, and a retired id fails at runtime with
// no hint until the note comes back uncleaned. Check the catalog before changing these.
export const SMALL_MODEL = '@cf/zai-org/glm-4.7-flash';
export const BIG_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const BIG_TEXT_CHARS = 1000;
// A pasted essay would cost tokens and time for no gain; the raw text is kept whole.
export const MAX_INPUT_CHARS = 4000;

// The slice of the Workers AI binding this module uses.
export interface AiRunner {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface RefineRequest {
  text: string;
  mode: Mode;
  category: string;
}

export interface Refiner {
  refine(req: RefineRequest): Promise<string | null>;
}

const SYSTEM = [
  "You clean up one person's private diary notes. They type quickly on a phone, so the notes contain filler, false starts and repetition.",
  'Rewrite the note so it reads as a clean diary line in the first person.',
  'Rules:',
  "- Keep the writer's voice and every fact, name, number and date exactly as written.",
  '- Remove filler ("um", "like", "yeah", "i mean"), false starts, and ideas repeated twice.',
  '- Fix punctuation, capitalisation and sentence breaks.',
  '- Never add facts, opinions, advice, headings, bullets or a closing remark.',
  '- Keep it as short as the content allows: a two-line thought stays two lines.',
  '- Reply with the cleaned note only. No quotation marks around it, no preamble.',
].join('\n');

const MODE_INSTRUCTION: Record<Mode, string> = {
  refine: 'Clean the note up without changing its meaning or length much.',
  verbatim: '',
  reason: 'Clean it up, then make the reasoning explicit: state the point, then the reason for it, in one short paragraph.',
  think: 'Clean it up and tighten the thinking: keep the observation, and make what it implies clear in one sentence. Add no new facts and no advice.',
};

export function pickModel(text: string): string {
  return text.length > BIG_TEXT_CHARS ? BIG_MODEL : SMALL_MODEL;
}

// The order to try. If one model is retired, overloaded or not enabled on the account,
// the other still cleans the note: a single bad id must not take the feature down.
export function modelOrder(text: string): string[] {
  return text.length > BIG_TEXT_CHARS ? [BIG_MODEL, SMALL_MODEL] : [SMALL_MODEL, BIG_MODEL];
}

export function buildMessages(req: RefineRequest): { role: string; content: string }[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${MODE_INSTRUCTION[req.mode]}\n\nCategory: ${req.category}\n\nNote:\n${req.text.slice(0, MAX_INPUT_CHARS)}`,
    },
  ];
}

// Models answer either { response } or the OpenAI-style { choices }. A fence is the
// one wrapper worth stripping: it would otherwise be stored as part of the note.
export function readOutput(raw: unknown): string | null {
  const text =
    typeof raw === 'string' ? raw
    : raw && typeof raw === 'object'
      ? (() => {
          const r = raw as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
          if (typeof r.response === 'string') return r.response;
          const content = r.choices?.[0]?.message?.content;
          return typeof content === 'string' ? content : null;
        })()
      : null;
  if (text === null) return null;
  const tidy = text.trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  return tidy === '' ? null : tidy;
}

// Wraps the binding so the handler only ever sees "cleaned text or null". Verbatim
// notes never reach the model: that mode means the words are the point.
export function workersAiRefiner(ai: AiRunner): Refiner {
  return {
    async refine(req) {
      if (req.mode === 'verbatim') return null;
      const text = req.text.trim();
      if (text === '') return null;
      const messages = buildMessages({ ...req, text });
      let failure: unknown = null;
      for (const model of modelOrder(text)) {
        try {
          const out = await ai.run(model, { messages, max_tokens: 512, temperature: 0.2 });
          const cleaned = readOutput(out);
          if (cleaned) return cleaned;
          failure ??= new Error(`${model} answered with nothing`);
        } catch (err) {
          failure ??= err;
        }
      }
      throw failure instanceof Error ? failure : new Error('every cleanup model failed');
    },
  };
}

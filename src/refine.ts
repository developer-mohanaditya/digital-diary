// The cleanup step: turning a quickly typed Telegram message into something that reads
// like a written diary entry.
//
// Two things happen here, in one model call: the filler and false starts go, and the
// result is laid out to be read (paragraphs, bullets where the note is really a list,
// a little emphasis on the words that carry the point). The exact text is always kept
// by the handler and stored next to the result, so this module never has the only copy:
// if the model fails, the note is saved as written and the Raw control still shows it.

import type { Mode } from './parse';

// Workers AI models. Short notes go to the small model; long ones to the bigger one,
// which follows formatting instructions far more reliably on a rambling paragraph.
// A third, older model is the last resort so one blocked or retired id cannot switch
// the cleanup off. All three are in the current catalog; a retired id fails only at
// runtime, with no hint until the note comes back unformatted.
export const SMALL_MODEL = '@cf/zai-org/glm-4.7-flash';
export const BIG_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const BACKUP_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
export const BIG_TEXT_CHARS = 1000;
// A pasted essay would cost tokens and time for no gain; the raw text is kept whole.
export const MAX_INPUT_CHARS = 4000;
// Room for paragraphs and bullets without letting a model ramble.
export const MAX_TOKENS = 768;

// The slice of the Workers AI binding this module uses.
export interface AiRunner {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface RefineRequest {
  text: string;
  mode: Mode;
  category: string;
}

// What a cleanup produced, and what it cost. The tokens are the ones Workers AI reported on
// the response: null when the model does not report them, which is not the same as zero and
// must not be stored as zero.
export interface Refined {
  text: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface Refiner {
  refine(req: RefineRequest): Promise<Refined | null>;
}

// The markup the web page can render: paragraphs, two kinds of list, and three kinds of
// emphasis. Everything else is forbidden, because the page escapes the text first and
// only rebuilds these markers: a note can never inject HTML.
const SYSTEM = [
  "You tidy one person's private diary notes for them to read back later. They type quickly on a phone, so the notes are full of filler, false starts, repetition and run-on sentences.",
  'Rewrite the note so it reads well, in the first person, in their voice.',
  '',
  'Always:',
  '- Keep every fact, name, number, date, place and quotation exactly as written.',
  '- Keep their opinions and feelings; never add facts, advice, interpretations or a closing remark.',
  '- Remove filler and hesitation ("um", "uh", "like", "you know", "i mean", "so yeah"), false starts and anything said twice.',
  '- Fix punctuation, capitalisation and sentence breaks. Split run-on sentences.',
  '',
  'Lay it out for reading, only where it helps:',
  '- Start a new paragraph for a new idea. Separate paragraphs with one blank line.',
  '- If the note is really a list (several tasks, items, people or points), put each one on its own line starting with "- ".',
  '- Wrap the few words that carry the point in **double asterisks**; at most three per note, and none in a note that is only one sentence.',
  '- Use *single asterisks* for a title, a book or film, or a phrase quoted inside a sentence.',
  '- Wrap anything they must not forget (a date, a deadline, a number, a name) in ==double equals==; at most two per note.',
  '- A short note about one thing stays one plain paragraph with no markup at all.',
  '- Never use headings, tables, code blocks, emoji, or bold at the start of every line.',
  '',
  'Reply with the rewritten note only. No preamble, no explanation, no quotation marks around the whole note.',
].join('\n');

const MODE_INSTRUCTION: Record<Mode, string> = {
  refine: 'Rewrite it so it reads cleanly and is easy to scan.',
  verbatim: '',
  reason: 'Rewrite it, then make the reasoning explicit: the point first, then why, in that order.',
  think: 'Rewrite it and sharpen the thinking: keep the observation, and make what it implies clear. Add no new facts and no advice.',
};

export function pickModel(text: string): string {
  return text.length > BIG_TEXT_CHARS ? BIG_MODEL : SMALL_MODEL;
}

// The order to try. If one model is retired, overloaded or not enabled on the account,
// the next still formats the note: a single bad id must not take the feature down.
export function modelOrder(text: string): string[] {
  return text.length > BIG_TEXT_CHARS
    ? [BIG_MODEL, SMALL_MODEL, BACKUP_MODEL]
    : [SMALL_MODEL, BIG_MODEL, BACKUP_MODEL];
}

// The category lives in the system message: when it sat at the top of the user turn, a
// model occasionally continued the template and stored "Category: inbox" as the note.
export function buildMessages(req: RefineRequest): { role: string; content: string }[] {
  return [
    { role: 'system', content: `${SYSTEM}\n\nThis note is filed under "${req.category}".` },
    {
      role: 'user',
      content: `${MODE_INSTRUCTION[req.mode]}\n\n${req.text.slice(0, MAX_INPUT_CHARS)}`,
    },
  ];
}

const PREAMBLE = /^(here(?:'s| is) (?:the|your) (?:rewritten|cleaned|tidied|formatted) note:?|rewritten note:?)\s*/i;
// A model that answered the prompt's template instead of the note: "Category: inbox".
const ECHOED_HEADER = /^category:\s*[\w-]+\s*\n?/i;

// A fence, a surrounding quote or a "Here is..." line would otherwise be stored as part
// of the note. Blank-line runs are collapsed so the page's paragraph split stays honest.
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
  const tidy = text
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
    .replace(PREAMBLE, '')
    .replace(ECHOED_HEADER, '')
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return tidy === '' ? null : tidy;
}

// Some models append an explanation of what they did instead of just doing it. That text
// is not the note, and storing it would put "the note was rewritten to improve clarity"
// in the diary: the answer is rejected and the next model is asked instead.
const COMMENTARY = [
  /\bthe note (?:was|has been|is)\b[^.]*\b(?:rewritten|cleaned|tidied|formatted|edited)\b/i,
  /\bthe phrase\b[^.]*\b(?:was|is)\b[^.]*\b(?:wrapped|bolded|highlighted)\b/i,
  /\bno other markup\b/i,
  /\bI (?:rewrote|cleaned|tidied|formatted) (?:the|your) note\b/i,
  /\bas requested, I\b/i,
  /\bthis (?:rewrite|version) (?:removes|keeps|adds|splits)\b/i,
  /\n\*\*Note:\*\*/,
];

export function hasCommentary(cleaned: string): boolean {
  return COMMENTARY.some((re) => re.test(cleaned));
}

// A model that lectures, narrates its own work, or writes twice as much as the note is
// not cleaning anything up. The note is better served by the next model.
export function isPlausible(cleaned: string, original: string): boolean {
  if (cleaned.trim() === '') return false;
  if (/\bas an ai\b/i.test(cleaned)) return false;
  if (hasCommentary(cleaned)) return false;
  if (cleaned.length > original.length * 2 + 100) return false;
  return true;
}

// Compares the words, not the whitespace: a model that only adds a trailing newline did
// not change the note, and the handler labels those as verbatim.
export function sameWords(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

// What a note's cleanup did, and what it cost. Five outcomes, because "saved as written"
// means something different each time: a verbatim note was never sent anywhere, a key's
// note had no model bound, and a failed cleanup is the one worth reporting out loud.
export type CleanupKind = 'formatted' | 'unchanged' | 'verbatim' | 'unavailable' | 'failed';

export interface CleanedNote {
  clean: string;
  cleanup: CleanupKind;
  tokensIn: number | null;
  tokensOut: number | null;
  model: string | null;
  error: string | null;
}

// The one place a note is cleaned. The Telegram handler, the page's composer and the write API
// all go through here, so they cannot disagree about what "formatted" or "failed" means — the
// failure mode this code has hit before is a cleanup that quietly did nothing and still
// reported success. A model that fails never costs the note: the raw text is the answer.
export async function cleanNote(
  refiner: Refiner | undefined,
  req: RefineRequest,
): Promise<CleanedNote> {
  const bare: CleanedNote = {
    clean: req.text, cleanup: 'unavailable', tokensIn: null, tokensOut: null, model: null, error: null,
  };
  if (req.mode === 'verbatim') return { ...bare, cleanup: 'verbatim' };
  if (!refiner) return bare;
  try {
    const out = await refiner.refine(req);
    if (out && !sameWords(out.text, req.text)) {
      return {
        clean: out.text, cleanup: 'formatted',
        tokensIn: out.tokensIn, tokensOut: out.tokensOut, model: out.model, error: null,
      };
    }
    return { ...bare, cleanup: 'unchanged' };
  } catch (err) {
    return {
      ...bare,
      cleanup: 'failed',
      error: err instanceof Error ? err.message.split('\n')[0].slice(0, 200) : 'unknown error',
    };
  }
}

// Wraps the binding so the handler only ever sees "formatted text or null". Verbatim
// notes never reach the model: that mode means the words are the point.
export function workersAiRefiner(ai: AiRunner): Refiner {
  return {
    async refine(req) {
      if (req.mode === 'verbatim') return null;
      const text = req.text.trim();
      if (text === '') return null;
      const messages = buildMessages({ ...req, text });
      const failures: string[] = [];
      for (const model of modelOrder(text)) {
        try {
          const out = await ai.run(model, { messages, max_tokens: MAX_TOKENS, temperature: 0.2 });
          const cleaned = readOutput(out);
          if (cleaned && isPlausible(cleaned, text)) {
            const usage = (out as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
            const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
            return {
              text: cleaned,
              model,
              tokensIn: count(usage?.prompt_tokens),
              tokensOut: count(usage?.completion_tokens),
            };
          }
          failures.push(`${model}: ${cleaned ? 'unusable answer' : 'empty answer'}`);
        } catch (err) {
          // Every model is tried, and every reason is kept: the reply and the capture's
          // last_error need to say which ids failed, not just that something did.
          failures.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw new Error(failures.join(' | ').slice(0, 400));
    },
  };
}

// Command parser for Telegram captures.
// Leading command words are read left to right, separated by spaces: "/push /thought text".
// The first word that is not a known command starts the body, so ordinary text is never swallowed.

export const CATEGORIES = [
  'class', 'learning', 'thought', 'quote', 'work', 'project', 'life', 'task', 'inbox',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const MODES = ['refine', 'verbatim', 'reason', 'think'] as const;
export type Mode = (typeof MODES)[number];

// Command word -> category. The command is "learn"; the stored category is "learning".
const CATEGORY_COMMANDS: Record<string, Category> = {
  class: 'class',
  learn: 'learning',
  thought: 'thought',
  quote: 'quote',
  work: 'work',
  project: 'project',
  life: 'life',
  task: 'task',
};

// Command word -> mode. No tag means "refine".
const MODE_COMMANDS: Record<string, Mode> = {
  push: 'verbatim',
  reason: 'reason',
  think: 'think',
};

export type ParseResult =
  | { ok: true; mode: Mode; category: Category | null; categorySource: 'tag' | 'auto'; body: string }
  | { ok: false; error: 'empty' | 'conflict_mode' | 'conflict_category'; options: string[] };

const LEADING_COMMAND = /^\s*\/([A-Za-z]+)(?=\s|$)/;

export function parseCommand(input: string): ParseResult {
  const modes = new Set<Mode>();
  const categories = new Set<Category>();

  let rest = input;
  for (;;) {
    const m = LEADING_COMMAND.exec(rest);
    if (!m) break;
    const word = m[1].toLowerCase();
    if (word in MODE_COMMANDS) modes.add(MODE_COMMANDS[word]);
    else if (word in CATEGORY_COMMANDS) categories.add(CATEGORY_COMMANDS[word]);
    else break; // unknown "/word" is body text
    rest = rest.slice(m[0].length);
  }

  const body = rest.trim();
  if (body === '') return { ok: false, error: 'empty', options: [] };
  if (modes.size > 1) return { ok: false, error: 'conflict_mode', options: [...modes] };
  if (categories.size > 1) return { ok: false, error: 'conflict_category', options: [...categories] };

  const mode: Mode = modes.size === 1 ? [...modes][0] : 'refine';
  const category: Category | null = categories.size === 1 ? [...categories][0] : null;
  return { ok: true, mode, category, categorySource: category ? 'tag' : 'auto', body };
}

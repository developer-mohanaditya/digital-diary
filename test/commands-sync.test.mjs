import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The wrappers are served, so public/commands is what an agent actually downloads. A copy that
// drifted from commands/ would install a stale wrapper, and the list has to name exactly the
// files that exist or the install loop asks for a page that is not there.

const names = readdirSync('commands')
  .filter((file) => /^ink-[a-z-]+\.md$/.test(file))
  .map((file) => file.slice(0, -3))
  .sort();

describe('served commands', () => {
  it('ships a copy of every wrapper, unchanged', () => {
    for (const name of names) {
      expect(existsSync('public/commands/' + name + '.md'), name).toBe(true);
      expect(readFileSync('public/commands/' + name + '.md', 'utf8'), name)
        .toBe(readFileSync('commands/' + name + '.md', 'utf8'));
    }
  });

  it('lists every wrapper, and nothing else', () => {
    const list = readFileSync('public/commands/names.txt', 'utf8').trim().split('\n');
    expect(list).toEqual(names);
  });

  it('counts the catalogue the skill advertises', () => {
    expect(names.length).toBe(59);
  });

  // Codex reads skills now, not prompt files, so every wrapper also ships as one: a folder's worth
  // of SKILL.md with its own name in front, and no placeholder a skill cannot fill in.
  it('ships a Codex skill for every wrapper, named for it', () => {
    for (const name of names) {
      const file = 'public/skills/commands/' + name + '.md';
      expect(existsSync(file), name).toBe(true);
      const text = readFileSync(file, 'utf8');
      expect(text.startsWith('---\nname: ' + name + '\n'), name).toBe(true);
      expect(text, name).toMatch(/Use the `ink` skill/);
      expect(text, name).not.toContain('$ARGUMENTS');
      expect(text.match(/^name: /gm), name).toHaveLength(1);
    }
  });

  // The skill ships as one directory, so the command list has to travel inside it. A wrapper
  // served on its own can be missed; a reference beside SKILL.md cannot.
  it('carries the whole catalogue inside the skill', () => {
    const served = readFileSync('public/skills/ink/references/commands.md', 'utf8');
    expect(served).toBe(readFileSync('skills/ink/references/commands.md', 'utf8'));
    for (const name of names) expect(served, name).toContain('`/' + name + '`');
    expect(readFileSync('public/skills/ink/SKILL.md', 'utf8')).toContain('references/commands.md');
  });

  it('sends nobody to the prompt folder Codex stopped reading', () => {
    for (const file of ['public/connect.md', 'public/skills/ink/SKILL.md']) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain('/prompts:ink');
      expect(text, file).not.toContain('.codex/prompts/$name');
    }
    expect(readFileSync('public/connect.md', 'utf8')).toContain('.codex/skills/$name/SKILL.md');
  });
});

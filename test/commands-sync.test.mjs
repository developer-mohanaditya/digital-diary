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
    expect(names.length).toBe(58);
  });
});

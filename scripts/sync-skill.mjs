// The skill is one directory: skills/ink/SKILL.md, with the whole command list in
// skills/ink/references/commands.md beside it. Keeping SKILL.md readable is the point of the split,
// and a skill that is one folder plus a reference is what a skill uploader expects to receive.
//
//   npm run gen:skill        builds the reference, then copies the directory to public/skills/ink/
//
// The reference is generated from commands/manifest.json, which gen-ink-commands.mjs writes from
// the one table it owns, so the 59 rows can only exist once. public/ is the asset directory the
// Worker serves, so the copied tree is a URL an agent can fetch instead of a checkout.
//
// It runs before `dev` and before `deploy`, so the served copy cannot drift from the source just
// because someone forgot. Rerunning it is safe.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const source = 'skills/ink';
const reference = source + '/references/commands.md';
const target = 'public/skills/ink';

const rows = JSON.parse(readFileSync('commands/manifest.json', 'utf8'));
if (rows.length !== 59) throw new Error('expected 59 commands, found ' + rows.length);

const cell = (value) => (value === null || value === undefined ? '-' : String(value));

const text = [
  '# INK commands, the whole list',
  '',
  'Generated from `commands/manifest.json` by `scripts/sync-skill.mjs`. Edit the generator, not',
  'this file.',
  '',
  rows.length + ' commands, and every one is a preset of the `ink` skill: a unit, a depth and',
  'sometimes a category, settled before the session is read, so the same words reach the same shape',
  'every time. Read this when he names a command you cannot place, or asks what one is for. The',
  'rules they all follow (how many notes, how deep, the markup, the request, the receipt) are in',
  '`../SKILL.md`, and this file only says which preset a name stands for.',
  '',
  '| Command | Unit | Depth | Category | Mode | What it does |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map(
    (row) =>
      '| `' +
      row.command +
      '` | ' +
      cell(row.unit) +
      ' | ' +
      cell(row.depth) +
      ' | ' +
      cell(row.category) +
      ' | ' +
      cell(row.mode) +
      ' | ' +
      row.does +
      ' |'
  ),
  '',
  '## When the name is not here',
  '',
  'A word he uses that is not one of these names is the subject, not a preset, so it becomes one',
  'note about that subject. A preset he says in words after `/ink`, as in `/ink threads brief`, is',
  'still a preset: read the list for those words, then file as the matching row would.',
  '',
].join('\n');

mkdirSync(source + '/references', { recursive: true });
writeFileSync(reference, text);

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

console.log('written: ' + reference + ' (' + text.length + ' bytes, ' + rows.length + ' rows)');
console.log('copied: ' + source + ' -> ' + target);

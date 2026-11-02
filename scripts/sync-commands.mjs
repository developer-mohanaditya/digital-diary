// The 59 wrappers are written in commands/, and public/ is the asset directory the Worker serves,
// so a file there is a URL an agent can download. This copies them across, beside a bare list of
// names, because an install loop needs the list before it can fetch anything.
//
//   npm run gen:commands      writes commands/ and then public/
//
// It also runs before `dev` and before `deploy`, beside the skill sync, so the served copy cannot
// drift from the source just because someone forgot. Rerunning it is safe: the directories are
// rebuilt, so a wrapper that is gone from commands/ is gone from the site too.
//
// Two shapes are served from the one source. Claude Code reads the flat wrapper, a file per name
// under ~/.claude/commands, and calls it /ink-brief. Codex removed custom prompts in 0.117, so
// there it is a skill instead: one folder per name, holding SKILL.md, mentioned as $ink-brief.
// Same words, same command, a frontmatter that says which skill it is and no $ARGUMENTS left in
// the body, because a skill has no argument substitution to do it for it.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const source = 'commands';
const target = 'public/commands';
const skills = 'public/skills/commands';

const names = readdirSync(source)
  .filter((file) => /^ink-[a-z-]+\.md$/.test(file))
  .map((file) => file.slice(0, -3))
  .sort();

// What a skill's body says instead of the placeholder. The words are simply the rest of the
// message, so naming that is all the body needs to do.
const ARGUMENTS = {
  'The subject, when the command was given one: $ARGUMENTS':
    'The subject, when the owner named one, is what they wrote beside the mention.',
  'Threads named on the command line: $ARGUMENTS':
    'Threads named beside the mention: those words. With none, the separate lines of work in the session.',
  'Topics named on the command line: $ARGUMENTS':
    'Topics named beside the mention: those words. With none, the distinct decisions in the session.',
};

function skillFor(name, wrapper) {
  const match = wrapper.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  if (!match) throw new Error(name + ' has no frontmatter to read a description from');
  const description = (match[1].match(/^description:\s*(.+)$/m) || [])[1];
  if (!description) throw new Error(name + ' has no description line');

  let body = match[2];
  for (const [from, to] of Object.entries(ARGUMENTS)) body = body.split(from).join(to);

  // A placeholder that survives would reach the model as literal characters, so this fails the
  // build instead of shipping one.
  if (body.includes('$ARGUMENTS')) throw new Error(name + ' still has a placeholder in its body');

  return [
    '---',
    'name: ' + name,
    // The list is long enough that an agent should never reach for one of these on its own: the
    // sentence after the description is the instruction that keeps filing to an explicit request.
    'description: ' + description + '. INK diary command: use only when the owner asks for it.',
    '---',
    '',
    body,
  ].join('\n');
}

rmSync(target, { recursive: true, force: true });
rmSync(skills, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
mkdirSync(skills, { recursive: true });

for (const name of names) {
  const wrapper = readFileSync(source + '/' + name + '.md', 'utf8');
  writeFileSync(target + '/' + name + '.md', wrapper);
  writeFileSync(skills + '/' + name + '.md', skillFor(name, wrapper));
}

// The install loop reads this, one name per line, with no extension: `ink-brief`, then it asks for
// ink-brief.md under /commands/ or under /skills/commands/. Nothing else belongs in it, and it is
// not a command itself.
writeFileSync(target + '/names.txt', names.join('\n') + '\n');

console.log(names.length + ' wrappers written to ' + target + ', plus names.txt');
console.log(names.length + ' skills written to ' + skills);

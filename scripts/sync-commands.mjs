// The 59 wrappers are written in commands/, and public/ is the asset directory the Worker serves,
// so a file there is a URL an agent can download. This copies them across, beside a bare list of
// names, because an install loop needs the list before it can fetch anything.
//
//   npm run gen:commands      writes commands/ and then public/commands/
//
// It also runs before `dev` and before `deploy`, beside the skill sync, so the served copy cannot
// drift from the source just because someone forgot. Rerunning it is safe: the directory is
// rebuilt, so a wrapper that is gone from commands/ is gone from the site too.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const source = 'commands';
const target = 'public/commands';

const names = readdirSync(source)
  .filter((file) => /^ink-[a-z-]+\.md$/.test(file))
  .map((file) => file.slice(0, -3))
  .sort();

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const name of names) {
  writeFileSync(target + '/' + name + '.md', readFileSync(source + '/' + name + '.md', 'utf8'));
}

// The install loop reads this, one name per line, with no extension: `ink-brief`, then it asks for
// ink-brief.md. Nothing else belongs in it, and it is not a command itself.
writeFileSync(target + '/names.txt', names.join('\n') + '\n');

console.log(names.length + ' wrappers written to ' + target + ', plus names.txt');

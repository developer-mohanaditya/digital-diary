// The skill is written in skills/ink/SKILL.md, and public/ is the asset directory the Worker
// serves, so a file there is a URL. This copies one to the other so an agent can fetch the rules
// from the site instead of from a checkout.
//
//   npm run gen:skill        writes public/skills/ink/SKILL.md
//
// It runs before `dev` and before `deploy`, so the served copy cannot drift from the source just
// because someone forgot. Rerunning it is safe.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = 'skills/ink/SKILL.md';
const target = 'public/skills/ink/SKILL.md';

const text = readFileSync(source, 'utf8');
let current = null;
try {
  current = readFileSync(target, 'utf8');
} catch {
  current = null;
}

mkdirSync(dirname(resolve(target)), { recursive: true });
writeFileSync(target, text);

const same = current === text;
console.log((same ? 'unchanged: ' : 'written: ') + target + ' (' + text.length + ' bytes)');

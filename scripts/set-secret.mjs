#!/usr/bin/env node
// Set ONE secret, in both places, without it touching your shell history or a chat.
//
//   npm run secret SUPABASE_SERVICE_KEY              # local file + Cloudflare
//   npm run secret SUPABASE_SERVICE_KEY -- --local   # local file only
//
// The prompt is silent: nothing is echoed, nothing is printed back.
//
// Local half: .dev.vars (gitignored). It replaces any existing line for that name, so a
// second run rotates the value instead of adding a duplicate.
//
// Cloud half: `wrangler secret put`, driven by CLOUDFLARE_API_TOKEN — the same token
// everything else uses. It only works if that token carries "Workers Scripts: Edit";
// an analytics-only token is refused by Cloudflare, and the value is still safe locally.
// Paste it once in Workers -> ink -> Settings -> Variables and Secrets.
//
// Verify the whole set afterwards with: npm run env:check

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const name = process.argv[2];
const localOnly = process.argv.includes('--local');

if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
  console.error('usage: npm run secret NAME [-- --local]\n       NAME is UPPER_SNAKE_CASE, e.g. TELEGRAM_BOT_TOKEN');
  process.exit(2);
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    let muted = false;
    rl._writeToOutput = (text) => {
      if (!muted) write(text);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true; // everything typed after the prompt stays invisible
  });
}

const value = (await ask(`${name} (input hidden): `)).trim();
if (!value) {
  console.error('empty value, nothing written');
  process.exit(1);
}
if (/[\r\n\t]/.test(value)) {
  console.error('value contains a newline or tab; paste it as one line');
  process.exit(1);
}

const FILE = '.dev.vars';
const lines = existsSync(FILE) ? readFileSync(FILE, 'utf8').split(/\r?\n/) : [];
let replaced = false;
const next = lines
  .map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || m[1] !== name) return line;
    if (replaced) return null; // collapse duplicates to one line
    replaced = true;
    return `${name}=${value}`;
  })
  .filter((line) => line !== null);

while (next.length && next[next.length - 1].trim() === '') next.pop();
if (!replaced) next.push(`${name}=${value}`);
next.push('');
writeFileSync(FILE, next.join('\n'));
console.log(`.dev.vars   ${name} ${value.length} chars${replaced ? ' (replaced)' : ' (added)'}`);

if (localOnly) process.exit(0);

const read = (key) => new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm').exec(readFileSync(FILE, 'utf8'))?.[1]?.trim();
const token = read('CLOUDFLARE_API_TOKEN');
const account = /^CLOUDFLARE_ACCOUNT_ID\s*=\s*"([^"]+)"/m.exec(
  existsSync('wrangler.toml') ? readFileSync('wrangler.toml', 'utf8') : '',
)?.[1];

if (!token || !account) {
  console.log('Cloudflare  skipped: needs CLOUDFLARE_API_TOKEN in .dev.vars and CLOUDFLARE_ACCOUNT_ID in wrangler.toml');
  process.exit(0);
}

const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
  input: value + '\n',
  env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account },
  stdio: ['pipe', 'inherit', 'inherit'],
});

if (r.status === 0) {
  console.log(`Cloudflare  ${name} updated`);
  process.exit(0);
}

console.log('');
console.log('Cloudflare refused CLOUDFLARE_API_TOKEN (it needs "Workers Scripts: Edit"). The local copy is written.');
console.log('Paste the value once here instead:');
console.log(`  Workers -> ink -> Settings -> Variables and Secrets -> Add -> ${name}`);
process.exit(1);

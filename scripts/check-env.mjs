#!/usr/bin/env node
// One command that answers "is everything in the right place?".
//
//   node scripts/check-env.mjs
//
// There are exactly three places a value can live, and this file is the list of which
// name belongs where:
//
//   1. wrangler.toml  [vars]  — plain values, committed, identical in production and
//                               local dev because `wrangler dev` loads them too.
//   2. Cloudflare             — secrets, set in the dashboard, used by the deployed Worker.
//   3. .dev.vars              — the SAME secret names, same values, for local runs.
//
// A name must appear in exactly one of (1) and (3). A name in both is the bug that made
// local dev read an empty SUPABASE_URL while production worked: .dev.vars wins, even
// when its value is blank.
//
// Values are never printed. Only names, lengths and verdicts.

import { existsSync, readFileSync } from 'node:fs';

// [name, description, must the deployed Worker have it too?]
// CLOUDFLARE_API_TOKEN is deliberately local-only: it belongs to a script, never the Worker.
const SECRETS = [
  ['SUPABASE_SERVICE_KEY', 'service_role key, used only by the Worker', true],
  ['SUPABASE_ANON_KEY', 'anon public key, used by the sign-in endpoint', 'when auth ships'],
  ['TELEGRAM_BOT_TOKEN', 'token from @BotFather', true],
  ['TELEGRAM_WEBHOOK_SECRET', 'secret Telegram sends with every update', true],
  ['CLOUDFLARE_API_TOKEN', 'Account Analytics: Read, for scripts only', false],
  ['DIARY_PASSPHRASE', 'interim page lock, removed when Supabase Auth ships', true],
];

const VARS_IN_TOML = ['SUPABASE_URL', 'ALLOWED_CHAT_ID', 'DIARY_TZ', 'OWNER_USER_ID', 'CLOUDFLARE_ACCOUNT_ID'];

function parsePairs(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(s);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out.push([m[1], value]);
  }
  return out;
}

const devVarsPairs = existsSync('.dev.vars') ? parsePairs(readFileSync('.dev.vars', 'utf8')) : [];
const devVars = new Map();
const duplicates = [];
for (const [k, v] of devVarsPairs) {
  if (devVars.has(k)) duplicates.push(k);
  devVars.set(k, v);
}

const tomlPairs = existsSync('wrangler.toml') ? parsePairs(readFileSync('wrangler.toml', 'utf8')) : [];
const toml = new Map(tomlPairs);

const problems = [];
const warnings = [];
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('name', 27)} ${pad('file', 10)} ${pad('state', 12)} cloud`);
console.log('--------------------------- ---------- ------------ ------------------');

for (const [name, what, cloud] of SECRETS) {
  const inDev = devVars.get(name);
  const inToml = toml.get(name);
  const cloudCol = cloud === true ? 'must match' : cloud || 'not needed';
  if (inDev === undefined) {
    problems.push(`${name} is missing from .dev.vars (${what})`);
    console.log(`${pad(name, 27)} ${pad('.dev.vars', 10)} ${pad('MISSING', 12)} ${cloudCol}`);
    continue;
  }
  if (inDev === '') {
    problems.push(`${name} is empty in .dev.vars (${what})`);
    console.log(`${pad(name, 27)} ${pad('.dev.vars', 10)} ${pad('EMPTY', 12)} ${cloudCol}`);
    continue;
  }
  if (inDev !== inDev.trim()) {
    problems.push(`${name} has surrounding whitespace in .dev.vars, which breaks comparisons`);
    console.log(`${pad(name, 27)} ${pad('.dev.vars', 10)} ${pad('whitespace', 12)} ${cloudCol}`);
    continue;
  }
  if (inToml !== undefined) {
    problems.push(`${name} is set in both wrangler.toml [vars] and .dev.vars; .dev.vars wins and hides the other`);
  }
  console.log(`${pad(name, 27)} ${pad('.dev.vars', 10)} ${pad(`${inDev.length} chars`, 12)} ${cloudCol}`);
}

console.log('');
for (const name of VARS_IN_TOML) {
  const inToml = toml.get(name);
  const inDev = devVars.get(name);
  if (inToml === undefined) {
    problems.push(`${name} is missing from wrangler.toml [vars]`);
    console.log(`${pad(name, 27)} ${pad('wrangler', 10)} ${pad('MISSING', 12)} via deploy`);
    continue;
  }
  if (inDev !== undefined) {
    problems.push(`${name} is duplicated in .dev.vars; remove it there so [vars] is used`);
    console.log(`${pad(name, 27)} ${pad('wrangler', 10)} ${pad(`${inToml.length} chars`, 12)} via deploy`);
    continue;
  }
  console.log(`${pad(name, 27)} ${pad('wrangler', 10)} ${pad(`${inToml.length} chars`, 12)} via deploy`);
}

// Shape checks that catch the usual copy mistakes without revealing the value.
const anon = devVars.get('SUPABASE_ANON_KEY') ?? '';
if (anon && !(anon.startsWith('eyJ') && anon.split('.').length === 3)) {
  problems.push('SUPABASE_ANON_KEY is not shaped like a JWT (expected eyJ... with two dots)');
}
const cf = devVars.get('CLOUDFLARE_API_TOKEN') ?? '';
if (cf && !/^[A-Za-z0-9_-]+$/.test(cf)) {
  problems.push('CLOUDFLARE_API_TOKEN contains characters a Cloudflare token never has');
}
const owner = toml.get('OWNER_USER_ID') ?? '';
if (owner && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner)) {
  problems.push('OWNER_USER_ID is not a UUID');
}
const acct = toml.get('CLOUDFLARE_ACCOUNT_ID') ?? '';
if (acct && !/^[0-9a-f]{32}$/i.test(acct)) {
  problems.push('CLOUDFLARE_ACCOUNT_ID is not a 32-character account tag');
}
for (const name of new Set(duplicates)) {
  problems.push(`${name} appears more than once in .dev.vars`);
}

if (existsSync('.env')) {
  warnings.push('.env still exists. Nothing reads it any more; .dev.vars is the only local file. Delete it.');
}
if (!existsSync('.dev.vars')) {
  problems.push('.dev.vars does not exist. Copy .dev.vars.example to .dev.vars, or run `npm run secret NAME` per name.');
}
console.log('Cloudflare values cannot be read back. `npm run secret NAME` writes both places when');
console.log('CLOUDFLARE_API_TOKEN carries "Workers Scripts: Edit"; otherwise paste in the dashboard.');

console.log('');
if (warnings.length) {
  console.log('warnings:');
  for (const w of warnings) console.log(`  - ${w}`);
}
if (problems.length) {
  console.log('problems:');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('\nCloudflare cannot hand its secret values back, so "present" here means present locally.');
  console.log('To write the same value to both places in one step: npm run secret NAME');
  process.exit(1);
}
console.log('All names are in place. Values must still match what Cloudflare holds.');

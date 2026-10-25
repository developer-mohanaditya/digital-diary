#!/usr/bin/env node
// What the deployed Worker actually carries, compared with wrangler.toml.
//
//   npm run bindings:check
//
// `wrangler deploy` uploads the bindings described in wrangler.toml, but nothing on this
// side ever reads back what landed. That is how the two halves drift apart: a var added
// to the file, a deploy that never ran, a value edited by hand in the dashboard. This
// command asks Cloudflare for the live version's binding list and diffs it.
//
// It needs CLOUDFLARE_API_TOKEN (from .dev.vars, or the environment) to carry
// "Account -> Workers Scripts -> Read". Edit the token in
// Cloudflare -> My Profile -> API Tokens. Analytics-only tokens are refused with a 403.
//
// What it compares:
//   [vars]              every non-secret name, present as plain_text, same value
//   required secrets    present as secret_text (the value is never read or printed)
//   platform bindings   [ai] and [assets] from the config
//   compatibility date  the live version's, so an old deploy is visible as an old deploy
//
// Exit codes: 0 in step, 1 drift found, 2 could not check (no token, no network, no read
// permission). Run it after a deploy, or from CI where the token is a repository secret.

import { existsSync, readFileSync } from 'node:fs';

const TOML = 'wrangler.toml';
const DEV_VARS = '.dev.vars';

// Must exist on the deployed Worker or that Worker half-works in production.
const REQUIRED_SECRETS = [
  ['SUPABASE_SERVICE_KEY', 'service_role key, the only database credential the Worker has'],
  ['TELEGRAM_BOT_TOKEN', 'without it the bot cannot reply'],
  ['TELEGRAM_WEBHOOK_SECRET', 'without it every webhook is rejected'],
  ['DIARY_PASSPHRASE', 'interim page lock'],
];
// Listed but not enforced: they arrive with later work, or have a fallback.
const OPTIONAL_SECRETS = [
  ['SUPABASE_ANON_KEY', 'public key for the sign-in endpoint'],
  ['DIARY_SESSION_SECRET', 'cookie signing key; falls back to DIARY_PASSPHRASE'],
];

function readDevVar(name) {
  if (!existsSync(DEV_VARS)) return undefined;
  for (const line of readFileSync(DEV_VARS, 'utf8').split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

if (!existsSync(TOML)) {
  console.error(`${TOML} not found. Run this from the project root.`);
  process.exit(2);
}

// Only `[vars]` matters here, and only its UPPER_SNAKE names: `main`, `binding` and
// `directory` are config for the build, not values the Worker sees.
const vars = new Map();
let section = '';
let scriptName = '';
let tomlCompat = '';
for (const raw of readFileSync(TOML, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const sec = /^\[([^\]]+)\]$/.exec(line);
  if (sec) {
    section = sec[1];
    continue;
  }
  const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"$/.exec(line);
  if (!kv) continue;
  const [, key, value] = kv;
  if (!section && key === 'name') scriptName = value;
  if (!section && key === 'compatibility_date') tomlCompat = value;
  if (section === 'vars' && /^[A-Z][A-Z0-9_]*$/.test(key)) vars.set(key, value);
}

if (!scriptName) {
  console.error(`${TOML} has no top-level name = "...", so there is no Worker to compare.`);
  process.exit(2);
}

// The account lives in [vars] because the Worker reads it too; the environment wins when
// someone is checking a different account than the one this checkout deploys to.
const account = process.env.CLOUDFLARE_ACCOUNT_ID || vars.get('CLOUDFLARE_ACCOUNT_ID') || '';
if (!account) {
  console.error('No account id: CLOUDFLARE_ACCOUNT_ID is missing from wrangler.toml [vars].');
  process.exit(2);
}

const token = process.env.CLOUDFLARE_API_TOKEN || readDevVar('CLOUDFLARE_API_TOKEN');
if (!token) {
  console.error(`No CLOUDFLARE_API_TOKEN in ${DEV_VARS} or the environment.`);
  console.error(`Add it with: npm run secret CLOUDFLARE_API_TOKEN -- --local`);
  process.exit(2);
}

const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${scriptName}/settings`;

let response;
try {
  response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
} catch (cause) {
  console.error(`Could not reach the Cloudflare API: ${cause.message}`);
  process.exit(2);
}

const body = await response.json().catch(() => ({}));
if (!body.success) {
  const message = body.errors?.[0]?.message ?? `HTTP ${response.status}`;
  console.error(`Could not read the deployed Worker (${message}).`);
  if (response.status === 401 || response.status === 403) {
    console.error('');
    console.error('The token is missing a permission this command needs:');
    console.error('  Cloudflare -> My Profile -> API Tokens -> edit the token');
    console.error('  -> Account permissions -> Workers Scripts -> Read -> Save');
    console.error('"Workers Scripts: Edit" already includes Read. Nothing was changed.');
  } else if (response.status === 404) {
    console.error('');
    console.error(`No Worker named "${scriptName}" in account ${account}, or the token cannot see it.`);
  }
  process.exit(2);
}

const bindings = body.result?.bindings ?? [];
const live = new Map(bindings.map((b) => [b.name, b]));

const problems = [];
const warnings = [];
const pad = (s, n) => String(s).padEnd(n);
// Column width, not a length limit: a value wider than the column would push every later
// column out of line, which is the one thing a drift table cannot afford.
const show = (v) => {
  const text = String(v);
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
};
const isSecret = (b) => b?.type === 'secret_text';

console.log(`Worker   ${scriptName}  (account ${account})`);
if (body.result?.modified_on) console.log(`Deployed ${body.result.modified_on}`);
console.log('');
console.log(`${pad('name', 24)} ${pad('expected', 26)} ${pad('live', 26)} verdict`);
console.log('------------------------ -------------------------- -------------------------- ------------------------------');

for (const [name, expected] of vars) {
  const b = live.get(name);
  if (!b) {
    problems.push(`${name} is in wrangler.toml [vars] but not on the deployed Worker; the deploy that should have carried it did not run`);
    console.log(`${pad(name, 24)} ${pad('plain_text', 26)} ${pad('absent', 26)} MISSING`);
    continue;
  }
  if (b.type !== 'plain_text') {
    problems.push(`${name} is deployed as ${b.type}, but wrangler.toml declares it as a plain [vars] value`);
    console.log(`${pad(name, 24)} ${pad('plain_text', 26)} ${pad(b.type, 26)} wrong type`);
    continue;
  }
  if (b.text !== expected) {
    problems.push(`${name} differs: wrangler.toml has "${show(expected)}", the Worker has "${show(b.text)}"`);
    console.log(`${pad(name, 24)} ${pad(show(expected), 26)} ${pad(show(b.text), 26)} differs`);
    continue;
  }
  console.log(`${pad(name, 24)} ${pad('plain_text', 26)} ${pad('matches', 26)} ok`);
}

for (const [name, why] of REQUIRED_SECRETS) {
  const b = live.get(name);
  if (!b) {
    problems.push(`${name} is not set on the deployed Worker (${why})`);
    console.log(`${pad(name, 24)} ${pad('secret_text', 26)} ${pad('absent', 26)} MISSING`);
    continue;
  }
  if (!isSecret(b)) {
    problems.push(`${name} is deployed as ${b.type}, so its value is readable in the dashboard and in any dump of the Worker; it must be a secret`);
    console.log(`${pad(name, 24)} ${pad('secret_text', 26)} ${pad(b.type, 26)} not a secret`);
    continue;
  }
  console.log(`${pad(name, 24)} ${pad('secret_text', 26)} ${pad('present', 26)} ok`);
}

for (const [name, why] of OPTIONAL_SECRETS) {
  const b = live.get(name);
  if (!b) {
    console.log(`${pad(name, 24)} ${pad('secret_text', 26)} ${pad('absent', 26)} optional, unset (${why})`);
    continue;
  }
  if (!isSecret(b)) {
    problems.push(`${name} is deployed as ${b.type}, but it is a secret name and must be secret_text`);
    console.log(`${pad(name, 24)} ${pad('secret_text', 26)} ${pad(b.type, 26)} not a secret`);
    continue;
  }
  console.log(`${pad(name, 24)} ${pad('secret_text', 26)} ${pad('present', 26)} ok`);
}

const AI = live.get('AI');
const ASSETS = live.get('ASSETS');
if (AI?.type !== 'ai') {
  problems.push('The AI binding is missing from the deployed Worker, so cleanup cannot run (wrangler.toml [ai])');
}
if (ASSETS?.type !== 'assets') {
  problems.push('The ASSETS binding is missing from the deployed Worker, so the web app cannot be served (wrangler.toml [assets])');
}
console.log(`${pad('AI', 24)} ${pad('ai', 26)} ${pad(AI?.type ?? 'absent', 26)} ${AI?.type === 'ai' ? 'ok' : 'MISSING'}`);
console.log(`${pad('ASSETS', 24)} ${pad('assets', 26)} ${pad(ASSETS?.type ?? 'absent', 26)} ${ASSETS?.type === 'assets' ? 'ok' : 'MISSING'}`);

// A plain value only the dashboard knows about is not an error today, but it is one deploy
// away from disappearing: `wrangler deploy` sets [vars] from the file.
const known = new Set([...vars.keys(), 'AI', 'ASSETS', ...REQUIRED_SECRETS.map(([n]) => n), ...OPTIONAL_SECRETS.map(([n]) => n)]);
for (const b of bindings) {
  if (known.has(b.name)) continue;
  if (b.type === 'plain_text') {
    warnings.push(`${b.name} is only on the Worker, not in wrangler.toml; the next deploy replaces the plain set. Add it to [vars], or set keep_vars = true`);
  } else if (!isSecret(b)) {
    warnings.push(`${b.name} (${b.type}) is not declared in wrangler.toml; the deploy that created it came from somewhere else`);
  }
}

const liveCompat = body.result?.compatibility_date;
if (liveCompat && tomlCompat && liveCompat !== tomlCompat) {
  warnings.push(`compatibility_date is ${liveCompat} on the Worker and ${tomlCompat} in wrangler.toml, so the live version predates the config`);
}

console.log('');
if (warnings.length) {
  console.log('warnings:');
  for (const w of warnings) console.log(`  - ${w}`);
}
if (problems.length) {
  console.log('problems:');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('');
  console.log('The fix is a deploy, not an edit on the Worker: `npm run deploy` uploads wrangler.toml.');
  console.log('For a secret, use `npm run secret NAME`, which writes .dev.vars and Cloudflare together.');
  process.exit(1);
}
console.log('The deployed Worker matches wrangler.toml.');
if (warnings.length) console.log('The warnings above are drift the next deploy may settle on its own.');

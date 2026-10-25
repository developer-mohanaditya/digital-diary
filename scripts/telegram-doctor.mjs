#!/usr/bin/env node
// Telegram connectivity doctor.
//
// Run this on your own machine, from the repository root:
//
//   node scripts/telegram-doctor.mjs                  # token + webhook status
//   node scripts/telegram-doctor.mjs --probe          # + hit the webhook URL with a wrong secret
//   node scripts/telegram-doctor.mjs --send 123456789 # + send a test message to a chat
//   node scripts/telegram-doctor.mjs --set https://your-worker.workers.dev/telegram/webhook
//   node scripts/telegram-doctor.mjs --delete         # unregister the webhook
//
// It reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from the environment,
// then from .dev.vars. Neither value is ever printed. `.dev.vars` is the only local
// file: the old `.env` was a second place for the same names, and two files is how
// they drift apart.

import { existsSync, readFileSync } from 'node:fs';

const API = 'https://api.telegram.org';

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

// A key with an empty value tells us nothing, so it never overrides a filled-in one.
const fileEnv = {};
for (const source of ['.dev.vars']) {
  for (const [key, value] of Object.entries(loadEnvFile(source))) {
    if (value) fileEnv[key] = value;
  }
}
const token = process.env.TELEGRAM_BOT_TOKEN || fileEnv.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || fileEnv.TELEGRAM_WEBHOOK_SECRET;

const args = process.argv.slice(2);
let registeredAt = 0; // set when --set succeeds, so a stale error is not reported as current
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function line(label, value) {
  console.log(`${label.padEnd(22)} ${value}`);
}

async function api(method, body) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
}

if (!token) {
  console.error('No TELEGRAM_BOT_TOKEN found in the environment, .dev.vars or .env.');
  process.exit(1);
}

console.log('Telegram doctor\n--------------');

// 1. Token
const me = await api('getMe');
if (me.status === 401 || me.json?.error_code === 401) {
  line('token', `REJECTED (${me.json?.description ?? 'unauthorized'})`);
  console.log('\nVerdict: Telegram does not recognise this bot token.');
  console.log('A revoked or regenerated token means the bot no longer exists for Telegram,');
  console.log('so updates are never delivered and getWebhookInfo cannot be read.');
  console.log('If you regenerated the token, this file is stale: get the current one from');
  console.log('@BotFather (/mybots -> API Token), put it in Cloudflare Worker secrets, and re-run');
  console.log('with --set <worker-url>/telegram/webhook.');
  process.exit(2);
}
if (!me.json?.ok) {
  line('token', `unexpected ${me.status}: ${me.json?.description ?? 'no body'}`);
  process.exit(2);
}
line('token', `valid (@${me.json.result.username}, id ${me.json.result.id})`);

// 2. Registered webhook
const info = await api('getWebhookInfo');
let w = info.json?.result ?? {};
line('webhook url', w.url ? w.url : '(not set — Telegram delivers nothing)');
line('pending updates', w.pending_update_count ?? 0);
line('max connections', w.max_connections ?? 'default');
if (w.allowed_updates) line('allowed updates', JSON.stringify(w.allowed_updates));
if (w.last_error_message) {
  const when = w.last_error_date ? new Date(w.last_error_date * 1000).toISOString() : 'unknown time';
  line('last error', `${w.last_error_message} (${when})`);
} else {
  line('last error', 'none reported');
}

// 3. Optional: is the endpoint actually a Worker with the secret check?
if (flag('--probe') && w.url) {
  const res = await fetch(w.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'definitely-wrong' },
    body: '{}',
  });
  const body = (await res.text()).slice(0, 120).replace(/\s+/g, ' ');
  line('probe (wrong secret)', `${res.status} ${body}`);
  if (res.status === 401) line('endpoint', 'alive, secret check working');
  else if (res.status === 200) line('endpoint', 'alive, but the secret check is NOT running');
  else line('endpoint', 'unexpected answer — URL probably points somewhere else');
}

// 4. Optional: can the bot message you?
const chatId = valueOf('--send');
if (chatId) {
  const sent = await api('sendMessage', { chat_id: Number(chatId), text: 'Telegram doctor: outbound path works.' });
  line('sendMessage', sent.json?.ok ? 'delivered' : `${sent.status} ${sent.json?.description ?? ''}`);
}

// 5. Optional: register the webhook (uses TELEGRAM_WEBHOOK_SECRET from .dev.vars/.env)
const setUrl = valueOf('--set');
if (setUrl) {
  if (!webhookSecret) {
    console.error('\nTELEGRAM_WEBHOOK_SECRET is missing, so setWebhook would leave the Worker rejecting updates.');
    process.exit(1);
  }
  const set = await api('setWebhook', {
    url: setUrl,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: flag('--drop-pending'),
  });
  line('setWebhook', set.json?.ok ? `registered ${setUrl}` : `${set.status} ${set.json?.description ?? ''}`);
  if (set.json?.ok) registeredAt = Math.floor(Date.now() / 1000);
  console.log('Now make sure the Cloudflare Worker secret TELEGRAM_WEBHOOK_SECRET holds that same value.');
}

if (flag('--delete')) {
  const del = await api('deleteWebhook', { drop_pending_updates: flag('--drop-pending') });
  line('deleteWebhook', del.json?.ok ? 'webhook removed' : `${del.status} ${del.json?.description ?? ''}`);
}

// Re-read after any change so the verdict describes the current state, not the old one.
if (setUrl || flag('--delete')) {
  w = (await api('getWebhookInfo')).json?.result ?? w;
  line('webhook now', w.url || '(not set)');
}

console.log('\nVerdict');
// Telegram keeps the last delivery error until a delivery succeeds, so after a fresh
// registration the old error still sits there and describes the past, not the present.
const staleError = registeredAt && w.last_error_date && w.last_error_date < registeredAt;
if (!w.url) console.log('- The webhook is not registered: messages never leave Telegram. Fix with --set.');
else if (staleError) console.log('- Registered just now; the error above predates it and clears on the next delivered message.');
else if (w.last_error_message) console.log('- Telegram is trying the URL but it fails. The error above names the cause.');
else if (w.pending_update_count > 0) console.log('- Updates are queued, so delivery is failing right now.');
else console.log('- Webhook is registered and Telegram reports no delivery errors.');

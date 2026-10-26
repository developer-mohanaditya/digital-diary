// The diary's MCP server, as a value: one factory, a message in, an answer out.
//
// Everything a client can ask for lives here so it can be tested without a process, a socket or
// a network. The stdio loop that drives it is in diary.mjs, and the two files are the whole
// server: no dependencies, because this project has none and the protocol surface a tools-only
// server needs is small.
//
// Two protocol revisions are spoken. 2026-07-28 removed the initialize handshake and made every
// request carry its version in _meta, with server/discover advertising what a server supports;
// 2025-11-25 is the handshake clients have shipped for years. A client that opens with either
// one gets a working server, which is what "add MCP support" has to mean while the two are
// both in the wild. Results carry resultType, which old clients ignore and new ones require.

export const SERVER_INFO = { name: 'digital-diary', version: '1.0.0' };
export const CURRENT_PROTOCOL = '2026-07-28';
export const LEGACY_PROTOCOL = '2025-11-25';
export const SUPPORTED_PROTOCOLS = [CURRENT_PROTOCOL, LEGACY_PROTOCOL];

// The same envelope the API uses, in the words a model needs in order to write something that
// belongs in this diary rather than something that merely parses.
const MARKUP =
  'Write it in the diary\'s markup: blank lines between paragraphs, lines starting with "- " for a list, ' +
  '**double asterisks** on the few words that carry the point, ==double equals== on a date or deadline ' +
  'not to forget. No headings, tables, code fences or emoji.';

export const TOOLS = [
  {
    name: 'diary_add_notes',
    title: 'Add notes to the diary',
    description:
      'File notes into Aweditya\'s private diary — the same diary his Telegram bot writes to. Use it when a ' +
      'session ends: one note for a single entry, several when the session covered distinct topics. ' +
      `${MARKUP} ` +
      'Each note needs text. category is one of class, learning, thought, quote, work, project, life, task, ' +
      'deadline, inbox (default inbox); mode is refine (the diary formats it), verbatim (keep the words exactly), ' +
      'reason or think; day is YYYY-MM-DD (today unless the session belongs to another day); due is required on a ' +
      'deadline. Passing the same idempotencyKey twice files nothing the second time, so a retry is safe. ' +
      'The answer is the receipt, and the owner gets the same one on Telegram.',
    inputSchema: {
      type: 'object',
      properties: {
        notes: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          description: 'One note per entry you want the diary to hold.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The note itself, up to 4000 characters.' },
              category: { type: 'string', enum: ['class', 'learning', 'thought', 'quote', 'work', 'project', 'life', 'task', 'deadline', 'inbox'] },
              mode: { type: 'string', enum: ['refine', 'verbatim', 'reason', 'think'] },
              day: { type: 'string', description: 'YYYY-MM-DD in the diary\'s timezone.' },
              at: { type: 'string', description: 'ISO timestamp for when the work happened; its day must match day.' },
              due: { type: 'string', description: 'YYYY-MM-DD, on a deadline note only.' },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
        client: { type: 'string', description: 'A short name for this app, like "claude-code", shown on the receipt.' },
        idempotencyKey: { type: 'string', description: 'Stable for one session, so a retry files nothing twice.' },
        ack: { type: 'boolean', description: 'Whether to confirm on Telegram. Default true; false writes silently.' },
      },
      required: ['notes'],
      additionalProperties: false,
    },
  },
  {
    name: 'diary_whoami',
    title: 'What this key may do',
    description:
      'Report the diary key this server is using: its name, scopes, rate limits and policy — which categories and ' +
      'dates it may touch, and whether it may read text at all. Call it when a write is refused, or before telling ' +
      'the user what can or cannot be filed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const text = (value) => ({ type: 'text', text: value });

// Notes that failed one at a time are the part of a receipt a model must not round off to
// "done": the caller is going to tell a person what happened.
function receiptSummary(receipt) {
  if (!receipt) return 'The diary answered without a receipt.';
  const lines = [];
  const stored = receipt.counts?.notes ?? 0;
  const duplicates = (receipt.notes ?? []).filter((n) => n.status === 'duplicate').length;
  const failed = (receipt.notes ?? []).filter((n) => n.status === 'failed');
  if (stored) {
    const tally = Object.entries(receipt.counts?.byCategory ?? {}).map(([c, n]) => `${c} ${n}`).join(', ');
    lines.push(`Filed ${stored} note${stored === 1 ? '' : 's'} (${tally}) · ${receipt.counts?.words ?? 0} words.`);
  }
  if (duplicates) lines.push(`${duplicates} ${duplicates === 1 ? 'note was' : 'notes were'} already stored by an earlier request.`);
  for (const r of receipt.reminders ?? []) lines.push(`Deadline ${r.due}, first ping ${r.firstPingAt.slice(0, 10)}.`);
  if (receipt.telegram === 'sent') lines.push('Confirmed on Telegram.');
  if (receipt.telegram === 'failed') lines.push('Telegram confirmation failed; the notes are stored.');
  if (receipt.telegram === 'skipped' && !stored) lines.push('Nothing new to confirm on Telegram.');
  for (const f of failed) lines.push(`Failed: ${f.category} — ${f.error ?? 'unknown error'}`);
  lines.push(`Receipt ${receipt.code}.`);
  return lines.join('\n');
}

export function createDiaryServer({ apiUrl, apiKey, fetchImpl = fetch }) {
  const base = String(apiUrl || 'https://awedityasdiary.aweditya-sm.workers.dev').replace(/\/+$/, '');

  // One place the key is attached, so no tool can forget it and none of them can log it.
  const call = async (path, init = {}) => {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };

  const refusal = (status, body) => {
    const error = body && body.error ? body.error : null;
    const detail = error ? `${error.code}: ${error.message}` : `the diary answered ${status}`;
    return {
      isError: true,
      content: [text(`The diary refused that — ${detail}`)],
      structuredContent: { ok: false, status, error },
    };
  };

  const addNotes = async (args) => {
    const payload = { notes: args.notes, ack: args.ack === undefined ? true : args.ack };
    if (args.client) payload.client = args.client;
    if (args.idempotencyKey) payload.idempotencyKey = args.idempotencyKey;
    const { status, body } = await call('/api/v1/notes', { method: 'POST', body: JSON.stringify(payload) });
    if (status !== 200 || !body || !body.ok) return refusal(status, body);
    return {
      content: [text(receiptSummary(body.receipt))],
      structuredContent: body.receipt,
    };
  };

  const whoami = async () => {
    const { status, body } = await call('/api/v1/me');
    if (status !== 200 || !body || !body.ok) return refusal(status, body);
    const key = body.key;
    const policy = key.policy ?? {};
    const lines = [
      `Key: ${key.name} (${key.prefix}…).`,
      `Scopes: ${key.scopes.join(', ')}.`,
      `Limits: ${key.perMinute} requests a minute, ${key.perDay} a day.`,
      `Categories: ${policy.categories ? policy.categories.join(', ') : 'every category'}.`,
      `Dates: ${policy.from || policy.to ? `${policy.from ?? 'any'} to ${policy.to ?? 'any'}` : 'any day'}.`,
      `Can read note text: ${policy.text === 'none' ? 'no' : 'yes'}.`,
    ];
    return { content: [text(lines.join('\n'))], structuredContent: body.key };
  };

  const results = (result) => ({ resultType: 'complete', ...result });

  const handleToolCall = async (params = {}) => {
    if (!apiKey) {
      return {
        isError: true,
        content: [text('DIARY_API_KEY is not set, so this server cannot reach the diary. Add it to the MCP server\'s env.')],
      };
    }
    if (params.name === 'diary_add_notes') {
      const args = params.arguments ?? {};
      if (!Array.isArray(args.notes) || !args.notes.length) {
        return { isError: true, content: [text('Pass at least one note: diary_add_notes takes { notes: [ { text: "..." } ] }.')] };
      }
      return await addNotes(args);
    }
    if (params.name === 'diary_whoami') return await whoami();
    return { isError: true, content: [text(`There is no tool called ${String(params.name).slice(0, 60)}.`) ] };
  };

  // A message in, a response object out — or null for a notification, which takes no answer.
  const handle = async (message) => {
    const id = message && message.id !== undefined ? message.id : null;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, text_) => ({ jsonrpc: '2.0', id, error: { code, message: text_ } });

    try {
      switch (message?.method) {
        case 'server/discover':
          return reply(results({
            protocolVersion: CURRENT_PROTOCOL,
            supportedVersions: SUPPORTED_PROTOCOLS,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          }));
        case 'initialize': {
          const asked = message.params?.protocolVersion;
          return reply(results({
            protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : CURRENT_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions: 'Add notes to Aweditya\'s diary. Read the key\'s limits with diary_whoami when a write is refused.',
          }));
        }
        // The current revision removed ping; a legacy client may still send it.
        case 'ping':
          return reply(results({}));
        case 'tools/list':
          return reply(results({ tools: TOOLS, ttlMs: 300000, cacheScope: 'private' }));
        case 'tools/call':
          return reply(await handleToolCall(message.params));
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/progress':
          return null;
        default:
          if (typeof message?.method !== 'string') return fail(-32600, 'Invalid request.');
          return fail(-32601, `Method not found: ${message.method.slice(0, 60)}`);
      }
    } catch (err) {
      // A transport failure is the one thing that reaches here: the tools answer their own
      // refusals, and a diary that is unreachable should say so rather than look like a crash.
      return reply({
        isError: true,
        content: [text(`Could not reach the diary at ${base}: ${err instanceof Error ? err.message : String(err)}`)],
      });
    }
  };

  return { handle, tools: TOOLS, baseUrl: base };
}

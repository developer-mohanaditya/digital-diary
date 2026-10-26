import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiaryServer } from '../mcp/server.mjs';

// The MCP server. Two things are worth proving: that it speaks both the current revision and the
// handshake older clients open with, and that its two tools say what the diary actually did —
// including a refusal, which a model has to relay rather than paper over. The last test runs the
// real entry point as a process, because the framing is half of what an MCP server is.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'mcp', 'diary.mjs');

const KEY = 'ddk_live_test';

const answer = (body, status = 200) => ({ status, json: async () => body });

const receipt = {
  code: 'rc_9f1a20',
  duplicate: false,
  notes: [{ id: 'note-1', day: '2026-10-26', category: 'work', mode: 'refine', status: 'stored', cleanup: 'formatted', words: 12, error: null }],
  counts: { notes: 1, words: 12, byCategory: { work: 1 } },
  reminders: [],
  usage: { tokensIn: 120, tokensOut: 30, models: ['@cf/zai-org/glm-4.7-flash'] },
  telegram: 'sent',
  preview: 'Shipped the write API.',
};

const server = (fetchImpl) => createDiaryServer({ apiUrl: 'https://diary.test', apiKey: KEY, fetchImpl });

afterEach(() => vi.unstubAllGlobals());

describe('the MCP server', () => {
  it('advertises itself to a client that asks as the current revision does', async () => {
    const res = await server(vi.fn()).handle({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
    expect(res.result.protocolVersion).toBe('2026-07-28');
    expect(res.result.supportedVersions).toContain('2025-11-25');
    expect(res.result.capabilities).toEqual({ tools: {} });
    expect(res.result.resultType).toBe('complete');
  });

  it('answers the legacy handshake, and falls back when the version is unknown', async () => {
    const s = server(vi.fn());
    const old = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    expect(old.result.protocolVersion).toBe('2025-11-25');
    const unknown = await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(unknown.result.protocolVersion).toBe('2026-07-28');
    expect(unknown.result.serverInfo.name).toBe('digital-diary');
  });

  it('says nothing back to a notification', async () => {
    expect(await server(vi.fn()).handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('lists the two tools with their schemas, uncacheable by anyone else', async () => {
    const res = await server(vi.fn()).handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.result.tools.map((t) => t.name)).toEqual(['diary_add_notes', 'diary_whoami']);
    expect(res.result.tools[0].inputSchema.required).toEqual(['notes']);
    expect(res.result.tools[0].inputSchema.properties.notes.items.required).toEqual(['text']);
    expect(res.result.cacheScope).toBe('private');
  });

  it('files notes through the API with the key, and answers with the receipt', async () => {
    const fetchImpl = vi.fn(async () => answer({ ok: true, receipt }));
    const res = await server(fetchImpl).handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'diary_add_notes', arguments: { notes: [{ text: 'Shipped the write API.' }], client: 'claude-code', idempotencyKey: 'session-1' } },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://diary.test/api/v1/notes');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body)).toEqual({ notes: [{ text: 'Shipped the write API.' }], ack: true, client: 'claude-code', idempotencyKey: 'session-1' });
    expect(res.result.isError).toBeUndefined();
    expect(res.result.content[0].text).toContain('Filed 1 note (work 1)');
    expect(res.result.content[0].text).toContain('Confirmed on Telegram.');
    expect(res.result.content[0].text).toContain('Receipt rc_9f1a20');
    expect(res.result.structuredContent).toEqual(receipt);
  });

  it('relays a refusal as its own error, with the diary\'s words', async () => {
    const fetchImpl = vi.fn(async () => answer({ ok: false, error: { code: 'out_of_policy', message: 'This key cannot write into life: it is limited to work.' } }, 403));
    const res = await server(fetchImpl).handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'diary_add_notes', arguments: { notes: [{ text: 'x', category: 'life' }] } },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('out_of_policy');
    expect(res.result.content[0].text).toContain('limited to work');
  });

  it('reports a partial batch rather than rounding it off to done', async () => {
    const fetchImpl = vi.fn(async () => answer({
      ok: true,
      receipt: {
        ...receipt,
        notes: [
          receipt.notes[0],
          { id: null, day: '2026-10-26', category: 'life', mode: 'refine', status: 'failed', cleanup: 'failed', words: 0, error: 'Supabase 500: nope' },
        ],
        counts: { notes: 1, words: 12, byCategory: { work: 1 } },
      },
    }));
    const res = await server(fetchImpl).handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'diary_add_notes', arguments: { notes: [{ text: 'a' }, { text: 'b' }] } },
    });
    expect(res.result.content[0].text).toContain('Failed: life — Supabase 500: nope');
  });

  it('tells the model what the key may do', async () => {
    const fetchImpl = vi.fn(async () => answer({
      ok: true,
      key: {
        name: 'Demo for Agents', prefix: 'ddk_live_abc', scopes: ['notes:write'],
        policy: { categories: ['work'], from: '2026-10-01', to: null, text: 'clean' },
        perMinute: 30, perDay: 300,
      },
    }));
    const res = await server(fetchImpl).handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diary_whoami', arguments: {} } });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://diary.test/api/v1/me');
    expect(res.result.content[0].text).toContain('Demo for Agents');
    expect(res.result.content[0].text).toContain('30 requests a minute');
    expect(res.result.content[0].text).toContain('Categories: work');
  });

  it('refuses to pretend it has a key', async () => {
    const fetchImpl = vi.fn();
    const bare = createDiaryServer({ apiUrl: 'https://diary.test', fetchImpl });
    const res = await bare.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diary_whoami', arguments: {} } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('DIARY_API_KEY');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers an unknown method as JSON-RPC says to', async () => {
    const res = await server(vi.fn()).handle({ jsonrpc: '2.0', id: 9, method: 'diary/teleport', params: {} });
    expect(res.error.code).toBe(-32601);
  });

  it('runs as a process: one JSON message a line, and nothing else on stdout', async () => {
    const api = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        key: {
          name: 'Demo for Agents', prefix: 'ddk_live_abc', scopes: ['notes:write'],
          policy: { categories: null, from: null, to: null, text: 'clean' }, perMinute: 30, perDay: 300,
        },
      }));
    });
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
    const port = api.address().port;

    const child = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, DIARY_API_URL: `http://127.0.0.1:${port}`, DIARY_API_KEY: KEY },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [];
    let rest = '';
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the server did not answer in time')), 10000);
      child.stdout.on('data', (chunk) => {
        rest += chunk;
        for (let at = rest.indexOf('\n'); at >= 0; at = rest.indexOf('\n')) {
          lines.push(JSON.parse(rest.slice(0, at)));
          rest = rest.slice(at + 1);
        }
        if (lines.length >= 2) { clearTimeout(timer); resolve(); }
      });
      child.on('error', reject);
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diary_whoami', arguments: {} } })}\n`);
    await answered;
    child.kill();
    await new Promise((resolve) => api.close(resolve));

    expect(lines.map((l) => l.id)).toEqual([1, 2]);
    expect(lines[0].result.protocolVersion).toBe('2025-11-25');
    expect(lines[1].result.content[0].text).toContain('300');
    expect(rest).toBe('');
  });
});

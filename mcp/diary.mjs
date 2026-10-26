#!/usr/bin/env node
// The stdio loop for the diary's MCP server: one JSON-RPC message per line in, one per line out.
//
// Nothing else is ever written to stdout — a stray print would corrupt the stream — so anything
// worth seeing goes to stderr, where a client keeps it as the server's log.
//
//   DIARY_API_KEY=ddk_live_… DIARY_API_URL=https://<worker> node mcp/diary.mjs
//
// The key is read from the environment and never logged. Configure it in the client rather than
// in a file in this repository.

import { createDiaryServer } from './server.mjs';

const server = createDiaryServer({
  apiUrl: process.env.DIARY_API_URL,
  apiKey: process.env.DIARY_API_KEY,
});

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const onLine = async (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  try {
    const response = await server.handle(message);
    if (response) write(response);
  } catch (err) {
    // The last resort: the handler answers its own failures, so reaching here means something
    // outside them broke. The request still gets an answer rather than silence.
    console.error('mcp handler failed', err);
    const id = message && message.id !== undefined ? message.id : null;
    write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
  }
};

let buffer = '';
// Requests are handled one at a time, in the order they arrived. A client may pipeline them, and
// filing notes out of order — or twice at once — would let two identical requests race each other
// into the diary. The queue is the whole of the concurrency policy: one message, then the next.
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    queue = queue.then(() => onLine(line));
  }
});
process.stdin.on('end', () => {
  // The client closed the pipe: the server's work is done.
  process.exit(0);
});

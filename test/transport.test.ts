import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HttpForwarder,
  decodePayloads,
  decodeSSE,
  errorEnvelope,
  errorMessageIn,
  withRequestId,
} from '../src/transport.js';

test('a JSON answer is one payload, a 202 is none', () => {
  assert.deepEqual(
    decodePayloads({ status: 200, contentType: 'application/json', body: '{"jsonrpc":"2.0","id":1,"result":{}}' }),
    [{ jsonrpc: '2.0', id: 1, result: {} }],
  );
  assert.deepEqual(decodePayloads({ status: 202, contentType: '', body: '' }), []);
  assert.deepEqual(decodePayloads({ status: 200, contentType: 'application/json', body: '  ' }), []);
});

test('an event stream is decoded frame by frame, skipping comments', () => {
  const body = ': keep-alive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\n';
  assert.deepEqual(decodeSSE(body), [
    { jsonrpc: '2.0', id: 1, result: { a: 1 } },
    { jsonrpc: '2.0', method: 'notifications/x' },
  ]);
  assert.deepEqual(decodePayloads({ status: 200, contentType: 'text/event-stream; charset=utf-8', body }).length, 2);
});

test('Pastea’s null-id gate errors get the request’s id back; results are untouched', () => {
  const gateError = { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Not connected.' } };
  assert.deepEqual(withRequestId(gateError, 7), { ...gateError, id: 7 });
  assert.deepEqual(withRequestId(gateError, undefined), gateError);
  const result = { jsonrpc: '2.0', id: 3, result: {} };
  assert.equal(withRequestId(result, 7), result);
  const ownId = { jsonrpc: '2.0', id: 3, error: { code: -1, message: 'x' } };
  assert.equal(withRequestId(ownId, 7), ownId);
});

test('error envelopes and message extraction', () => {
  assert.deepEqual(errorEnvelope(4, -32601, 'Method not found'), {
    jsonrpc: '2.0',
    id: 4,
    error: { code: -32601, message: 'Method not found' },
  });
  assert.equal(errorEnvelope(undefined, -32700, 'Parse error').id, null);
  assert.equal(
    errorMessageIn({ status: 401, contentType: 'application/json', body: '{"error":{"message":"Not connected."}}' }),
    'Not connected.',
  );
  assert.equal(errorMessageIn({ status: 401, contentType: '', body: 'nope' }), null);
});

test('the forwarder sends the bearer, both accept types and the protocol version', async () => {
  let seen: { url: string; headers: Record<string, string>; body: unknown } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = {
      url: input.toString(),
      headers: init?.headers as Record<string, string>,
      body: init?.body,
    };
    return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  const forwarder = new HttpForwarder(new URL('http://127.0.0.1:41417/mcp'), { fetch: fetchImpl });
  const result = await forwarder.forward('{"jsonrpc":"2.0","id":1,"method":"ping"}', 'pastea_mcp_t', '2025-06-18');
  assert.equal(result.status, 200);
  assert.ok(seen);
  const request = seen as unknown as { url: string; headers: Record<string, string>; body: unknown };
  assert.equal(request.url, 'http://127.0.0.1:41417/mcp');
  assert.equal(request.headers['Authorization'], 'Bearer pastea_mcp_t');
  assert.equal(request.headers['Accept'], 'application/json, text/event-stream');
  assert.equal(request.headers['MCP-Protocol-Version'], '2025-06-18');
  assert.equal(request.body, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
});

test('an oversized answer is refused before it is read into memory', async () => {
  const fetchImpl = (async () =>
    new Response('x', { status: 200, headers: { 'Content-Length': '99999999' } })) as typeof fetch;
  const forwarder = new HttpForwarder(new URL('http://127.0.0.1:41417/mcp'), {
    fetch: fetchImpl,
    maxResponseBytes: 1024,
  });
  await assert.rejects(forwarder.forward('{}', 't'), /cap 1024/);
});

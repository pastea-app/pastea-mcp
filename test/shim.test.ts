import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PairingResult } from '../src/pairing.js';
import { DENIAL_COOLDOWN_MS, McpShim, type ShimDeps } from '../src/shim.js';
import { STATUS_TOOL } from '../src/status-tool.js';
import type { ForwardResult, HttpForwarder } from '../src/transport.js';

const endpoint = new URL('http://127.0.0.1:41417/mcp');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Harness {
  shim: McpShim;
  notifications: unknown[];
  logs: string[];
  saved: Array<{ endpoint: string; token: string; storageDirectory: string }>;
  cleared: string[];
  pairCalls: number;
  forwarded: Array<{ frame: Record<string, unknown>; token: string; protocolVersion?: string }>;
  clock: { now: number };
}

interface HarnessOptions {
  endpoint?: URL | null;
  token?: string | null;
  pair?: () => Promise<PairingResult>;
  answer?: (frame: Record<string, unknown>) => ForwardResult;
}

function json(status: number, body: unknown): ForwardResult {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function harness(options: HarnessOptions = {}): Harness {
  const state: Harness = {
    shim: undefined as unknown as McpShim,
    notifications: [],
    logs: [],
    saved: [],
    cleared: [],
    pairCalls: 0,
    forwarded: [],
    clock: { now: 1_000_000 },
  };
  let token = options.token ?? null;
  const deps: ShimDeps = {
    version: 'test',
    discover: async () => (options.endpoint === undefined ? endpoint : options.endpoint),
    findToken: async () => token,
    saveToken: async (e, t, storageDirectory) => {
      token = t;
      state.saved.push({ endpoint: e.toString(), token: t, storageDirectory });
    },
    clearToken: async (e) => {
      token = null;
      state.cleared.push(e.toString());
    },
    pair: async () => {
      state.pairCalls += 1;
      return options.pair ? options.pair() : { status: 'denied' };
    },
    forwarder: () =>
      ({
        forward: async (frame: string, usedToken: string, protocolVersion?: string) => {
          const parsed = JSON.parse(frame) as Record<string, unknown>;
          state.forwarded.push({
            frame: parsed,
            token: usedToken,
            ...(protocolVersion ? { protocolVersion } : {}),
          });
          if (options.answer) return options.answer(parsed);
          if (!('id' in parsed)) return { status: 202, contentType: '', body: '' };
          return json(200, { jsonrpc: '2.0', id: parsed.id, result: {} });
        },
      }) as unknown as HttpForwarder,
    notify: (payload) => {
      state.notifications.push(payload);
    },
    log: (message) => {
      state.logs.push(message);
    },
    now: () => state.clock.now,
  };
  state.shim = new McpShim(deps);
  return state;
}

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
});
const initialized = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
const toolsList = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const statusCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'pastea_status', arguments: {} },
});
const searchCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'search_clips', arguments: { query: 'x' } },
});

type Result = { jsonrpc: string; id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

test('with no Pastea, the handshake completes and one status tool is offered', async () => {
  const h = harness({ endpoint: null });
  await h.shim.start();

  const [init] = (await h.shim.handle(initialize)) as Result[];
  assert.equal(init?.id, 1);
  assert.equal(init?.result?.['protocolVersion'], '2025-06-18');
  assert.deepEqual(init?.result?.['capabilities'], { tools: { listChanged: true } });
  assert.match(String(init?.result?.['instructions']), /isn't running/);
  assert.deepEqual(await h.shim.handle(initialized), []);

  const [list] = (await h.shim.handle(toolsList)) as Result[];
  assert.deepEqual(list?.result?.['tools'], [STATUS_TOOL]);

  const [call] = (await h.shim.handle(searchCall)) as Result[];
  assert.equal(call?.id, 4);
  assert.equal(call?.result?.['isError'], true);

  const [ping] = (await h.shim.handle('{"jsonrpc":"2.0","id":9,"method":"ping"}')) as Result[];
  assert.deepEqual(ping, { jsonrpc: '2.0', id: 9, result: {} });
  assert.deepEqual(await h.shim.handle('{"jsonrpc":"2.0","method":"notifications/cancelled"}'), []);
  const [unknown] = (await h.shim.handle('{"jsonrpc":"2.0","id":5,"method":"resources/read"}')) as Result[];
  assert.equal(unknown?.error?.code, -32601);
  const [bad] = (await h.shim.handle('not json')) as Result[];
  assert.equal(bad?.error?.code, -32700);
  assert.equal(h.forwarded.length, 0);
});

test('an unpaired bridge asks Pastea while Claude is still starting, then announces the tools', async () => {
  const pairing = deferred<PairingResult>();
  const h = harness({
    token: null,
    pair: () => pairing.promise,
    answer: (frame) =>
      frame.method === 'tools/list'
        ? json(200, { jsonrpc: '2.0', id: frame.id, result: { tools: [{ name: 'search_clips', description: 'x', inputSchema: {} }] } })
        : json(200, { jsonrpc: '2.0', id: frame.id, result: {} }),
  });
  await h.shim.start();
  assert.equal(h.pairCalls, 1);
  assert.equal(h.shim.state.kind, 'degraded');

  const [init] = (await h.shim.handle(initialize)) as Result[];
  assert.match(String(init?.result?.['instructions']), /asking the user to allow/);
  await h.shim.handle(initialized);
  assert.deepEqual(h.notifications, []);

  pairing.resolve({
    status: 'allowed',
    token: 'pastea_mcp_new',
    endpoint: endpoint.toString(),
    bundleId: 'com.nexolabs.pastea',
    storageDirectory: 'Pastea',
  });
  await h.shim.settle();
  assert.equal(h.shim.state.kind, 'live');
  assert.deepEqual(h.saved, [{ endpoint: endpoint.toString(), token: 'pastea_mcp_new', storageDirectory: 'Pastea' }]);
  assert.deepEqual(h.notifications, [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);

  const [list] = (await h.shim.handle(toolsList)) as Result[];
  const tools = list?.result?.['tools'] as Array<{ name: string }>;
  assert.deepEqual(tools.map((tool) => tool.name), ['search_clips', 'pastea_status']);
  assert.equal(h.forwarded.at(-1)?.token, 'pastea_mcp_new');
  assert.equal(h.forwarded.at(-1)?.protocolVersion, '2025-06-18');
});

test('a tools/list_changed that lands before initialized waits for it', async () => {
  const h = harness({
    token: null,
    pair: async () => ({
      status: 'allowed',
      token: 't',
      endpoint: endpoint.toString(),
      bundleId: '',
      storageDirectory: 'Pastea',
    }),
  });
  await h.shim.start();
  await h.shim.settle();
  assert.equal(h.shim.state.kind, 'live');
  assert.deepEqual(h.notifications, []);
  await h.shim.handle(initialize);
  assert.deepEqual(h.notifications, []);
  await h.shim.handle(initialized);
  assert.equal(h.notifications.length, 1);
});

test('with a stored token, initialize is forwarded and marked listChanged', async () => {
  const h = harness({
    token: 'pastea_mcp_stored',
    answer: (frame) =>
      json(200, {
        jsonrpc: '2.0',
        id: frame.id,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'Pastea', version: '1.3.0' } },
      }),
  });
  await h.shim.start();
  assert.equal(h.shim.state.kind, 'live');
  assert.equal(h.pairCalls, 0);
  const [init] = (await h.shim.handle(initialize)) as Result[];
  assert.deepEqual(init?.result?.['capabilities'], { tools: { listChanged: true } });
  assert.deepEqual((init?.result?.['serverInfo'] as Record<string, unknown>)['name'], 'Pastea');
  assert.equal(h.forwarded[0]?.token, 'pastea_mcp_stored');
});

test('a 401 drops the token, re-pairs, and answers that request with the id it came with', async () => {
  const pairing = deferred<PairingResult>();
  const h = harness({
    token: 'pastea_mcp_revoked',
    pair: () => pairing.promise,
    // The handshake still works; the token dies on the first tool call.
    answer: (frame) =>
      frame.method === 'tools/call'
        ? json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Not connected.' } })
        : 'id' in frame
          ? json(200, { jsonrpc: '2.0', id: frame.id, result: {} })
          : { status: 202, contentType: '', body: '' },
  });
  await h.shim.start();
  await h.shim.handle(initialize);
  await h.shim.handle(initialized);
  h.notifications.length = 0;

  const [reply] = (await h.shim.handle(searchCall)) as Result[];
  assert.equal(reply?.id, 4);
  assert.equal(reply?.error?.code, -32001);
  assert.match(reply?.error?.message ?? '', /^Not connected\. Pastea is asking the user/);
  assert.deepEqual(h.cleared, [endpoint.toString()]);
  assert.equal(h.pairCalls, 1);
  assert.equal(h.shim.state.kind, 'degraded');
  // Tools went away: Claude is told to re-list.
  assert.equal(h.notifications.length, 1);

  pairing.resolve({ status: 'denied' });
  await h.shim.settle();
  const [status] = (await h.shim.handle(statusCall)) as Result[];
  const content = status?.result?.['content'] as Array<{ text: string }>;
  assert.match(content[0]?.text ?? '', /declined/);
});

test('a 403 (Pro lapsed) passes through with the id patched and the token kept', async () => {
  const h = harness({
    token: 'pastea_mcp_ok',
    answer: () => json(403, { jsonrpc: '2.0', id: null, error: { code: -32002, message: 'Pastea Pro is required for MCP access.' } }),
  });
  await h.shim.start();
  const [reply] = (await h.shim.handle(searchCall)) as Result[];
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 4, error: { code: -32002, message: 'Pastea Pro is required for MCP access.' } });
  assert.equal(h.shim.state.kind, 'live');
  assert.deepEqual(h.cleared, []);
});

test('pastea_status re-discovers a Pastea that has come back', async () => {
  let there = false;
  const h = harness({ token: 'pastea_mcp_stored' });
  // Swap discovery under the shim: absent first, present later.
  const deps = (h.shim as unknown as { deps: ShimDeps }).deps;
  deps.discover = async () => (there ? endpoint : null);
  await h.shim.start();
  assert.equal(h.shim.state.kind, 'degraded');

  let [status] = (await h.shim.handle(statusCall)) as Result[];
  let content = status?.result?.['content'] as Array<{ text: string }>;
  assert.match(content[0]?.text ?? '', /isn't running/);

  there = true;
  [status] = (await h.shim.handle(statusCall)) as Result[];
  content = status?.result?.['content'] as Array<{ text: string }>;
  assert.match(content[0]?.text ?? '', /connected/);
  assert.equal(h.shim.state.kind, 'live');
});

test('after a denial, pastea_status re-asks only once the cooldown has passed', async () => {
  const h = harness({ token: null, pair: async () => ({ status: 'denied' }) });
  await h.shim.start();
  await h.shim.settle();
  assert.equal(h.pairCalls, 1);
  assert.equal(h.shim.state.kind, 'degraded');

  await h.shim.handle(statusCall);
  await h.shim.settle();
  assert.equal(h.pairCalls, 1);

  h.clock.now += DENIAL_COOLDOWN_MS;
  await h.shim.handle(statusCall);
  await h.shim.settle();
  assert.equal(h.pairCalls, 2);
});

test('a Pastea that stops answering degrades to unreachable and says so', async () => {
  const h = harness({
    token: 'pastea_mcp_ok',
    answer: () => {
      throw new TypeError('fetch failed');
    },
  });
  await h.shim.start();
  const [reply] = (await h.shim.handle(searchCall)) as Result[];
  assert.equal(reply?.id, 4);
  assert.equal(reply?.error?.code, -32603);
  assert.match(reply?.error?.message ?? '', /isn't running/);
  assert.equal(h.shim.state.kind, 'degraded');
});

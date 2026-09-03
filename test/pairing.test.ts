import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pair, pairingURL, type PairingOptions } from '../src/pairing.js';

const endpoint = new URL('http://127.0.0.1:41417/mcp');

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch whose answers are scripted in order; records every call. */
function scriptedFetch(script: Array<() => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const next = script.shift();
    if (!next) throw new Error(`unscripted request: ${url}`);
    return next();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function options(overrides: Partial<PairingOptions> & Pick<PairingOptions, 'fetch'>): PairingOptions {
  let clock = 0;
  return {
    clientKind: 'claude-desktop',
    bridgeVersion: 'pastea-mcp/test',
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  };
}

test('the pairing URL sits beside the endpoint and drops any query', () => {
  assert.equal(pairingURL(new URL('http://127.0.0.1:41417/mcp?x=1')).toString(), 'http://127.0.0.1:41417/mcp/pair');
  assert.equal(pairingURL(new URL('http://127.0.0.1:41417/mcp/')).toString(), 'http://127.0.0.1:41417/mcp/pair');
});

test('202, pending, then allowed', async () => {
  const { fetch, calls } = scriptedFetch([
    () => json(202, { pairing_id: 'abc', expires_in: 120, poll_after: 1 }),
    () => json(200, { status: 'pending' }),
    () =>
      json(200, {
        status: 'allowed',
        token: 'pastea_mcp_x',
        endpoint: 'http://127.0.0.1:41417/mcp',
        bundle_id: 'com.nexolabs.pastea',
        storage_directory: 'Pastea',
      }),
  ]);
  const result = await pair(endpoint, options({ fetch, clientName: 'ignored for known kinds' }));
  assert.deepEqual(result, {
    status: 'allowed',
    token: 'pastea_mcp_x',
    endpoint: 'http://127.0.0.1:41417/mcp',
    bundleId: 'com.nexolabs.pastea',
    storageDirectory: 'Pastea',
  });
  assert.equal(calls[0]?.url, 'http://127.0.0.1:41417/mcp/pair');
  assert.equal(calls[0]?.method, 'POST');
  assert.deepEqual(calls[0]?.body, {
    protocol: 1,
    client: 'claude-desktop',
    name: 'ignored for known kinds',
    bridge: 'pastea-mcp/test',
  });
  assert.equal(calls[1]?.url, 'http://127.0.0.1:41417/mcp/pair?id=abc');
  assert.equal(calls[1]?.method, 'GET');
});

test('403 is pro_required carrying Pastea’s own sentence', async () => {
  const { fetch } = scriptedFetch([() => json(403, { error: 'pro_required', message: 'Pastea Pro is required.' })]);
  assert.deepEqual(await pair(endpoint, options({ fetch })), {
    status: 'pro_required',
    message: 'Pastea Pro is required.',
  });
});

test('404 is a Pastea without pairing', async () => {
  const { fetch } = scriptedFetch([() => new Response('', { status: 404 })]);
  assert.deepEqual(await pair(endpoint, options({ fetch })), { status: 'unsupported' });
});

test('429 backs off five seconds and tries again', async () => {
  const slept: number[] = [];
  const { fetch, calls } = scriptedFetch([
    () => json(429, { error: 'busy' }),
    () => json(202, { pairing_id: 'abc', poll_after: 1 }),
    () => json(200, { status: 'denied' }),
  ]);
  const result = await pair(endpoint, {
    ...options({ fetch }),
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.deepEqual(result, { status: 'denied' });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(slept[0], 5000);
});

test('429 past the retries is busy', async () => {
  const { fetch, calls } = scriptedFetch([
    () => json(429, {}),
    () => json(429, {}),
    () => json(429, {}),
    () => json(429, {}),
  ]);
  assert.deepEqual(await pair(endpoint, options({ fetch })), { status: 'busy' });
  assert.equal(calls.length, 4);
});

test('a refused connection is unreachable', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  assert.deepEqual(await pair(endpoint, options({ fetch: fetchImpl })), { status: 'unreachable' });
});

test('expired on the wire, and a forgotten id, both end as expired', async () => {
  const first = scriptedFetch([
    () => json(202, { pairing_id: 'abc', poll_after: 1 }),
    () => json(200, { status: 'expired' }),
  ]);
  assert.deepEqual(await pair(endpoint, options({ fetch: first.fetch })), { status: 'expired' });

  const second = scriptedFetch([
    () => json(202, { pairing_id: 'abc', poll_after: 1 }),
    () => new Response('', { status: 404 }),
  ]);
  assert.deepEqual(await pair(endpoint, options({ fetch: second.fetch })), { status: 'expired' });
});

test('the bridge gives up after its own deadline', async () => {
  const { fetch, calls } = scriptedFetch([
    () => json(202, { pairing_id: 'abc', poll_after: 1 }),
    ...Array.from({ length: 10 }, () => () => json(200, { status: 'pending' })),
  ]);
  const result = await pair(endpoint, options({ fetch, maxWaitMs: 3_500 }));
  assert.deepEqual(result, { status: 'expired' });
  // One start plus polls at 1 s, 2 s, 3 s; the fourth would be past 3.5 s.
  assert.equal(calls.length, 4);
});

test('an allowed answer without a token is an error, not a crash', async () => {
  const { fetch } = scriptedFetch([
    () => json(202, { pairing_id: 'abc', poll_after: 1 }),
    () => json(200, { status: 'allowed' }),
  ]);
  const result = await pair(endpoint, options({ fetch }));
  assert.equal(result.status, 'error');
});

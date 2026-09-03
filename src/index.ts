#!/usr/bin/env node
// pastea-mcp: the stdio bridge Claude Desktop runs, fronting Pastea's local
// MCP endpoint. All the clipboard logic lives in Pastea; this process
// discovers it, pairs with it once (the user clicks Allow in Pastea), and
// relays frames. See shim.ts for the two modes.
import { detectClient } from './client-name.js';
import { discoverEndpoint } from './discover.js';
import { LineWriter, readLines } from './ndjson.js';
import { pair } from './pairing.js';
import { McpShim } from './shim.js';
import { TokenStore } from './token-store.js';
import { HttpForwarder } from './transport.js';
import { VERSION } from './version.js';

// If the host dies, stdout goes EPIPE; without a listener Node crashes the
// process before the read loop can react.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
});
process.stderr.on('error', () => {});

function log(message: string): void {
  // stderr is the host's log file (Claude Desktop: ~/Library/Logs/Claude/).
  // Never the token.
  try {
    process.stderr.write(`pastea-mcp: ${message}\n`);
  } catch {
    // Nothing to do if even stderr is gone.
  }
}

async function main(): Promise<void> {
  log(`${VERSION} on node ${process.version}`);
  const writer = new LineWriter(process.stdout);
  const store = new TokenStore();
  const client = await detectClient();
  const bridgeVersion = `pastea-mcp/${VERSION}`;
  log(`client ${client.kind}${client.name ? ` (${client.name})` : ''}`);

  const shim = new McpShim({
    version: VERSION,
    discover: () => discoverEndpoint(),
    findToken: async (endpoint) => (await store.find(endpoint))?.token ?? null,
    saveToken: (endpoint, token, storageDirectory) =>
      store.save(storageDirectory, endpoint, token, client.kind),
    clearToken: (endpoint) => store.clear(endpoint),
    pair: (endpoint) =>
      pair(endpoint, {
        clientKind: client.kind,
        ...(client.name ? { clientName: client.name } : {}),
        bridgeVersion,
      }),
    forwarder: (endpoint) => new HttpForwarder(endpoint),
    notify: (payload) => {
      writer.write(payload);
    },
    log,
  });

  await shim.start();
  for await (const line of readLines(process.stdin)) {
    if (!writer.isOpen) break;
    for (const payload of await shim.handle(line)) {
      if (!writer.write(payload)) return;
    }
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);

// Finding Pastea's MCP endpoint on this Mac.
//
// Pastea listens on 127.0.0.1 at a port kept in its own defaults domain
// (`mcpPort`, default 41417). `defaults read` against an explicit plist path
// bypasses cfprefsd's cache, so a port changed in Settings a second ago is
// seen. Both the shipping bundle id and the development one are read: they
// share the default port, so a developer running both moves one of them.
//
// A live endpoint answers *something* to an unauthenticated ping — a 401 is
// the expected answer, and it still means Pastea is there. Only a refused or
// timed-out connection means nothing is listening.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_PORT = 41417;
export const ENDPOINT_PATH = '/mcp';
export const PORT_KEY = 'mcpPort';
/** Release first — it is the one that exists on a user's Mac. */
export const BUNDLE_IDS = ['com.nexolabs.pastea', 'com.nexolabs.pastea.dev'] as const;
/** Development override: an exact endpoint URL, used instead of discovery. */
export const ENV_OVERRIDE = 'PASTEA_MCP_URL';

export interface DiscoverOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readDefault?: (plistPath: string, key: string) => Promise<string | null>;
  probe?: (url: URL) => Promise<boolean>;
}

/** `Number()` semantics would accept "41417 oops" via parseInt; this does not. */
export function parsePort(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1024 && port <= 65535 ? port : null;
}

async function readDefaultViaCLI(plistPath: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/defaults', ['read', plistPath, key], {
      timeout: 1_000,
    });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function probeEndpoint(url: URL, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{"jsonrpc":"2.0","id":0,"method":"ping"}',
      signal: AbortSignal.timeout(800),
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

/** Every endpoint worth probing, most likely first, no duplicates. */
export async function candidateEndpoints(options: DiscoverOptions = {}): Promise<URL[]> {
  const env = options.env ?? process.env;
  const override = env[ENV_OVERRIDE];
  if (override) {
    try {
      return [new URL(override)];
    } catch {
      // A malformed override is ignored rather than fatal; discovery runs.
    }
  }
  const home = options.home ?? homedir();
  const read = options.readDefault ?? readDefaultViaCLI;
  const ports: number[] = [];
  const results = await Promise.allSettled(
    BUNDLE_IDS.map((bundle) => read(`${home}/Library/Preferences/${bundle}`, PORT_KEY)),
  );
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const port = parsePort(result.value);
    if (port !== null && !ports.includes(port)) ports.push(port);
  }
  if (!ports.includes(DEFAULT_PORT)) ports.push(DEFAULT_PORT);
  return ports.map((port) => new URL(`http://127.0.0.1:${port}${ENDPOINT_PATH}`));
}

/** The first candidate that answers, or null when Pastea is not listening. */
export async function discoverEndpoint(options: DiscoverOptions = {}): Promise<URL | null> {
  const probe = options.probe ?? ((url: URL) => probeEndpoint(url));
  for (const url of await candidateEndpoints(options)) {
    if (await probe(url)) return url;
  }
  return null;
}

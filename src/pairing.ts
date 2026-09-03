// Getting a token from Pastea, with the user in the loop.
//
// Pastea's pairing is start-then-poll: `POST /mcp/pair` puts a prompt on the
// user's screen and answers 202 with an id; `GET /mcp/pair?id=` reports
// pending / allowed / denied / expired. It is shaped that way because
// Pastea's HTTP server bounds every handler at 15 s and a person reading a
// prompt takes longer. The token rides in the first `allowed` answer and
// never again.
export const PAIRING_PROTOCOL = 1;

export type PairingResult =
  | {
      status: 'allowed';
      token: string;
      endpoint: string;
      bundleId: string;
      storageDirectory: string;
    }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'pro_required'; message: string }
  /** 404: a Pastea from before pairing existed. */
  | { status: 'unsupported' }
  /** 429 after the retries: another prompt is already on screen. */
  | { status: 'busy' }
  | { status: 'unreachable' }
  | { status: 'error'; message: string };

export interface PairingOptions {
  /** `MCPClientKind` raw value — "claude-desktop", "cursor", …, or "custom". */
  clientKind: string;
  /** Shown by Pastea only for "custom". */
  clientName?: string;
  /** "pastea-mcp/1.0.0"; Pastea shows it under the request. */
  bridgeVersion: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for the user before giving up. Pastea's own window is 120 s. */
  maxWaitMs?: number;
  busyRetries?: number;
}

export function pairingURL(endpoint: URL): URL {
  const url = new URL(endpoint.toString());
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/pair`;
  url.search = '';
  url.hash = '';
  return url;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function messageOf(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string' && body.message.length > 0 ? body.message : fallback;
  } catch {
    return fallback;
  }
}

export async function pair(endpoint: URL, options: PairingOptions): Promise<PairingResult> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const maxWait = options.maxWaitMs ?? 130_000;
  const busyRetries = options.busyRetries ?? 3;

  const startURL = pairingURL(endpoint);
  const body = JSON.stringify({
    protocol: PAIRING_PROTOCOL,
    client: options.clientKind,
    ...(options.clientName ? { name: options.clientName } : {}),
    bridge: options.bridgeVersion,
  });

  let started: Response;
  let attempt = 0;
  for (;;) {
    try {
      started = await fetchImpl(startURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return { status: 'unreachable' };
    }
    if (started.status === 429 && attempt < busyRetries) {
      attempt += 1;
      await sleep(5_000);
      continue;
    }
    break;
  }

  switch (started.status) {
    case 202:
      break;
    case 403:
      return {
        status: 'pro_required',
        message: await messageOf(started, 'Pastea Pro is required for MCP access.'),
      };
    case 404:
      return { status: 'unsupported' };
    case 429:
      return { status: 'busy' };
    default:
      return {
        status: 'error',
        message: await messageOf(started, `Pastea refused the pairing request (HTTP ${started.status}).`),
      };
  }

  const ticket = (await started.json().catch(() => null)) as {
    pairing_id?: unknown;
    poll_after?: unknown;
  } | null;
  if (!ticket || typeof ticket.pairing_id !== 'string') {
    return { status: 'error', message: 'Pastea returned no pairing id.' };
  }
  const pollAfterSeconds = typeof ticket.poll_after === 'number' ? ticket.poll_after : 1;
  const pollEvery = Math.min(5_000, Math.max(250, pollAfterSeconds * 1_000));
  const pollURL = new URL(startURL.toString());
  pollURL.searchParams.set('id', ticket.pairing_id);
  const deadline = now() + maxWait;

  for (;;) {
    await sleep(pollEvery);
    if (now() >= deadline) return { status: 'expired' };
    let polled: Response;
    try {
      polled = await fetchImpl(pollURL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return { status: 'unreachable' };
    }
    // Pastea forgets an outcome once collected, and drops the oldest after a
    // handful — either way an unknown id means nothing further will come.
    if (polled.status === 404) return { status: 'expired' };
    if (polled.status !== 200) {
      return { status: 'error', message: `Pastea answered HTTP ${polled.status} while pairing.` };
    }
    const answer = (await polled.json().catch(() => null)) as Record<string, unknown> | null;
    switch (answer?.status) {
      case 'pending':
        continue;
      case 'denied':
        return { status: 'denied' };
      case 'expired':
        return { status: 'expired' };
      case 'allowed': {
        const token = answer.token;
        const storageDirectory = answer.storage_directory;
        if (typeof token !== 'string' || token.length === 0 || typeof storageDirectory !== 'string') {
          return { status: 'error', message: 'Pastea allowed the request but sent no token.' };
        }
        return {
          status: 'allowed',
          token,
          endpoint: typeof answer.endpoint === 'string' ? answer.endpoint : endpoint.toString(),
          bundleId: typeof answer.bundle_id === 'string' ? answer.bundle_id : '',
          storageDirectory,
        };
      }
      default:
        return { status: 'error', message: 'Pastea returned an unexpected pairing status.' };
    }
  }
}

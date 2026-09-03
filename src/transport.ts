// One JSON-RPC frame in, one Streamable-HTTP POST out.
//
// Pastea's endpoint is stateless and JSON-only: every frame is its own POST,
// 202 acknowledges a notification, and the body is either one JSON payload
// or (defensively, should the SDK ever stream) `text/event-stream`.
//
// One thing to know: Pastea's 401 and 403 envelopes carry `"id": null`,
// because the gate answers before the JSON-RPC layer ever parses the frame.
// A stdio client cannot match that to its request, so `withRequestId` puts
// the id back before anything is written to stdout.
export interface ForwardResult {
  status: number;
  contentType: string;
  body: string;
}

export interface ForwarderOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class HttpForwarder {
  constructor(
    private readonly endpoint: URL,
    private readonly options: ForwarderOptions = {},
  ) {}

  async forward(frame: string, token: string, protocolVersion?: string): Promise<ForwardResult> {
    const fetchImpl = this.options.fetch ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    };
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    const response = await fetchImpl(this.endpoint, {
      method: 'POST',
      headers,
      body: frame,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`response declares ${declared} bytes (cap ${maxBytes})`);
    }
    const body = await response.text();
    if (body.length > maxBytes) {
      throw new Error(`response is ${body.length} bytes (cap ${maxBytes})`);
    }
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', body };
  }
}

/** The JSON-RPC payloads carried by one HTTP answer — none for a 202. */
export function decodePayloads(result: ForwardResult): unknown[] {
  if (result.status === 202 || result.body.trim().length === 0) return [];
  if (result.contentType.toLowerCase().startsWith('text/event-stream')) return decodeSSE(result.body);
  return [JSON.parse(result.body)];
}

export function decodeSSE(body: string): unknown[] {
  const payloads: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (data.length === 0) continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {
      // A non-JSON event is a keep-alive or a comment; nothing to relay.
    }
  }
  return payloads;
}

/** Pastea's gate errors carry `id: null`; give them back the request's id. */
export function withRequestId(payload: unknown, id: unknown): unknown {
  if (id === undefined || payload === null || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  if (!('error' in record) || record.id !== null) return payload;
  return { ...record, id };
}

export function errorEnvelope(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

/** The `error.message` inside a JSON-RPC error body, if it is one. */
export function errorMessageIn(result: ForwardResult): string | null {
  try {
    const parsed = JSON.parse(result.body) as { error?: { message?: unknown } };
    return typeof parsed.error?.message === 'string' ? parsed.error.message : null;
  } catch {
    return null;
  }
}

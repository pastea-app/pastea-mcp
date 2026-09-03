// The stdio front Claude talks to. One server, two modes.
//
// **Live**: a token is in hand and every frame is forwarded to Pastea.
// **Degraded**: Pastea is not reachable, not paired, or not licensed — the
// shim answers `initialize` itself, offers exactly one tool (`pastea_status`)
// that says what is wrong and what to do, and keeps trying in the background.
//
// The point of the second mode is the install moment. Claude Desktop sends
// `initialize` the instant the extension is enabled, and a pairing prompt
// takes as long as a person takes to read it; a handshake that blocked on
// that would read as a broken server. So the handshake always completes, the
// prompt appears while Claude is still starting, and when the user clicks
// Allow the shim announces `notifications/tools/list_changed` and Pastea's
// tools appear.
import type { PairingResult } from './pairing.js';
import { STATUS_TOOL, messageFor, type DegradedReason } from './status-tool.js';
import {
  decodePayloads,
  errorEnvelope,
  errorMessageIn,
  withRequestId,
  type HttpForwarder,
} from './transport.js';

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const DEFAULT_PROTOCOL = '2025-03-26';
/** After a denial, a status call re-asks only once this much time has passed. */
export const DENIAL_COOLDOWN_MS = 60_000;

export type Mode =
  | { kind: 'live'; endpoint: URL; token: string }
  | { kind: 'degraded'; reason: DegradedReason; detail?: string; endpoint?: URL };

export interface ShimDeps {
  version: string;
  discover: () => Promise<URL | null>;
  findToken: (endpoint: URL) => Promise<string | null>;
  saveToken: (endpoint: URL, token: string, storageDirectory: string) => Promise<void>;
  clearToken: (endpoint: URL) => Promise<void>;
  pair: (endpoint: URL) => Promise<PairingResult>;
  forwarder: (endpoint: URL) => HttpForwarder;
  /** Server-initiated messages (tools/list_changed) go out through here. */
  notify: (payload: unknown) => void;
  log: (message: string) => void;
  now?: () => number;
}

type Frame = Record<string, unknown>;

function isRecord(value: unknown): value is Frame {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class McpShim {
  private mode: Mode = { kind: 'degraded', reason: 'unreachable' };
  private protocolVersion: string = DEFAULT_PROTOCOL;
  private initialized = false;
  private listChangedPending = false;
  private pairing: Promise<void> | null = null;
  private lastDeniedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: ShimDeps) {}

  get state(): Mode {
    return this.mode;
  }

  /** Waits for any pairing in flight — tests use it; the app never needs to. */
  async settle(): Promise<void> {
    await this.pairing;
  }

  async start(): Promise<void> {
    await this.reconnect();
  }

  /** Handles one frame from the host and returns what to write back. */
  async handle(line: string): Promise<unknown[]> {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return [errorEnvelope(null, -32700, 'Parse error')];
    }
    if (!isRecord(frame)) {
      return [errorEnvelope(null, -32600, 'Invalid Request')];
    }
    const id = frame.id;
    const isNotification = !('id' in frame);
    const method = frame.method;

    if (typeof method !== 'string') {
      // A response to something the server asked; Pastea never asks, so
      // nothing waits on it. Forwarded when live for completeness.
      if (this.mode.kind === 'live') await this.forward(line, undefined);
      return [];
    }

    switch (method) {
      case 'initialize':
        return [await this.initialize(frame, line)];
      case 'notifications/initialized':
        this.initialized = true;
        if (this.listChangedPending) {
          this.listChangedPending = false;
          this.emitListChanged();
        }
        if (this.mode.kind === 'live') await this.forward(line, undefined);
        return [];
      case 'ping':
        return isNotification ? [] : [{ jsonrpc: '2.0', id, result: {} }];
      default:
        break;
    }

    const params = isRecord(frame.params) ? frame.params : {};
    if (method === 'tools/call' && params.name === STATUS_TOOL.name) {
      if (isNotification) return [];
      return [{ jsonrpc: '2.0', id, result: await this.status() }];
    }

    if (this.mode.kind === 'live') {
      if (isNotification) {
        await this.forward(line, undefined);
        return [];
      }
      const payloads = await this.forward(line, id);
      return method === 'tools/list' ? payloads.map((payload) => appendStatusTool(payload)) : payloads;
    }

    if (isNotification) return [];
    switch (method) {
      case 'tools/list':
        return [{ jsonrpc: '2.0', id, result: { tools: [STATUS_TOOL] } }];
      case 'tools/call':
        return [
          {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: this.message() }], isError: true },
          },
        ];
      case 'prompts/list':
        return [{ jsonrpc: '2.0', id, result: { prompts: [] } }];
      case 'resources/list':
        return [{ jsonrpc: '2.0', id, result: { resources: [] } }];
      case 'resources/templates/list':
        return [{ jsonrpc: '2.0', id, result: { resourceTemplates: [] } }];
      default:
        return [errorEnvelope(id, -32601, 'Method not found')];
    }
  }

  // MARK: - Modes

  /** Looks for Pastea again; uses a stored token or starts pairing. */
  private async reconnect(): Promise<void> {
    if (this.pairing) return;
    const endpoint = await this.deps.discover();
    if (!endpoint) {
      this.setMode({ kind: 'degraded', reason: 'unreachable' });
      return;
    }
    const token = await this.deps.findToken(endpoint);
    if (token) {
      this.setMode({ kind: 'live', endpoint, token });
      return;
    }
    this.setMode({ kind: 'degraded', reason: 'pairing', endpoint });
    this.beginPairing(endpoint);
  }

  private beginPairing(endpoint: URL): void {
    if (this.pairing) return;
    this.pairing = this.deps
      .pair(endpoint)
      .then((result) => this.applyPairing(endpoint, result))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.setMode({ kind: 'degraded', reason: 'error', detail, endpoint });
      })
      .finally(() => {
        this.pairing = null;
      });
  }

  private async applyPairing(endpoint: URL, result: PairingResult): Promise<void> {
    switch (result.status) {
      case 'allowed':
        // The endpoint we paired against is the one we keep talking to; the
        // answer's copy is informational.
        await this.deps.saveToken(endpoint, result.token, result.storageDirectory);
        this.setMode({ kind: 'live', endpoint, token: result.token });
        return;
      case 'denied':
        this.lastDeniedAt = this.now();
        this.setMode({ kind: 'degraded', reason: 'denied', endpoint });
        return;
      case 'expired':
        this.setMode({ kind: 'degraded', reason: 'expired', endpoint });
        return;
      case 'pro_required':
        this.setMode({ kind: 'degraded', reason: 'pro_required', detail: result.message, endpoint });
        return;
      case 'unsupported':
        this.setMode({ kind: 'degraded', reason: 'outdated', endpoint });
        return;
      case 'busy':
        // Someone else's prompt is up; the next status call asks again.
        this.setMode({ kind: 'degraded', reason: 'pairing', endpoint });
        return;
      case 'unreachable':
        this.setMode({ kind: 'degraded', reason: 'unreachable' });
        return;
      case 'error':
        this.setMode({ kind: 'degraded', reason: 'error', detail: result.message, endpoint });
        return;
    }
  }

  private setMode(mode: Mode): void {
    const wasLive = this.mode.kind === 'live';
    this.mode = mode;
    this.deps.log(mode.kind === 'live' ? `connected to ${mode.endpoint}` : `not connected: ${mode.reason}`);
    if (wasLive !== (mode.kind === 'live')) this.scheduleListChanged();
  }

  private scheduleListChanged(): void {
    if (!this.initialized) {
      this.listChangedPending = true;
      return;
    }
    this.emitListChanged();
  }

  private emitListChanged(): void {
    this.deps.notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  // MARK: - Requests

  private async initialize(frame: Frame, line: string): Promise<unknown> {
    const params = isRecord(frame.params) ? frame.params : {};
    const requested = params.protocolVersion;
    this.protocolVersion =
      typeof requested === 'string' && (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
        ? requested
        : DEFAULT_PROTOCOL;

    if (this.mode.kind === 'live') {
      const [first] = await this.forward(line, frame.id);
      if (isRecord(first) && isRecord(first.result)) {
        const result = first.result;
        const capabilities = isRecord(result.capabilities) ? result.capabilities : {};
        const tools = isRecord(capabilities.tools) ? capabilities.tools : {};
        return {
          ...first,
          result: { ...result, capabilities: { ...capabilities, tools: { ...tools, listChanged: true } } },
        };
      }
      if (first !== undefined) return first;
    }
    return {
      jsonrpc: '2.0',
      id: frame.id,
      result: {
        protocolVersion: this.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'Pastea', version: this.deps.version },
        instructions: this.message(),
      },
    };
  }

  private async forward(line: string, id: unknown): Promise<unknown[]> {
    if (this.mode.kind !== 'live') return [];
    const { endpoint, token } = this.mode;
    let result;
    try {
      result = await this.deps.forwarder(endpoint).forward(line, token, this.protocolVersion);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.setMode({ kind: 'degraded', reason: 'unreachable' });
      if (id === undefined) return [];
      return [errorEnvelope(id, -32603, `Pastea did not answer (${detail}). ${messageFor('unreachable')}`)];
    }

    if (result.status === 401) {
      // Revoked in Settings, or a token from a Pastea that was reset. Either
      // way it is dead; ask again, and tell this request what is happening.
      await this.deps.clearToken(endpoint);
      this.setMode({ kind: 'degraded', reason: 'pairing', endpoint });
      this.beginPairing(endpoint);
      if (id === undefined) return [];
      const original = errorMessageIn(result) ?? 'Not connected to Pastea.';
      return [errorEnvelope(id, -32001, `${original} ${messageFor('pairing')}`)];
    }

    let payloads: unknown[];
    try {
      payloads = decodePayloads(result);
    } catch {
      if (id === undefined) return [];
      return [errorEnvelope(id, -32603, 'Pastea returned a response this bridge could not read.')];
    }
    return payloads.map((payload) => withRequestId(payload, id));
  }

  private async status(): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }> {
    if (this.mode.kind === 'degraded') {
      switch (this.mode.reason) {
        case 'unreachable':
        case 'outdated':
        case 'error':
        case 'expired':
        case 'pro_required':
          await this.reconnect();
          break;
        case 'pairing':
          if (this.mode.endpoint && !this.pairing) this.beginPairing(this.mode.endpoint);
          break;
        case 'denied':
          if (this.mode.endpoint && this.now() - this.lastDeniedAt >= DENIAL_COOLDOWN_MS) {
            const endpoint = this.mode.endpoint;
            this.setMode({ kind: 'degraded', reason: 'pairing', endpoint });
            this.beginPairing(endpoint);
          }
          break;
      }
    }
    return { content: [{ type: 'text', text: this.message() }], isError: false };
  }

  private message(): string {
    return this.mode.kind === 'live'
      ? messageFor('connected')
      : messageFor(this.mode.reason, this.mode.detail);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

/** Adds `pastea_status` to a live `tools/list` answer, so it is always there. */
function appendStatusTool(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.result) || !Array.isArray(payload.result.tools)) {
    return payload;
  }
  const tools = payload.result.tools as unknown[];
  if (tools.some((tool) => isRecord(tool) && tool.name === STATUS_TOOL.name)) return payload;
  return { ...payload, result: { ...payload.result, tools: [...tools, STATUS_TOOL] } };
}

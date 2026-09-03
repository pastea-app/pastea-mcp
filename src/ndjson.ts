// Newline-delimited JSON over stdio — the MCP stdio transport's framing.
//
// The host (Claude Desktop) owns both pipes. When it quits, stdout goes EPIPE
// and Node would crash the process with ERR_UNHANDLED_ERROR before our loop
// noticed, so the writer swallows stream errors and checks `destroyed` /
// `writableEnded` — both set synchronously — before every write.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** Yields each non-empty line of `input`. */
export async function* readLines(input: Readable): AsyncGenerator<string, void, void> {
  const lines = createInterface({ input, terminal: false, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.length === 0) continue;
    yield line;
  }
}

export class LineWriter {
  constructor(private readonly output: Writable) {
    output.on('error', () => {});
  }

  get isOpen(): boolean {
    return !this.output.destroyed && !this.output.writableEnded;
  }

  /** Writes one JSON payload as one line. False when the host has gone. */
  write(payload: unknown): boolean {
    if (!this.isOpen) return false;
    this.output.write(`${JSON.stringify(payload)}\n`);
    return true;
  }
}

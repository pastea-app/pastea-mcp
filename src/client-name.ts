// Which AI app spawned this bridge, so Pastea's prompt and its Connected AI
// Tools list can wear the right name. Walks up the process tree with `ps`,
// stepping past shell and runtime wrappers, and matches the first ancestor
// whose command line names a known host. Anything else is "custom".
//
// The kinds are `MCPClientKind` raw values on the Pastea side; an unknown
// value lands as `.custom` there too, so a mismatch is cosmetic, never fatal.
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DetectedClient {
  kind: string;
  name?: string;
}

export interface ProcessInfo {
  ppid: number;
  args: string;
}

const CLIENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: string }> = [
  // Claude Code before Claude Desktop: the CLI's argv also contains "claude".
  { pattern: /@anthropic-ai\/claude-code|\.claude\/local\/.*\bclaude\b|\bclaude-code\b/i, kind: 'claude-code' },
  { pattern: /\/Claude\.app\//, kind: 'claude-desktop' },
  { pattern: /\/Cursor\.app\//, kind: 'cursor' },
  { pattern: /\/Windsurf\.app\//i, kind: 'windsurf' },
  { pattern: /Visual Studio Code\.app|\/Code\.app\//i, kind: 'vscode' },
  { pattern: /@openai\/codex|(^|\/)codex(\s|$)/i, kind: 'codex' },
];

const WRAPPER = /(^|\/)(node|npx|npm|sh|bash|zsh|fish|env)(\s|$)/;

async function readProcessViaPS(pid: number): Promise<ProcessInfo | null> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'ppid=,args='], {
      timeout: 500,
    });
    const match = stdout.trim().match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return null;
    return { ppid: Number.parseInt(match[1] ?? '0', 10), args: match[2] ?? '' };
  } catch {
    return null;
  }
}

function matchClient(args: string): string | null {
  for (const { pattern, kind } of CLIENT_PATTERNS) {
    if (pattern.test(args)) return kind;
  }
  return null;
}

/** A short label for an unknown host: its executable's file name. */
function labelFor(args: string): string {
  const executable = args.split(' ')[0] ?? '';
  const name = basename(executable).replace(/\.(app|exe)$/i, '');
  return name.length > 0 ? name.slice(0, 40) : 'MCP client';
}

export async function detectClient(
  options: { readProcess?: (pid: number) => Promise<ProcessInfo | null>; startPid?: number } = {},
): Promise<DetectedClient> {
  const read = options.readProcess ?? readProcessViaPS;
  let pid = options.startPid ?? process.ppid;
  let firstHost: string | null = null;
  for (let depth = 0; depth < 8; depth += 1) {
    const info = await read(pid);
    if (!info) break;
    const kind = matchClient(info.args);
    if (kind) return { kind };
    if (!WRAPPER.test(info.args)) {
      // Not a wrapper and not a known host: this is who launched us.
      firstHost ??= labelFor(info.args);
      break;
    }
    if (info.ppid <= 1 || info.ppid === pid) break;
    pid = info.ppid;
  }
  return firstHost ? { kind: 'custom', name: firstHost } : { kind: 'custom' };
}

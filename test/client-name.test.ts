import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectClient, type ProcessInfo } from '../src/client-name.js';

function tree(entries: Record<number, ProcessInfo>) {
  return async (pid: number): Promise<ProcessInfo | null> => entries[pid] ?? null;
}

test('Claude Desktop is found past the node wrapper', async () => {
  const client = await detectClient({
    startPid: 20,
    readProcess: tree({
      20: { ppid: 10, args: '/Applications/Claude.app/Contents/Resources/node /x/dist/index.js' },
      10: { ppid: 1, args: '/Applications/Claude.app/Contents/MacOS/Claude' },
    }),
  });
  assert.deepEqual(client, { kind: 'claude-desktop' });
});

test('Claude Code wins over Claude Desktop when both words appear', async () => {
  const client = await detectClient({
    startPid: 20,
    readProcess: tree({
      20: { ppid: 10, args: 'node /x/dist/index.js' },
      10: { ppid: 1, args: 'node /Users/me/.nvm/versions/node/v20/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
    }),
  });
  assert.deepEqual(client, { kind: 'claude-code' });
});

test('Cursor, VS Code, Windsurf and Codex map to their kinds', async () => {
  const cases: Array<[string, string]> = [
    ['/Applications/Cursor.app/Contents/MacOS/Cursor', 'cursor'],
    ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron', 'vscode'],
    ['/Applications/Windsurf.app/Contents/MacOS/Electron', 'windsurf'],
    ['node /usr/local/lib/node_modules/@openai/codex/bin/codex.js', 'codex'],
  ];
  for (const [args, kind] of cases) {
    const client = await detectClient({ startPid: 5, readProcess: tree({ 5: { ppid: 1, args } }) });
    assert.equal(client.kind, kind, args);
  }
});

test('an unknown host is custom, named after its executable', async () => {
  const client = await detectClient({
    startPid: 20,
    readProcess: tree({
      20: { ppid: 10, args: '/bin/sh -c node dist/index.js' },
      10: { ppid: 1, args: '/Applications/SomeTool.app/Contents/MacOS/SomeTool --flag' },
    }),
  });
  assert.deepEqual(client, { kind: 'custom', name: 'SomeTool' });
});

test('nothing readable is custom without a name', async () => {
  assert.deepEqual(await detectClient({ startPid: 1, readProcess: async () => null }), { kind: 'custom' });
});

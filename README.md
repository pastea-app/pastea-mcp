# pastea-mcp — Pastea for Claude Desktop

The Claude Desktop extension for [Pastea](https://pastea.app), the clipboard history
manager for macOS. It lets Claude search what you have copied, read a clip in full
(including text recognized inside screenshots), list your lists, and put a clip back on
the clipboard for you to paste.

It is a thin, dependency-free bridge: Pastea itself runs the MCP server on your Mac
(`127.0.0.1` only). This process finds it, asks it for access once — **you click Allow in
Pastea** — and relays messages between Claude Desktop and Pastea over stdio.

## What Claude can do

| Tool | What it does |
| --- | --- |
| `search_clips` | Search your clipboard history and lists — text, links, file names, and text recognized in screenshots. |
| `get_clip` | Read one clip in full, with a thumbnail for pictures. |
| `list_collections` | List your history and the lists you made, with counts. |
| `copy_clip` | Put a clip back on the system clipboard, exactly as copied. You paste it yourself with ⌘V. |
| `pastea_status` | Says whether Pastea is reachable and connected, and what to do if not. |

Claude can **never** delete a clip, never pastes into another app, and never sees items
Pastea conceals (from password managers).

## Requirements

- macOS 15 or later
- [Pastea](https://pastea.app) 1.3 or later, with **Pastea Pro**
- **Enable MCP** turned on in Pastea → Settings → MCP & AI Tools
- Claude Desktop

## Install

**From Pastea (one click):** Pastea → Settings → MCP & AI Tools → **Claude Desktop**.
Claude Desktop opens and offers to install the extension.

**From Claude Desktop:** Settings → Extensions → Browse extensions → Pastea → Install.

**From a file:** download `pastea-mcp-<version>.mcpb` from
[Releases](https://github.com/pastea-app/pastea-mcp/releases) and double-click it, or use
Claude Desktop → Settings → Extensions → Advanced settings → Install Extension…

## How pairing works

The extension ships with no credentials. The first time Claude uses it, it asks Pastea
for access and Pastea shows **"Allow Claude Desktop to use your clipboard history?"**.
Click Allow and the tools appear in Claude a moment later (ask Claude to call
`pastea_status` if they do not). Click Don't Allow and nothing is granted; Claude gets a
`pastea_status` tool that explains the situation.

The connection appears in Pastea → Settings → MCP & AI Tools → **Connected AI Tools**,
where you can **Revoke** it at any time. The next request from Claude then fails, and
Pastea asks you again only if you ask Claude to reconnect.

## Other AI tools

Cursor, VS Code, Claude Code, Windsurf and Codex do not need this extension: they speak
HTTP directly to Pastea. Pastea's Settings → MCP & AI Tools has a one-click or
copy-paste setup for each.

## Privacy Policy

This extension runs entirely on your Mac.

- It connects only to Pastea on `127.0.0.1` and to nothing else. It makes no network
  requests to Nexo Labs or any third party, and carries no analytics or telemetry.
- It moves clipboard data only between Pastea and the AI app that runs it, and only
  after you clicked Allow in Pastea. What that AI app does with clips it reads is
  governed by that app's own privacy policy (for Claude, Anthropic's).
- It stores one thing: the access token Pastea issued when you clicked Allow, in
  `~/Library/Application Support/Pastea/MCP Bridge/tokens.json`, readable by your user
  account only. Revoking the connection in Pastea invalidates that token immediately;
  uninstalling Pastea removes the file.
- Concealed clips are never available to it, and it cannot delete anything.

Pastea's full privacy policy: <https://pastea.app/privacy>.

## Troubleshooting

- **"Pastea isn't running, or its MCP endpoint is turned off."** Open Pastea and turn on
  Enable MCP in Settings → MCP & AI Tools. Then ask Claude to call `pastea_status`.
- **"Pastea Pro is required."** MCP access is a Pro feature; subscribe in Pastea's
  Settings, then call `pastea_status`.
- **"Pastea is asking the user to allow this connection."** Look for the Pastea window
  (it may be behind Claude) and click Allow.
- **The tools vanished.** The connection was revoked in Pastea, or Pastea was reset. Ask
  Claude to call `pastea_status` to pair again.
- **Changed Pastea's port?** The bridge reads it from Pastea's preferences on every
  launch; restart Claude Desktop after changing it.
- Logs: `~/Library/Logs/Claude/mcp-server-Pastea.log`. The bridge never logs the token.

## Development

```bash
npm install
npm test            # node --test, no network
npm run build       # tsc → dist/
scripts/pack.sh     # validate + pack → build/pastea-mcp-<version>.mcpb + SHA256SUMS
```

Run it against a development Pastea by hand:

```bash
PASTEA_MCP_URL=http://127.0.0.1:41418/mcp node dist/index.js
```

then type JSON-RPC lines on stdin (`initialize`, `notifications/initialized`,
`tools/list`). Releases are cut by tagging `v<version>` (matching `package.json`,
`manifest.json` and `src/version.ts`); the workflow packs the bundle and publishes it.

## License

MIT — see [LICENSE](LICENSE).

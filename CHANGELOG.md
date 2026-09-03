# Changelog

All notable changes to `pastea-mcp`. The version here, in `package.json`,
`manifest.json`, `server.json` and `src/version.ts` move together; the release
workflow reads this file for the GitHub release notes.

## [1.0.4] — 2026-09-03

- Registry listing description trimmed to the 100-character limit the MCP Registry
  enforces; manifest `author.url` now points at the GitHub organisation, as the
  Claude Desktop directory requires. No code changes.

## [1.0.3] — 2026-09-03

- Listed in the official MCP Registry as `io.github.pastea-app/pastea-mcp`, and
  published to npm from CI via trusted publishing. No code changes.

## [1.0.2] — 2026-09-03

- The npm package is `@pastea/mcp`, scoped under the pastea organisation; the
  binary is still `pastea-mcp`. `server.json` lists both the `.mcpb` release asset
  and the npm package.

## [1.0.1] — 2026-09-03

- Published as an npm package with a `pastea-mcp` binary, so any MCP client that
  runs stdio servers can use `npx -y pastea-mcp` — Claude Code, Codex, Cursor,
  VS Code — and pair with Pastea the same way Claude Desktop does.
- Added `server.json` for the official MCP Registry.
- README rewritten with per-client install steps.

## [1.0.0] — 2026-09-03

- First release: the Claude Desktop extension (`.mcpb`) bridging Claude to
  Pastea's local MCP endpoint. Zero configuration — discovers Pastea's port,
  pairs with one click in Pastea, and serves a `pastea_status` tool whenever
  Pastea is unreachable, unpaired or unlicensed.

#!/usr/bin/env bash
# Build, validate and pack the Claude Desktop extension: build/pastea-mcp-<v>.mcpb
# plus build/SHA256SUMS. Fails if the three version numbers disagree, if the
# manifest does not validate, or if the bundle is suspiciously large (a leaked
# node_modules is the usual cause — the bridge has no runtime dependencies).
set -euo pipefail
cd "$(dirname "$0")/.."

PKG_VERSION=$(node -p "require('./package.json').version")
MANIFEST_VERSION=$(node -p "require('./manifest.json').version")
SRC_VERSION=$(sed -nE "s/^export const VERSION = '([^']+)';/\1/p" src/version.ts)
if [ "$PKG_VERSION" != "$MANIFEST_VERSION" ] || [ "$PKG_VERSION" != "$SRC_VERSION" ]; then
  echo "!! version mismatch: package.json=$PKG_VERSION manifest.json=$MANIFEST_VERSION src/version.ts=$SRC_VERSION" >&2
  exit 1
fi

npm run --silent build
npx mcpb validate manifest.json

mkdir -p build
OUT="build/pastea-mcp-$PKG_VERSION.mcpb"
rm -f "$OUT"
npx mcpb pack . "$OUT"

SIZE=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")
if [ "$SIZE" -gt 1048576 ]; then
  echo "!! $OUT is $SIZE bytes — the bundle should be well under 1 MB. Check .mcpbignore." >&2
  exit 1
fi
if unzip -l "$OUT" | grep -q 'node_modules/'; then
  echo "!! $OUT contains node_modules" >&2
  exit 1
fi

(cd build && shasum -a 256 "pastea-mcp-$PKG_VERSION.mcpb" > SHA256SUMS)
npx mcpb info "$OUT"
echo
echo "==> $OUT ($SIZE bytes)"
cat build/SHA256SUMS

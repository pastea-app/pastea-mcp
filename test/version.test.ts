import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { VERSION } from '../src/version.js';

// Compiled tests run from build-test/test/, two levels below the repo root.
const root = new URL('../../', import.meta.url);

test('package.json, manifest.json and src/version.ts agree', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as { version: string };
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')) as { version: string };
  assert.equal(pkg.version, VERSION);
  assert.equal(manifest.version, VERSION);
});

test('the manifest lists Pastea’s tools plus pastea_status, darwin only, with a privacy policy', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')) as {
    tools: Array<{ name: string; description: string }>;
    compatibility: { platforms: string[] };
    privacy_policies: string[];
    server: { type: string; mcp_config: { args: string[] } };
    user_config?: unknown;
  };
  assert.deepEqual(
    manifest.tools.map((tool) => tool.name),
    ['search_clips', 'get_clip', 'list_collections', 'copy_clip', 'pastea_status'],
  );
  for (const tool of manifest.tools) assert.ok(tool.description.length > 20, tool.name);
  assert.deepEqual(manifest.compatibility.platforms, ['darwin']);
  assert.deepEqual(manifest.privacy_policies, ['https://pastea.app/privacy']);
  assert.equal(manifest.server.type, 'node');
  assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/dist/index.js']);
  // Zero-config on purpose: the token comes from pairing, the port from discovery.
  assert.equal(manifest.user_config, undefined);
});

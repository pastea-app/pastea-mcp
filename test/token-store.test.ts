import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

import { TokenStore, isValidStorageDirectory, tokensPath } from '../src/token-store.js';

let home: string;
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pastea-mcp-tokens-'));
});
after(async () => {
  await rm(home, { recursive: true, force: true });
});

const endpoint = new URL('http://127.0.0.1:41417/mcp');

test('only a bare directory name is accepted', () => {
  assert.equal(isValidStorageDirectory('Pastea'), true);
  assert.equal(isValidStorageDirectory('Pastea Dev'), true);
  assert.equal(isValidStorageDirectory(''), false);
  assert.equal(isValidStorageDirectory('.'), false);
  assert.equal(isValidStorageDirectory('..'), false);
  assert.equal(isValidStorageDirectory('../Claude'), false);
  assert.equal(isValidStorageDirectory('Pastea/../../etc'), false);
  assert.equal(isValidStorageDirectory('a'.repeat(65)), false);
  assert.throws(() => tokensPath('../evil', '/Users/test'));
  assert.equal(
    tokensPath('Pastea', '/Users/test'),
    '/Users/test/Library/Application Support/Pastea/MCP Bridge/tokens.json',
  );
});

test('save writes a private file and find reads it back by endpoint', async () => {
  const store = new TokenStore(home);
  assert.equal(await store.find(endpoint), null);

  await store.save('Pastea', endpoint, 'pastea_mcp_release', 'claude-desktop');
  const found = await store.find(endpoint);
  assert.deepEqual(found, { token: 'pastea_mcp_release', storageDirectory: 'Pastea' });

  const path = tokensPath('Pastea', home);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  const parsed = JSON.parse(await readFile(path, 'utf8')) as {
    version: number;
    tokens: Record<string, { token: string; client: string; pairedAt: string }>;
  };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.tokens[endpoint.toString()]?.client, 'claude-desktop');
  assert.ok(parsed.tokens[endpoint.toString()]?.pairedAt);
});

test('a token in the dev install is found too, and endpoints are independent', async () => {
  const store = new TokenStore(home);
  const devEndpoint = new URL('http://127.0.0.1:41418/mcp');
  await store.save('Pastea Dev', devEndpoint, 'pastea_mcp_dev', 'cursor');
  assert.deepEqual(await store.find(devEndpoint), { token: 'pastea_mcp_dev', storageDirectory: 'Pastea Dev' });
  assert.deepEqual(await store.find(endpoint), { token: 'pastea_mcp_release', storageDirectory: 'Pastea' });
});

test('clear forgets one endpoint and removes an emptied file', async () => {
  const store = new TokenStore(home);
  await store.clear(endpoint);
  assert.equal(await store.find(endpoint), null);
  await assert.rejects(stat(tokensPath('Pastea', home)));
  // The dev token is untouched.
  assert.ok(await store.find(new URL('http://127.0.0.1:41418/mcp')));
});

test('a corrupt or foreign file reads as no token', async () => {
  const store = new TokenStore(home);
  const path = tokensPath('Pastea', home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{not json');
  assert.equal(await store.find(endpoint), null);
  await writeFile(path, JSON.stringify({ version: 2, tokens: { [endpoint.toString()]: { token: 'x' } } }));
  assert.equal(await store.find(endpoint), null);
  // And saving over it recovers.
  await store.save('Pastea', endpoint, 'pastea_mcp_new', 'claude-desktop');
  assert.equal((await store.find(endpoint))?.token, 'pastea_mcp_new');
});

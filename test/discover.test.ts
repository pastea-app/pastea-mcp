import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PORT,
  candidateEndpoints,
  discoverEndpoint,
  parsePort,
} from '../src/discover.js';

const neverRead = async (): Promise<string | null> => {
  throw new Error('the plist must not be read');
};

test('the env override replaces discovery entirely', async () => {
  const urls = await candidateEndpoints({
    env: { PASTEA_MCP_URL: 'http://127.0.0.1:5000/mcp' },
    readDefault: neverRead,
  });
  assert.deepEqual(urls.map(String), ['http://127.0.0.1:5000/mcp']);
});

test('a malformed override falls back to discovery', async () => {
  const urls = await candidateEndpoints({
    env: { PASTEA_MCP_URL: 'not a url' },
    home: '/Users/test',
    readDefault: async () => null,
  });
  assert.deepEqual(urls.map(String), [`http://127.0.0.1:${DEFAULT_PORT}/mcp`]);
});

test('plist ports come first, release before dev, then the default, without duplicates', async () => {
  const read: string[] = [];
  const urls = await candidateEndpoints({
    env: {},
    home: '/Users/test',
    readDefault: async (plistPath) => {
      read.push(plistPath);
      if (plistPath.endsWith('/com.nexolabs.pastea')) return '41500';
      if (plistPath.endsWith('/com.nexolabs.pastea.dev')) return '41418';
      return null;
    },
  });
  assert.deepEqual(urls.map(String), [
    'http://127.0.0.1:41500/mcp',
    'http://127.0.0.1:41418/mcp',
    'http://127.0.0.1:41417/mcp',
  ]);
  assert.deepEqual(read, [
    '/Users/test/Library/Preferences/com.nexolabs.pastea',
    '/Users/test/Library/Preferences/com.nexolabs.pastea.dev',
  ]);
});

test('a plist already on the default port yields one candidate', async () => {
  const urls = await candidateEndpoints({
    env: {},
    home: '/Users/test',
    readDefault: async () => String(DEFAULT_PORT),
  });
  assert.deepEqual(urls.map(String), [`http://127.0.0.1:${DEFAULT_PORT}/mcp`]);
});

test('junk ports are rejected', () => {
  assert.equal(parsePort('41417 oops'), null);
  assert.equal(parsePort('80'), null);
  assert.equal(parsePort('70000'), null);
  assert.equal(parsePort(''), null);
  assert.equal(parsePort(null), null);
  assert.equal(parsePort(' 41418 '), 41418);
});

test('a 401 counts as alive, and the first live endpoint wins', async () => {
  const probed: string[] = [];
  const url = await discoverEndpoint({
    env: {},
    home: '/Users/test',
    readDefault: async (plistPath) => (plistPath.endsWith('.dev') ? '41418' : null),
    probe: async (candidate) => {
      probed.push(candidate.toString());
      return candidate.port === '41417';
    },
  });
  assert.equal(url?.toString(), 'http://127.0.0.1:41417/mcp');
  assert.deepEqual(probed, ['http://127.0.0.1:41418/mcp', 'http://127.0.0.1:41417/mcp']);
});

test('nothing listening is null', async () => {
  const url = await discoverEndpoint({
    env: {},
    home: '/Users/test',
    readDefault: async () => null,
    probe: async () => false,
  });
  assert.equal(url, null);
});

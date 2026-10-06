import { test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

test('the actual background bundle loads private pairing before making bridge requests', async () => {
  const pairingScript = await readFile('dist/extension/pairing.js', 'utf8');
  const pairingKey = pairingScript.match(/"([a-f0-9]{64})"/)?.[1];
  expect(Boolean(pairingKey)).toBe(true);
  let listener;
  let receivedCorrectKey = false;
  const chrome = {
    runtime: {
      id: 'our-id',
      getManifest: () => ({ version: '2.4.14' }),
      getURL: (file) => 'chrome-extension://our-id/' + file,
      onMessage: { addListener: (fn) => { listener = fn; } },
    },
  };
  const context = createContext({
    URL, AbortSignal, console, setTimeout, clearTimeout, chrome,
    fetch: async (url, options) => {
      if (url.startsWith('chrome-extension:')) return Response.json({ version: '2.4.14' });
      receivedCorrectKey = options.headers['X-Bridge-Token'] === pairingKey;
      return Response.json({ request: null });
    },
    importScripts: (file) => {
      expect(file).toBe('pairing.js');
      runInContext(pairingScript, context);
    },
  });
  runInContext(await readFile('dist/extension/background.js', 'utf8'), context);
  const response = await new Promise((resolve) => listener(
    { type: 'bridge_request', path: 'poll', browserId: 'tab1', data: {} },
    { id: 'our-id', url: 'https://chatgpt.com/', tab: { id: 1 }, frameId: 0 }, resolve));
  expect(response.ok).toBe(true);
  expect(receivedCorrectKey).toBe(true);
});

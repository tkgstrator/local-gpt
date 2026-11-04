import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

async function dashboard(t, health, capabilities = { models: null, plan: null, observedAt: null, source: "chatgpt_api", selectionSupported: false }, localmcp = {configured:false,connected:false,tools:[],chatgptConnection:"not_verified"}) {
  const window = new Window({ url: 'http://localhost:8766/' });
  window.document.write(await readFile('dist/dashboard.html', 'utf8'));
  let copied = '';
  const navigator = { clipboard: { writeText: async text => { copied = text; } } };
  const fakeFetch = async path => new Response(JSON.stringify(path === "/v1/localmcp" ? localmcp : path === "/v1/capabilities" ? capabilities : health), { headers: { 'Content-Type': 'application/json' } });
  const names = ['window', 'document', 'location', 'navigator', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
  const values = [window, window.document, window.location, navigator, fakeFetch, window.setInterval.bind(window), window.clearInterval.bind(window), window.setTimeout.bind(window), window.clearTimeout.bind(window)];
  new Function(...names, await readFile('dist/dashboard.js', 'utf8'))(...values);
  t.after(async () => { window.dispatchEvent(new window.Event('pagehide')); await window.happyDOM.abort(); window.close(); });
  for (let i = 0; i < 20 && window.document.getElementById('server-status').textContent === '確認中…'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  return { document: window.document, copied: () => copied };
}
test('dashboard shows disconnected browser as waiting rather than ready', async t => {
  const { document } = await dashboard(t, { status: 'ok', browserConnected: false, transport: null, busy: false, wsPort: 8875 });
  assert.equal(document.getElementById('server-status').textContent, '稼働中');
  assert.equal(document.getElementById('browser-status').textContent, '接続待ち');
  assert.equal(document.getElementById('connection-notice').dataset.state, 'waiting');
});
test('dashboard shows connected browser and copies usable API address', async t => {
  const { document, copied } = await dashboard(t, { status: 'ok', browserConnected: true, transport: 'http', busy: false, wsPort: 8875 });
  assert.equal(document.getElementById('request-status').textContent, '受付可能');
  assert.equal(document.getElementById('connection-notice').dataset.state, 'ready');
  document.querySelector('[data-copy="endpoint"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(copied(), 'http://localhost:8766/v1/responses');
  document.querySelector('[data-installer="userscript"]').click();
  assert.equal(document.getElementById('install-extension').hidden, true);
  assert.equal(document.getElementById('install-userscript').hidden, false);
});
test('invalid health response does not claim a healthy connection', async t => {
  const { document } = await dashboard(t, { status: 'ok', browserConnected: 'yes' });
  assert.equal(document.getElementById('connection-notice').dataset.state, 'error');
});

test('dashboard renders API model, reasoning and plan using text rather than HTML', async t => {
  const { document } = await dashboard(t, { status: 'ok', browserConnected: true, transport: 'http', busy: false, wsPort: 8875 }, { models: [{ id: 'test-thinking', name: '<img src=x>', reasoning: 'reasoning', configurable: true, efforts: [{ id: 'standard', label: 'Standard' }, { id: 'extended', label: 'Extended' }] }], plan: 'pro', planTier: '200', observedAt: new Date().toISOString(), source: 'chatgpt_api', selectionSupported: false });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(document.getElementById('account-plan').textContent, 'Pro 200');
  assert.match(document.getElementById('capability-models').textContent, /Standard \/ Extended/);
  assert.equal(document.querySelector('#capability-models img'), null);
});

test('dashboard separates four connection states and does not equate gateway with ChatGPT plugin access',async t=>{
 const {document}=await dashboard(t,{status:'ok',browserConnected:false,transport:null,busy:false,wsPort:8875},undefined,{configured:true,connected:true,tools:['localmcp_read_file','localmcp_write_file'],chatgptConnection:'not_verified'});
 assert.deepEqual([...document.querySelectorAll('[aria-label="接続状態"] h2')].map(n=>n.textContent),['サーバー','ブラウザ','リクエスト','ファイル操作']);
 assert.equal(document.getElementById('localmcp-status').textContent,'接続済み');assert.match(document.getElementById('localmcp-detail').textContent,/2ツール/);assert.match(document.getElementById('localmcp-chatgpt').textContent,/未確認/);
 assert.equal(document.getElementById('browser-status').textContent,'接続待ち');
});

async function routedDashboard(t, route) {
  const window = new Window({ url: 'http://localhost:8766/' });
  window.document.write(await readFile('dist/dashboard.html', 'utf8'));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fakeFetch = async path => path === '/v1/localmcp' ? json({configured:false,connected:false,tools:[],chatgptConnection:'not_verified'}) : route(path, json);
  const names = ['window', 'document', 'location', 'navigator', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
  const values = [window, window.document, window.location, { clipboard: { writeText: async () => {} } }, fakeFetch, window.setInterval.bind(window), window.clearInterval.bind(window), window.setTimeout.bind(window), window.clearTimeout.bind(window)];
  new Function(...names, await readFile('dist/dashboard.js', 'utf8'))(...values);
  t.after(async () => { window.dispatchEvent(new window.Event('pagehide')); await window.happyDOM.abort(); window.close(); });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 10)); };
  const refresh = async () => { window.document.getElementById('refresh-status').click(); await settle(); };
  await settle();
  return { document: window.document, refresh };
}
const busyHealth = (extra = {}) => ({ status: 'ok', browserConnected: true, transport: 'http', busy: true, wsPort: 8875, ...extra });
const proCapabilities = { models: [{ id: 'test-thinking', name: 'Test Thinking', reasoning: 'reasoning', configurable: false, efforts: [] }], plan: 'pro', planTier: '200', observedAt: '2026-01-01T00:00:00.000Z', source: 'chatgpt_api', selectionSupported: false };

test('busy dashboard loads the capability snapshot automatically', async t => {
  const { document } = await routedDashboard(t, (path, json) => path === '/v1/capabilities' ? json(proCapabilities) : json(busyHealth()));
  assert.equal(document.getElementById('account-plan').textContent, 'Pro 200');
  assert.match(document.getElementById('capability-models').textContent, /Test Thinking \(test-thinking\)/);
});

test('busy dashboard keeps rendered capabilities on 409 and explains the retry', async t => {
  let busy = false;
  const { document, refresh } = await routedDashboard(t, (path, json) => path === '/v1/capabilities'
    ? (busy ? json({ error: { code: 'browser_busy', message: 'busy' } }, 409) : json(proCapabilities))
    : json(busyHealth()));
  assert.equal(document.getElementById('account-plan').textContent, 'Pro 200');
  busy = true;
  await refresh();
  assert.equal(document.getElementById('account-plan').textContent, 'Pro 200');
  assert.match(document.getElementById('capability-models').textContent, /Test Thinking/);
  assert.match(document.getElementById('capability-detail').textContent, /処理中/);
  assert.doesNotMatch(document.getElementById('capability-detail').textContent, /取得できませんでした/);
});

test('dashboard skips capability reads while updating and clears them on disconnect', async t => {
  let health = busyHealth(), reads = 0;
  const { document, refresh } = await routedDashboard(t, (path, json) => path === '/v1/capabilities' ? (reads++, json(proCapabilities)) : json(health));
  assert.equal(reads, 1);
  health = busyHealth({ updating: true });
  await refresh();
  assert.equal(reads, 1);
  health = busyHealth({ browserConnected: false, transport: null, busy: false });
  await refresh();
  assert.equal(reads, 1);
  assert.equal(document.getElementById('account-plan').textContent, '未取得');
  assert.equal(document.getElementById('capability-models').textContent, '');
});

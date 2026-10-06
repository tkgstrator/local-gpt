import { test, installNativeEditing } from './test-support.mjs';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readFile } from 'node:fs/promises';
const ATTEMPT_KEY = 'localgpt:update-attempt';
// Runs the built content script against a fake background that advertises an update on idle polls.
async function fixture(t, { url = 'https://chatgpt.com/', before, after, state = {} } = {}) {
  const page = new Window({ url });
  t.after(async () => { page.dispatchEvent(new page.Event('pagehide')); await page.happyDOM.abort(); page.close(); });
  page.document.body.innerHTML = '<form><div role="textbox" contenteditable="true"></div><button aria-label="Send">Send</button></form>';
  await page.happyDOM.waitUntilComplete();
  installNativeEditing(page);
  const s = { calls: [], reloads: 0, polls: 0, update: { version: '2.4.14' }, ready: { ready: true }, reloadOk: true, invalidated: false, onReady: null, ...state };
  page.chrome = { runtime: { id: 'our-id', sendMessage: async r => {
    if (s.invalidated) throw new Error('Extension context invalidated.');
    s.calls.push({ path: r.path, data: r.data });
    if (r.path === 'poll') { s.polls++; return { ok: true, data: s.update ? { request: null, update: s.update } : { request: null } }; }
    if (r.path === 'update-ready') { s.onReady?.(); return { ok: true, data: s.ready }; }
    if (r.path === 'reload') return s.reloadOk ? { ok: true, data: { reloading: true } } : { ok: false, error: 'No drain lease' };
    return { ok: true, data: { ok: true, accepted: false } };
  } } };
  const location = new Proxy(page.location, { get: (target, key) => key === 'reload' ? () => { s.reloads++; } : Reflect.get(target, key) });
  before?.(page);
  const globals = ['chrome', 'window', 'document', 'location', 'HTMLTextAreaElement', 'WebSocket', 'CustomEvent', 'crypto', 'sessionStorage', 'setTimeout', 'clearTimeout'];
  new Function(...globals, await readFile('dist/extension/content.js', 'utf8'))(...globals.map(k => k === 'window' ? page : k === 'location' ? location : ['setTimeout', 'clearTimeout'].includes(k) ? page[k].bind(page) : page[k]));
  after?.(page);
  const paths = () => s.calls.map(c => c.path);
  const status = () => page.document.getElementById('chatgpt-local-api-status').textContent;
  return { page, s, paths, status };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await wait(20); } return false; }

test('idle tab acquires a drain lease, requests runtime reload, then reloads ChatGPT once', async t => {
  const f = await fixture(t);
  assert.ok(await until(() => f.s.reloads === 1, 6000), JSON.stringify(f.paths()));
  const ready = f.s.calls.find(c => c.path === 'update-ready');
  const reload = f.s.calls.find(c => c.path === 'reload');
  assert.deepEqual(ready.data, { version: '2.4.14' });
  assert.deepEqual(reload.data, { version: '2.4.14' });
  assert.ok(f.paths().indexOf('update-ready') < f.paths().indexOf('reload'));
  assert.equal(f.page.sessionStorage.getItem(ATTEMPT_KEY), '2.4.14');
  // Polling stops so the server lease is not released by this tab before it reloads.
  const polls = f.s.polls; await wait(1600); assert.equal(f.s.polls, polls); assert.equal(f.s.reloads, 1);
  assert.equal(f.paths().filter(p => p === 'reload').length, 1);
});

test('no metadata means no update attempt', async t => {
  const f = await fixture(t, { state: { update: null } });
  await wait(1800);
  assert.equal(f.paths().includes('update-ready'), false); assert.equal(f.s.reloads, 0);
});

for (const [name, setup] of [
  ['an unsent manual draft', page => { page.document.querySelector('[role="textbox"]').textContent = 'my unsent words'; }],
  ['a manual attachment', page => { page.document.querySelector('form').insertAdjacentHTML('beforeend', '<button aria-label="Remove photo.png">x</button>'); }],
  ['an active ChatGPT generation', page => { page.document.body.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>'); }],
  ['a pending saved-draft recovery', page => { page.sessionStorage.setItem('localgpt:draft-backups:v1', JSON.stringify([{ route: '/c/6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3', text: 'saved earlier' }])); }],
  ['a previous attempt for the same version', page => { page.sessionStorage.setItem(ATTEMPT_KEY, '2.4.14'); }],
  ['an open dialog', page => { page.document.body.insertAdjacentHTML('beforeend', '<div role="dialog">Settings</div>'); }],
  ['an in-place message edit', page => { page.document.body.insertAdjacentHTML('beforeend', '<textarea>edited message</textarea>'); }],
]) {
  test(`never reloads with ${name}`, async t => {
    const f = await fixture(t, { before: setup });
    await wait(1800);
    assert.ok(f.s.polls > 0);
    assert.equal(f.paths().includes('update-ready'), false, name);
    assert.equal(f.paths().includes('reload'), false); assert.equal(f.s.reloads, 0);
  });
}

test('a manual edit just now defers the update for a quiet interval', async t => {
  const f = await fixture(t, { after: page => { page.document.querySelector('[role="textbox"]').dispatchEvent(new page.Event('input', { bubbles: true })); } });
  await wait(1800);
  assert.ok(f.s.polls > 0);
  assert.equal(f.paths().includes('update-ready'), false); assert.equal(f.s.reloads, 0);
});

test('refused drain lease keeps polling without reloading', async t => {
  const f = await fixture(t, { state: { ready: { ready: false, reason: 'browser_busy' } } });
  assert.ok(await until(() => f.paths().includes('update-ready')));
  const polls = f.s.polls; await wait(1600);
  assert.ok(f.s.polls > polls);
  assert.equal(f.paths().includes('reload'), false); assert.equal(f.s.reloads, 0);
});

test('a draft typed while the lease was being acquired cancels the reload and resumes polling', async t => {
  let page;
  const f = await fixture(t, { before: p => { page = p; }, state: { onReady: () => { page.document.querySelector('[role="textbox"]').textContent = 'typed during lease'; } } });
  assert.ok(await until(() => f.paths().includes('update-ready')));
  const polls = f.s.polls; await wait(1600);
  assert.ok(f.s.polls > polls, 'polling resumes so the server releases the lease');
  assert.equal(f.paths().includes('reload'), false); assert.equal(f.s.reloads, 0);
  assert.equal(f.page.document.querySelector('[role="textbox"]').textContent, 'typed during lease');
});

test('refused runtime reload does not reload the page or retry the same version', async t => {
  const f = await fixture(t, { state: { reloadOk: false } });
  assert.ok(await until(() => f.paths().includes('reload')));
  const polls = f.s.polls; await wait(1600);
  assert.ok(f.s.polls > polls);
  assert.equal(f.paths().filter(p => p === 'reload').length, 1);
  assert.equal(f.paths().filter(p => p === 'update-ready').length, 1);
  assert.equal(f.s.reloads, 0);
});

test('orphaned content stops its retry loop, says reload is required and reloads when safe', async t => {
  const f = await fixture(t, { state: { update: null, invalidated: true } });
  assert.ok(await until(() => /再読み込み/.test(f.status())), f.status());
  assert.ok(await until(() => f.s.reloads === 1));
  const before = f.s.reloads; await wait(1500); assert.equal(f.s.reloads, before);
});

test('orphaned content with a draft shows reload required but never reloads', async t => {
  const f = await fixture(t, { before: page => { page.document.querySelector('[role="textbox"]').textContent = 'keep me'; }, state: { update: null, invalidated: true } });
  assert.ok(await until(() => /再読み込み/.test(f.status())), f.status());
  await wait(2500);
  assert.equal(f.s.reloads, 0);
  assert.equal(f.page.document.querySelector('[role="textbox"]').textContent, 'keep me');
});

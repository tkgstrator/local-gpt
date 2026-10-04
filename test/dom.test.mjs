import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const dom = require('../dist/chatgpt-dom.cjs');
test('contenteditable composer receives multiline text and input event', () => {
  const page = new JSDOM('<div role="textbox" contenteditable="true"></div>');
  let inputs = 0;
  const editor = page.window.document.querySelector('div');
  editor.addEventListener('input', () => inputs++);
  dom.writeEditor(page.window.document, 'one\ntwo');
  assert.equal(editor.textContent, 'one\ntwo');
  assert.ok(inputs > 0);
});
test('does not overwrite a user draft', () => {
  const page = new JSDOM('<div role="textbox" contenteditable="true">unsent draft</div>');
  assert.throws(() => dom.writeEditor(page.window.document, 'replace'), /draft/i);
  assert.equal(page.window.document.querySelector('div').textContent, 'unsent draft');
});
test('missing input editor raises a descriptive error', () => {
  assert.throws(() => dom.writeEditor(new JSDOM('<main></main>').window.document, 'test'), /input editor/i);
});
test('textarea composer is still supported', () => {
  const page = new JSDOM('<textarea id="prompt-textarea"></textarea>');
  dom.writeEditor(page.window.document, 'legacy\ninput');
  assert.equal(page.window.document.querySelector('textarea').value, 'legacy\ninput');
});
test('answer lookup chooses latest assistant and preserves code whitespace', () => {
  const page = new JSDOM('<div data-message-author-role="assistant">old</div><div data-message-author-role="user">question</div><div data-message-author-role="assistant"><div class="markdown"><pre>if (true) {\n  run();\n}</pre></div></div>');
  assert.equal(dom.readLatestAnswer(page.window.document), 'if (true) {\n  run();\n}');
});
test('new ChatGPT markers read visible composers and assistant message text',()=>{
 const page=new JSDOM('<div hidden><textarea>hidden draft</textarea><button aria-label="Send" disabled></button></div><form><div role="textbox" contenteditable="true"></div><button aria-label="Send"></button></form><div data-user-message-bubble>question</div><div data-chatgpt-selection-message-id="answer-id"><div data-markdown-text-style="assistant-message"><p>New answer</p></div><button>Copy</button></div>');
 const {findEditor,findSendButton,readLatestAnswer}=require('../dist/chatgpt-dom.cjs');assert.equal(findEditor(page.window.document).tagName,'DIV');assert.equal(findSendButton(page.window.document).disabled,false);assert.equal(readLatestAnswer(page.window.document),'New answer');
});
test('zero-sized inactive composer is skipped when selecting editor and send button', () => {
  const page = new JSDOM('<div role="textbox" contenteditable="true" id="inactive"></div><button aria-label="Send" disabled id="inactive-send"></button><div role="textbox" contenteditable="true" id="active"></div><button aria-label="Send" id="active-send"></button>');
  const doc = page.window.document;
  Object.defineProperty(doc.documentElement, 'clientWidth', { value: 1600 });
  for (const node of doc.querySelectorAll('[id]')) {
    const active = node.id.startsWith('active');
    node.getClientRects = () => [{ width: active ? 520 : 0, height: active ? 26 : 0 }];
  }
  dom.writeEditor(doc, 'review this PR');
  assert.equal(doc.getElementById('inactive').textContent, '');
  assert.equal(doc.getElementById('active').textContent, 'review this PR');
  assert.equal(dom.findSendButton(doc).id, 'active-send');
});

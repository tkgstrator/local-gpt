import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { once } from 'node:events';
const require=createRequire(import.meta.url);const {WebSocket}=require('ws');
test('model observation reads only selector and visible model menu without clicking',()=>{
 const {readModels}=require('../dist/chatgpt-dom.cjs');
 const page=new JSDOM('<button data-testid="model-switcher-dropdown-button">ChatGPT Model X</button><div role="menu" aria-label="Models"><div role="menuitemradio" aria-checked="true">Model X</div><div role="menuitemradio">Model Y</div><div role="menuitemradio" hidden>Hidden</div></div><main>Private conversation Model Z</main>');
 const result=readModels(page.window.document);assert.equal(result.selected,'Model X');assert.deepEqual(result.models,['Model X','Model Y']);assert.equal(result.source,'visible_ui');
 assert.deepEqual(readModels(new JSDOM('<main>Model X</main>').window.document),{selected:null,selectionLabel:null,models:[],source:'visible_ui'});
});
test('models API uses correlated browser request and returns observed labels',async t=>{
 const {createService}=require('../dist/server.cjs');const service=createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:500});const ports=await service.start();t.after(()=>service.close());
 const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');ws.on('message',raw=>{const r=JSON.parse(raw);assert.equal(r.type,'models');ws.send(JSON.stringify({type:'models',requestId:r.requestId,selected:'Model X',models:['Model X','Model Y'],source:'visible_ui'}));});
 const res=await fetch(`http://127.0.0.1:${ports.httpPort}/v1/models`);assert.equal(res.status,200);const body=await res.json();assert.equal(body.object,'list');assert.equal(body.selected,'Model X');assert.equal(body.data[0].id,'Model X');assert.equal(body.canSelect,false);
});

test('new model picker keeps effort label separate and closes inspection menu',async()=>{
 const {readModels,inspectModels,isWorkMode}=require('../dist/chatgpt-dom.cjs');
 const page=new JSDOM('<button aria-label="Select ChatGPT model" aria-expanded="false"><span aria-hidden="true">Thinking effort</span>Pro</button><div role="textbox" contenteditable="true">draft</div><button aria-pressed="true">Work</button>');
 const doc=page.window.document;const selector=doc.querySelector('button');assert.equal(isWorkMode(doc),true);assert.equal(readModels(doc).selected,null);assert.equal(readModels(doc).selectionLabel,'Pro');
 selector.addEventListener('pointerdown',()=>{selector.setAttribute('aria-expanded','true');doc.body.insertAdjacentHTML('beforeend','<div role="menu" aria-label="Select ChatGPT model"><div role="menuitemradio" aria-checked="true">Latest</div><div role="menuitemradio">Model X</div></div>');});
 doc.addEventListener('keydown',e=>{if(e.key==='Escape'){doc.querySelector('[role="menu"]')?.remove();selector.setAttribute('aria-expanded','false');}});
 const observed=await inspectModels(doc);assert.equal(observed.selected,'Latest');assert.deepEqual(observed.models,['Latest','Model X']);assert.equal(selector.getAttribute('aria-expanded'),'false');assert.equal(doc.querySelector('[role="textbox"]').textContent,'draft');
});

test('model menus labelled by their trigger id are recognized',()=>{
 const {readModels}=require('../dist/chatgpt-dom.cjs');const page=new JSDOM('<button id="picker" aria-label="Select ChatGPT model">Pro</button><div role="menu" aria-labelledby="picker"><div role="menuitemradio" aria-checked="true">Latest</div><div role="menuitemradio">Model X</div></div><div role="menu" aria-label="Other"><div role="menuitemradio">Private unrelated</div></div>');
 assert.deepEqual(readModels(page.window.document).models,['Latest','Model X']);
});

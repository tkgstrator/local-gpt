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
const cap=(r,models,extra={})=>JSON.stringify({type:'capabilities',requestId:r.requestId,models,plan:'pro',observedAt:'2026-11-02T01:02:03.000Z',source:'chatgpt_api',selectionSupported:false,...extra});
const apiModel=(id,name)=>({id,name,reasoning:null,configurable:false,efforts:[]});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function modelsFixture(t,timeoutMs=500){
 const {createService}=require('../dist/server.cjs');const service=createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs,bridgeToken:'models-key'});const ports=await service.start();t.after(()=>service.close());
 const base=`http://127.0.0.1:${ports.httpPort}`;
 const bridge=(path,body)=>fetch(`${base}/bridge/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'models-key','X-Browser-Id':'models-http'},body:JSON.stringify(body)});
 const connect=async()=>{const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?token=models-key`);await once(ws,'open');t.after(()=>ws.close());return{ws,seen:[]};};
 return{base,ports,bridge,connect,health:async()=>(await fetch(base+'/health')).json()};
}
test('models API with non-empty capabilities returns real IDs without a DOM request',async t=>{
 const f=await modelsFixture(t);const {ws,seen}=await f.connect();
 ws.on('message',raw=>{const r=JSON.parse(raw);seen.push(r.type);if(r.type==='capabilities')ws.send(cap(r,[apiModel('gpt-6','GPT-6'),apiModel('gpt-5-6-sol','GPT-5.6 Sol')]));});
 const res=await fetch(f.base+'/v1/models');assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');const body=await res.json();
 assert.deepEqual(seen,['capabilities']);assert.equal(body.object,'list');assert.equal(body.source,'chatgpt_api');assert.equal(body.scope,'available_chat_models');
 assert.deepEqual(body.data.map(m=>[m.id,m.display_name,m.owned_by,m.object]),[['gpt-6','GPT-6','chatgpt','model'],['gpt-5-6-sol','GPT-5.6 Sol','chatgpt','model']]);
 assert.equal(body.observedAt,'2026-11-02T01:02:03.000Z');assert.equal(body.selected,null);assert.equal(body.selectionLabel,null);assert.equal(body.canSelect,false);
 assert.equal((await f.health()).busy,false);
});
test('models API treats an observed empty capabilities list as API data, not a DOM fallback',async t=>{
 const f=await modelsFixture(t);const {ws,seen}=await f.connect();
 ws.on('message',raw=>{const r=JSON.parse(raw);seen.push(r.type);if(r.type==='capabilities')ws.send(cap(r,[]));});
 const res=await fetch(f.base+'/v1/models');const body=await res.json();
 assert.equal(res.status,200);assert.deepEqual(seen,['capabilities']);assert.deepEqual(body.data,[]);assert.equal(body.source,'chatgpt_api');assert.equal(body.scope,'available_chat_models');assert.equal(body.observedAt,'2026-11-02T01:02:03.000Z');assert.equal(body.canSelect,false);
});
test('models API reports a null observedAt unchanged',async t=>{
 const f=await modelsFixture(t);const {ws}=await f.connect();
 ws.on('message',raw=>{const r=JSON.parse(raw);if(r.type==='capabilities')ws.send(cap(r,[apiModel('a','A')],{observedAt:null}));});
 assert.equal((await(await fetch(f.base+'/v1/models')).json()).observedAt,null);
});
test('models API falls back to DOM only for null capabilities, with fresh IDs and the lane held',async t=>{
 const f=await modelsFixture(t);const {ws,seen}=await f.connect();const ids=[];let busyDuring;
 ws.on('message',async raw=>{const r=JSON.parse(raw);seen.push(r.type);ids.push(r.requestId);
  if(r.type==='capabilities'){ws.send(cap(r,null,{observedAt:null}));}
  else if(r.type==='models'){busyDuring=(await f.health()).busy;
   ws.send(cap({requestId:ids[0]},[apiModel('stale','Stale')]));
   ws.send(JSON.stringify({type:'models',requestId:ids[0],selected:'Stale',models:['Stale'],source:'visible_ui'}));
   ws.send(JSON.stringify({type:'models',requestId:r.requestId,selected:'Model X',selectionLabel:'Pro',models:['Model X','Model Y'],source:'visible_ui'}));}});
 const res=await fetch(f.base+'/v1/models');const body=await res.json();
 assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');assert.deepEqual(seen,['capabilities','models']);assert.notEqual(ids[0],ids[1]);assert.equal(busyDuring,true);
 assert.equal(body.source,'visible_ui');assert.equal(body.scope,'currently_visible_controls');assert.equal(body.selected,'Model X');assert.equal(body.data[0].id,'Model X');assert.equal(body.canSelect,false);
 assert.equal((await f.health()).busy,false);
});
test('a second request is refused as busy while the DOM fallback stage runs',async t=>{
 const f=await modelsFixture(t);const {ws}=await f.connect();let release;const gate=new Promise(r=>release=r);let stage2;
 ws.on('message',raw=>{const r=JSON.parse(raw);if(r.type==='capabilities')ws.send(cap(r,null,{observedAt:null}));else if(r.type==='models'){stage2=r;gate.then(()=>ws.send(JSON.stringify({type:'models',requestId:r.requestId,selected:null,models:[],source:'visible_ui'})));}});
 const first=fetch(f.base+'/v1/models');for(let i=0;i<100&&!stage2;i++)await sleep(10);
 assert.equal((await fetch(f.base+'/v1/models')).status,409);assert.equal((await fetch(f.base+'/v1/capabilities')).status,409);release();assert.equal((await first).status,200);
});
test('models API has one overall timeout across both stages and then frees the lane',async t=>{
 const f=await modelsFixture(t,300);const {ws}=await f.connect();
 ws.on('message',raw=>{const r=JSON.parse(raw);if(r.type==='capabilities')setTimeout(()=>ws.send(cap(r,null,{observedAt:null})),200);});
 const started=Date.now();const res=await fetch(f.base+'/v1/models');
 assert.equal(res.status,504);assert.equal((await res.json()).error.code,'browser_timeout');assert.ok(Date.now()-started<450,'timeout must not restart for stage two');
 assert.equal((await f.health()).busy,false);
});
test('models API cleans up on browser error in either stage',async t=>{
 const f=await modelsFixture(t);const {ws}=await f.connect();let mode='cap';
 ws.on('message',raw=>{const r=JSON.parse(raw);if(r.type==='capabilities')ws.send(mode==='cap'?JSON.stringify({type:'error',requestId:r.requestId,code:'cap_failed',message:'no caps'}):cap(r,null,{observedAt:null}));else ws.send(JSON.stringify({type:'error',requestId:r.requestId,code:'dom_failed',message:'no dom'}));});
 let res=await fetch(f.base+'/v1/models');assert.equal(res.status,502);assert.equal((await res.json()).error.code,'cap_failed');assert.equal((await f.health()).busy,false);
 mode='dom';res=await fetch(f.base+'/v1/models');assert.equal(res.status,502);assert.equal((await res.json()).error.code,'dom_failed');assert.equal((await f.health()).busy,false);
});
test('models API cleans up when the client disconnects during the DOM stage',async t=>{
 const f=await modelsFixture(t);const {ws}=await f.connect();let stage2=false;
 ws.on('message',raw=>{const r=JSON.parse(raw);if(r.type==='capabilities')ws.send(cap(r,null,{observedAt:null}));else stage2=true;});
 const abort=new AbortController();const pending=fetch(f.base+'/v1/models',{signal:abort.signal}).catch(()=>null);
 for(let i=0;i<100&&!stage2;i++)await sleep(10);assert.equal(stage2,true);abort.abort();await pending;
 for(let i=0;i<100&&(await f.health()).busy;i++)await sleep(10);assert.equal((await f.health()).busy,false);
});
test('models API reports a disconnected browser without a request',async t=>{
 const f=await modelsFixture(t);const res=await fetch(f.base+'/v1/models');assert.equal(res.status,503);assert.equal((await res.json()).error.code,'browser_disconnected');
});
test('models API works over HTTP polling for both the API and fallback stages',async t=>{
 const f=await modelsFixture(t);assert.equal((await f.bridge('poll',{})).status,200);
 const next=async()=>{for(let i=0;i<100;i++){const r=(await(await f.bridge('poll',{})).json()).request;if(r)return r;await sleep(10);}throw Error('no request');};
 const api=fetch(f.base+'/v1/models');let r=await next();assert.equal(r.type,'capabilities');
 await f.bridge('event',JSON.parse(cap(r,[apiModel('gpt-6','GPT-6')])));
 let body=await(await api).json();assert.equal(body.source,'chatgpt_api');assert.equal(body.data[0].id,'gpt-6');
 const dom=fetch(f.base+'/v1/models');r=await next();assert.equal(r.type,'capabilities');const first=r.requestId;
 await f.bridge('event',JSON.parse(cap(r,null,{observedAt:null})));r=await next();assert.equal(r.type,'models');assert.notEqual(r.requestId,first);
 await f.bridge('event',{type:'models',requestId:r.requestId,selected:'Model X',models:['Model X'],source:'visible_ui'});
 body=await(await dom).json();assert.equal(body.source,'visible_ui');assert.equal(body.selected,'Model X');
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

import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { normalizeModels, normalizePlan, CAPABILITY_EVENT, CAPABILITY_REQUEST } = require('../dist/capabilities.cjs');
const models = { models: [ { slug: 'model-thinking', title: 'Test Thinking', reasoning_type: 'reasoning', configurable_thinking_effort: true, thinking_efforts: [{ thinking_effort: 'standard', short_label: 'Standard' }], unrelated_secret: 'never-export' }, { slug: 'internal', title: 'Hidden' } ], versions: [{ enabled: true, intelligence_presets: [{ model_slug: 'model-thinking', preset_type: 'available' }, { model_slug: 'internal', preset_type: 'upgrade' }] }] };
test('API capabilities filter unavailable models and strip unrelated data', () => {
 const result = normalizeModels(models); assert.deepEqual(result, [{ id: 'model-thinking', name: 'Test Thinking', reasoning: 'reasoning', configurable: true, efforts: [{ id: 'standard', label: 'Standard' }] }]);
 assert.equal(normalizeModels({ models: [] }), null);
 assert.equal(normalizePlan({ accounts: { default: { account: { plan_type: 'pro', email: 'private' } } } }), 'pro');
 assert.equal(normalizePlan({ accounts: { a: { account: { plan_type: 'pro' } }, b: { account: { plan_type: 'team' } } } }), null);
 assert.equal(normalizePlan({ accounts: { a: { account: { plan_type: 'pro' } }, b: { account: { plan_type: 'team' } } } }, 'b'), 'team');
});
test('page observer preserves fetch responses, forwards only exact routes and replays sanitized data', async t => {
 const page = new Window({ url: 'https://chatgpt.com/' }); t.after(() => page.close());
 page.fetch = async () => new Response(JSON.stringify(models), { headers: { 'Content-Type': 'application/json' } });
 const { installPageObserver } = require('../dist/page-observer.cjs'); installPageObserver(page);
 let observed; page.addEventListener(CAPABILITY_EVENT, e => { observed = JSON.parse(e.detail); });
 const response = await page.fetch('/backend-api/models?iim=false'); assert.deepEqual(await response.json(), models);
 for (let i=0;i<20 && !observed?.models;i++) await new Promise(r => setTimeout(r,10));
 assert.equal(observed.models[0].id, 'model-thinking'); assert.equal(JSON.stringify(observed).includes('never-export'), false);
 const captured = observed; await page.fetch('/backend-api/me'); await page.fetch('https://example.com/backend-api/models');
 await new Promise(r => setTimeout(r,10)); assert.deepEqual(observed, captured);
 observed = null; page.dispatchEvent(new page.CustomEvent(CAPABILITY_REQUEST)); assert.deepEqual(observed, captured);
});
test('capabilities API uses a correlated browser reply and drops extra fields', async t => {
 const { createService } = require('../dist/server.cjs'); const service=createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:500}); const ports=await service.start(); t.after(()=>service.close());
 const { WebSocket }=require('ws'); const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`); await once(ws,'open');
 ws.on('message', raw => { const r=JSON.parse(raw); assert.equal(r.type,'capabilities'); ws.send(JSON.stringify({ type:'capabilities', requestId:r.requestId, models:normalizeModels(models), plan:'pro', observedAt:new Date().toISOString(), source:'chatgpt_api', selectionSupported:false, secret:'never-export' })); });
 const res=await fetch(`http://127.0.0.1:${ports.httpPort}/v1/capabilities`); assert.equal(res.status,200); const data=await res.json(); assert.equal(data.plan,'pro'); assert.equal(data.models[0].id,'model-thinking'); assert.equal(data.secret,undefined); assert.equal(data.requestId,undefined);
});
test('workspace change clears both fields and ignores late responses from previous workspace', async t => {
 const page=new Window({url:'https://chatgpt.com/'}); t.after(()=>page.close()); const requests=[];
 page.fetch=()=>new Promise(resolve=>requests.push(resolve)); require('../dist/page-observer.cjs').installPageObserver(page);
 let snapshot; page.addEventListener(CAPABILITY_EVENT,e=>{snapshot=JSON.parse(e.detail);});
 const apiResponse=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 const headers=id=>({'ChatGPT-Account-ID':id});
 const a=page.fetch('/backend-api/models',{headers:headers('a')});
 const b=page.fetch('/backend-api/accounts/check/v4-2023-04-27',{headers:headers('b')});
 requests[1](apiResponse({accounts:{b:{account:{plan_type:'team'}}}})); await b;
 for(let i=0;i<20&&snapshot.plan!== 'team';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(snapshot.plan,'team'); assert.equal(snapshot.models,null);
 requests[0](apiResponse(models)); await a; await new Promise(r=>setTimeout(r,20)); assert.equal(snapshot.plan,'team'); assert.equal(snapshot.models,null);
 const bModels=page.fetch('/backend-api/models',{headers:headers('b')});requests[2](apiResponse(models));await bModels;
 for(let i=0;i<20&&snapshot.models===null;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(snapshot.models[0].id,'model-thinking'); assert.equal(JSON.stringify(snapshot).includes('accountId'),false);
});

test('Pro numbered tier comes from subscription SKU, never inferred from generic pro or invoice amount', () => {
 const { normalizePlanDetails } = require('../dist/capabilities.cjs');
 for (const [sku,tier] of [['chatgptprolite','100'],['chatgptpro','200'],['chatgptpromax','500']]) assert.deepEqual(normalizePlanDetails({accounts:{default:{account:{plan_type:'pro'},entitlement:{subscription_plan:sku}}}}), {plan:'pro',planTier:tier});
 assert.deepEqual(normalizePlanDetails({accounts:{default:{account:{plan_type:'pro'},entitlement:{subscription_plan:'future-pro',amount:200}}}}), {plan:'pro',planTier:null});
});

 test('turn observer clones before native fetch consumes Request and forwards identifiers only', async t => {
 const page = new Window({url:'https://chatgpt.com/'}); t.after(()=>page.close()); page.Request = Request;
 const messageId='094c6dd5-45d0-4da3-bd50-a79ef778addb'; let consumed; let receipt; const result=Promise.resolve(new Response('ok'));
 page.fetch=input=>{consumed=input.text();return result;};
 require('../dist/page-observer.cjs').installPageObserver(page);
 page.addEventListener('localgpt:submitted-turn',e=>receipt=JSON.parse(e.detail));
 const request=new Request('https://chatgpt.com/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{id:messageId,author:{role:'user'},content:{secret:'never-export'}}],access_token:'never-export'})});
 assert.equal(page.fetch(request),result);await consumed;
 for(let i=0;i<30&&!receipt;i++)await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(receipt,{messageId,conversationId:null});
 });

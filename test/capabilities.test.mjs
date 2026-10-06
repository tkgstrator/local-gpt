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

test('deletion observer requires a successful exact chat deletion and exports only its ID',async t=>{
 const page=new Window({url:'https://chatgpt.com/'});t.after(()=>page.close());page.Request=Request;
 let status=200;page.fetch=()=>Promise.resolve(new Response('{}',{status}));
 require('../dist/page-observer.cjs').installPageObserver(page);
 const events=[];page.addEventListener('localgpt:conversation-deleted',e=>events.push(JSON.parse(e.detail)));
 const id='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';const path=`/backend-api/conversation/${id}`;
 const send=async(method,body,url=path)=>{await page.fetch(url,{method,body:JSON.stringify(body)});await new Promise(r=>setTimeout(r,20));};
 await send('PATCH',{is_visible:false,secret:'never-export'});assert.deepEqual(events,[{conversationId:id}]);
 status=500;await send('PATCH',{is_visible:false});status=200;
 await send('PATCH',{is_archived:true});await send('PATCH',{is_visible:false,is_archived:true});await send('GET',{});await send('PATCH',{is_visible:false},`https://example.com${path}`);
 assert.equal(events.length,1);await send('DELETE',{});assert.equal(events.length,2);
 await page.fetch(new Request(`https://chatgpt.com${path}`,{method:'PATCH',body:JSON.stringify({is_visible:false})}));await new Promise(r=>setTimeout(r,30));assert.equal(events.length,3);
});
test('stream observer reads only the armed matching send and preserves native response',async t=>{
 const page=new Window({url:'https://chatgpt.com/'});t.after(()=>page.close());
 const id='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3',messageId='f5eadb59-b96e-4ef5-9342-2f49d62b3c6f';
 const m={id:'094c6dd5-45d0-4da3-bd50-a79ef778addb',author:{role:'assistant'},channel:'final',recipient:'all',content:{content_type:'text',parts:['API only']},status:'finished_successfully',end_turn:true};
 const body=`data: ${JSON.stringify({message:m,conversation_id:id})}\n\ndata: [DONE]\n\n`;
 let original;page.fetch=()=>{original=Promise.resolve(new Response(body,{headers:{'content-type':'text/event-stream'}}));return original;};
 require('../dist/page-observer.cjs').installPageObserver(page);const events=[];page.addEventListener('localgpt:response-stream',e=>events.push(JSON.parse(e.detail)));
 const send=text=>page.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{id:messageId,author:{role:'user'},content:{parts:[text]}}],secret:'never-export'})});
 await send('manual');await new Promise(r=>setTimeout(r,20));assert.equal(events.length,0);
 page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm',{detail:JSON.stringify({requestId:'job',text:'owned'})}));
 await send('unrelated');await new Promise(r=>setTimeout(r,20));assert.equal(events.length,0);
 const result=page.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{id:messageId,author:{role:'user'},content:{content_type:'multimodal_text',parts:['owned',{content_type:'image_asset_pointer',asset_pointer:'private-image'}]}}]})});assert.equal(result,original);assert.equal(await (await result).text(),body);
 for(let i=0;i<30&&!events.some(e=>e.kind==='stop');i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(events.find(e=>e.kind==='answer')?.text,'API only');assert.equal(events.at(-1)?.kind,'stop');assert.equal(events.at(-1)?.requestId,'job');assert.equal(JSON.stringify(events).includes('never-export'),false);
 const count=events.length;await send('owned');await new Promise(r=>setTimeout(r,20));assert.equal(events.length,count);
});
test('image download metadata is correlated with generated assets and never exports authentication',async t=>{
 const page=new Window({url:'https://chatgpt.com/'});t.after(()=>page.close());
 const cid='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3',mid='f5eadb59-b96e-4ef5-9342-2f49d62b3c6f';
 const tool={id:'094c6dd5-45d0-4da3-bd50-a79ef778addb',author:{role:'tool'},content:{content_type:'multimodal_text',parts:[{content_type:'image_asset_pointer',asset_pointer:'sediment://file_generated',metadata:{generation:{gen_id:'g'}}}]},status:'finished_successfully'};
 const body=`data: ${JSON.stringify({message:tool,conversation_id:cid})}\n\ndata: [DONE]\n\n`;
 page.fetch=async input=>new Response(input.includes('/f/conversation')?body:JSON.stringify({download_url:'https://x.oaiusercontent.com/image?sig=test',access_token:'never-export'}),{headers:{'content-type':input.includes('/f/conversation')?'text/event-stream':'application/json'}});
 require('../dist/page-observer.cjs').installPageObserver(page);const events=[];page.addEventListener('localgpt:response-stream',e=>events.push(JSON.parse(e.detail)));
 page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm',{detail:JSON.stringify({requestId:'image-job',text:'generate'})}));
 await page.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{id:mid,author:{role:'user'},content:{parts:['generate']}}]})});
 for(let i=0;i<10;i++)await page.fetch(`/backend-api/files/download/file_history_${i}?conversation_id=${cid}`);await new Promise(r=>setTimeout(r,40));
 await page.fetch(`/backend-api/files/download/file_generated?conversation_id=${cid}`,{headers:{Authorization:'Bearer never-export'}});
 for(let i=0;i<30&&!events.some(e=>e.kind==='image');i++)await new Promise(r=>setTimeout(r,10));
 const image=events.find(e=>e.kind==='image');assert.equal(image?.fileId,'file_generated');assert.equal(image?.requestId,'image-job');assert.equal(image?.conversationId,cid);assert.equal(JSON.stringify(events).includes('never-export'),false);
 const count=events.length;await page.fetch(`/backend-api/files/download/file_unrelated?conversation_id=${cid}`);await new Promise(r=>setTimeout(r,20));assert.equal(events.length,count);
 page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm',{detail:'image-job'}));await page.fetch(`/backend-api/files/download/file_generated?conversation_id=${cid}`);await new Promise(r=>setTimeout(r,20));assert.equal(events.length,count);
});

test('native authenticated image response is cloned without exporting URLs or authentication',async t=>{
 const page=new Window({url:'https://chatgpt.com/'});t.after(()=>page.close());
 const cid='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3',mid='f5eadb59-b96e-4ef5-9342-2f49d62b3c6f';
 const tool={id:'094c6dd5-45d0-4da3-bd50-a79ef778addb',author:{role:'tool'},content:{content_type:'multimodal_text',parts:[{content_type:'image_asset_pointer',asset_pointer:'sediment://file_generated',metadata:{generation:{gen_id:'g'}}}]},status:'finished_successfully'};
 const body=`data: ${JSON.stringify({message:tool,conversation_id:cid})}\n\ndata: [DONE]\n\n`;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 page.fetch=async input=>input.includes('/estuary/content')?new Response(png,{headers:{'content-type':'image/png'}}):new Response(input.includes('/f/conversation')?body:JSON.stringify({download_url:'https://chatgpt.com/backend-api/estuary/content?id=file_generated&sig=never-export',access_token:'never-export'}),{headers:{'content-type':input.includes('/f/conversation')?'text/event-stream':'application/json'}});
 require('../dist/page-observer.cjs').installPageObserver(page);const events=[];page.addEventListener('localgpt:response-stream',e=>events.push(JSON.parse(e.detail)));
 page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm',{detail:JSON.stringify({requestId:'image-job',text:'generate'})}));
 await page.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{id:mid,author:{role:'user'},content:{parts:['generate']}}]})});
 for(let i=0;i<10;i++)await page.fetch(`/backend-api/files/download/file_history_${i}?conversation_id=${cid}`);await new Promise(r=>setTimeout(r,40));
 await page.fetch(`/backend-api/files/download/file_generated?conversation_id=${cid}`,{headers:{Authorization:'Bearer never-export'}});
 const native=await page.fetch('/backend-api/estuary/content?id=file_generated&sig=never-export',{headers:{Authorization:'Bearer never-export'}});assert.deepEqual(Buffer.from(await native.arrayBuffer()),png);
 for(let i=0;i<30&&!events.some(e=>e.kind==='image');i++)await new Promise(r=>setTimeout(r,10));
 const image=events.find(e=>e.kind==='image');assert.equal(image?.imageData?.data,png.toString('base64'));assert.equal(image?.imageData?.mimeType,'image/png');assert.equal(image?.fileId,'file_generated');assert.equal(image?.requestId,'image-job');assert.equal(image?.conversationId,cid);assert.equal(JSON.stringify(events).includes('never-export'),false);
 const count=events.length;await page.fetch(`/backend-api/files/download/file_unrelated?conversation_id=${cid}`);await new Promise(r=>setTimeout(r,20));assert.equal(events.length,count);
 page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm',{detail:'image-job'}));await page.fetch(`/backend-api/files/download/file_generated?conversation_id=${cid}`);await new Promise(r=>setTimeout(r,20));assert.equal(events.length,count);
});
test('image bytes arriving before their generated reference are retained and matched by ID',async t=>{
 const page=new Window({url:'https://chatgpt.com/'});t.after(()=>page.close());
 const cid='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3',mid='f5eadb59-b96e-4ef5-9342-2f49d62b3c6f';
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 let controller;const stream=new ReadableStream({start(c){controller=c;}});
 page.fetch=async input=>new Response(input.includes('/f/conversation')?stream:png,{headers:{'content-type':input.includes('/f/conversation')?'text/event-stream':'image/png'}});
 require('../dist/page-observer.cjs').installPageObserver(page);const events=[];page.addEventListener('localgpt:response-stream',e=>events.push(JSON.parse(e.detail)));
 page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm',{detail:JSON.stringify({requestId:'early-image',text:'generate'})}));
 await page.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{id:mid,author:{role:'user'},content:{parts:['generate']}}]})});
 await page.fetch('/backend-api/estuary/content?id=file_unrelated');await page.fetch('/backend-api/estuary/content?id=file_generated');await new Promise(r=>setTimeout(r,30));
 assert.equal(events.some(e=>e.kind==='image'),false);
 const tool={id:'094c6dd5-45d0-4da3-bd50-a79ef778addb',author:{role:'tool'},content:{content_type:'multimodal_text',parts:[{content_type:'image_asset_pointer',asset_pointer:'sediment://file_generated',metadata:{generation:{gen_id:'g'}}}]},status:'finished_successfully'};
 controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({message:tool,conversation_id:cid})}\n\ndata: [DONE]\n\n`));controller.close();
 for(let i=0;i<30&&!events.some(e=>e.kind==='image');i++)await new Promise(r=>setTimeout(r,10));
 const images=events.filter(e=>e.kind==='image');assert.equal(images.length,1);assert.equal(images[0].fileId,'file_generated');assert.equal(images[0].imageData.data,png.toString('base64'));
});
test('observed native image URL is fetched without waiting for the visible chat to load it',async t=>{
 const page=new Window({url:'https://chatgpt.com/'});t.after(()=>page.close());
 const cid='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3',mid='f5eadb59-b96e-4ef5-9342-2f49d62b3c6f';
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');let nativeCalls=0;
 const tool={id:'094c6dd5-45d0-4da3-bd50-a79ef778addb',author:{role:'tool'},content:{content_type:'multimodal_text',parts:[{content_type:'image_asset_pointer',asset_pointer:'sediment://file_generated',metadata:{generation:{gen_id:'g'}}}]},status:'finished_successfully'};
 page.fetch=async(input,init)=>{if(input.includes('/estuary/content')){nativeCalls++;assert.equal(new Headers(init.headers).get('authorization'),'Bearer never-export');assert.equal(init.redirect,'error');return new Response(png,{headers:{'content-type':'image/png'}});}return new Response(input.includes('/f/conversation')?`data: ${JSON.stringify({message:tool,conversation_id:cid})}\n\ndata: [DONE]\n\n`:JSON.stringify({download_url:`https://chatgpt.com/backend-api/estuary/content?id=${input.includes('file_unrelated')?'file_unrelated':'file_generated'}&sig=never-export`}),{headers:{'content-type':input.includes('/f/conversation')?'text/event-stream':'application/json'}});};
 require('../dist/page-observer.cjs').installPageObserver(page);const events=[];page.addEventListener('localgpt:response-stream',e=>events.push(JSON.parse(e.detail)));
 page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm',{detail:JSON.stringify({requestId:'native-image',text:'generate'})}));
 await page.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{id:mid,author:{role:'user'},content:{parts:['generate']}}]})});await new Promise(r=>setTimeout(r,20));
 await page.fetch(`/backend-api/files/download/file_unrelated?conversation_id=${cid}`,{headers:{Authorization:'Bearer never-export'}});await new Promise(r=>setTimeout(r,20));assert.equal(nativeCalls,0);
 await page.fetch('/backend-api/files/download/file_generated?conversation_id=6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4',{headers:{Authorization:'Bearer never-export'}});await new Promise(r=>setTimeout(r,20));assert.equal(nativeCalls,0);
 await page.fetch(`/backend-api/files/download/file_generated?conversation_id=${cid}`,{headers:{Authorization:'Bearer never-export'}});
 for(let i=0;i<30&&!events.some(e=>e.kind==='image');i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(nativeCalls,1);assert.equal(events.find(e=>e.kind==='image')?.imageData.data,png.toString('base64'));assert.equal(JSON.stringify(events).includes('never-export'),false);
});
test('project move observes only the armed CID/project pair after a successful native PATCH',async t=>{
 const page=new Window({url:'https://chatgpt.com/'});t.after(()=>page.close());let status=200;
 page.fetch=async()=>new Response('{}',{status,headers:{'content-type':'application/json'}});require('../dist/page-observer.cjs').installPageObserver(page);
 const cid='6ac1f341-b4b4-83ee-afa2-6726f7913e60',pid='g-p-6ac2076d66d081919fc3db8b4db4af71';const events=[];
 page.addEventListener('localgpt:conversation-project',e=>events.push(JSON.parse(e.detail)));
 const arm=()=>page.dispatchEvent(new page.CustomEvent('localgpt:project-arm',{detail:JSON.stringify({conversationId:cid,projectId:pid})}));
 const patch=async(body,id=cid)=>{await page.fetch(`/backend-api/conversation/${id}`,{method:'PATCH',body:JSON.stringify(body)});await new Promise(r=>setTimeout(r,10));};
 await patch({gizmo_id:pid});assert.equal(events.length,0);
 arm();status=500;await patch({gizmo_id:pid});assert.equal(events.length,0);
 status=200;await patch({gizmo_id:'g-p-00000000000000000000000000000000'});assert.equal(events.length,0);
 await patch({gizmo_id:pid},'6ac1f341-b4b4-83ee-afa2-6726f7913e61');assert.equal(events.length,0);
 await patch({gizmo_id:pid,private:'never-export'});assert.deepEqual(events,[{conversationId:cid,projectId:pid}]);
 await patch({gizmo_id:pid});assert.equal(events.length,1);
});
test('a project-bound send fails closed when the native request lacks its project ID',async t=>{
 const page=new Window({url:'https://chatgpt.com/'});t.after(()=>page.close());page.fetch=async()=>new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});require('../dist/page-observer.cjs').installPageObserver(page);
 const events=[];page.addEventListener('localgpt:response-stream',e=>events.push(JSON.parse(e.detail)));
 page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm',{detail:JSON.stringify({requestId:'project-job',text:'owned',projectId:'g-p-6ac2076d66d081919fc3db8b4db4af71'})}));
 await page.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[{id:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',author:{role:'user'},content:{parts:['owned']}}]})});
 assert.equal(events[0]?.code,'project_mismatch');assert.equal(events.some(e=>e.kind==='stop'),false);
});
test('native conversation refresh clears stale project membership after moving out in another tab',async t=>{
 const page=new Window({url:'https://chatgpt.com/'});t.after(()=>page.close());let metadata={gizmo_id:null};page.fetch=async()=>new Response(JSON.stringify(metadata),{headers:{'content-type':'application/json'}});require('../dist/page-observer.cjs').installPageObserver(page);
 const cid='6ac1f341-b4b4-83ee-afa2-6726f7913e60',pid='g-p-6ac2076d66d081919fc3db8b4db4af71';const events=[];page.addEventListener('localgpt:conversation-project',e=>events.push(JSON.parse(e.detail)));
 const check=()=>page.dispatchEvent(new page.CustomEvent('localgpt:project-check',{detail:JSON.stringify({conversationId:cid,projectId:pid})}));
 await page.fetch(`/backend-api/conversation/${cid}`,{method:'PATCH',body:JSON.stringify({gizmo_id:pid})});await new Promise(r=>setTimeout(r,10));check();assert.equal(events.length,1);
 await page.fetch(`/backend-api/conversation/${cid}`);await new Promise(r=>setTimeout(r,20));check();assert.equal(events.length,1);
});

test('armed native stream accepts bounded text normalization and refuses different internal text',async t=>{
 for(const [armedText,outgoing,expected] of [['  Review\r\nthis\n','Review\nthis',true],['Review  this','Review this',false],['Review\u00a0this','Review this',false]]){
  const page=new Window({url:'https://chatgpt.com/'});t.after(()=>page.close());
  const user='f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversation='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
  const body='data: '+JSON.stringify({conversation_id:conversation,message:{id:'094c6dd5-45d0-4da3-bd50-a79ef778addb',author:{role:'assistant'},channel:'final',recipient:'all',content:{content_type:'text',parts:['Done']},status:'finished_successfully',end_turn:true}})+'\n\ndata: [DONE]\n\n';
  page.fetch=async()=>new Response(body,{headers:{'Content-Type':'text/event-stream'}});require('../dist/page-observer.cjs').installPageObserver(page);const events=[];
  page.addEventListener('localgpt:response-stream',e=>events.push(JSON.parse(e.detail)));page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm',{detail:JSON.stringify({requestId:'r',text:armedText,backgroundJob:true})}));
  const response=await page.fetch('/backend-api/f/conversation',{body:JSON.stringify({messages:[{id:user,author:{role:'user'},content:{parts:[outgoing]}}],conversation_id:conversation})});assert.equal(await response.text(),body);
  for(let i=0;i<30&&!events.some(e=>e.kind==='stop');i++)await new Promise(r=>setTimeout(r,5));assert.equal(events.some(e=>e.kind==='stop'),expected);
 }
});

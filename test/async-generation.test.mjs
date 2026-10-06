import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require=createRequire(import.meta.url);const {WebSocket}=require('ws');
const conversationId='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('async generation outlives the synchronous deadline and keeps partial text and slot on disconnect', async t=>{
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:60});const ports=await service.start();t.after(()=>service.close());
 const base=`http://127.0.0.1:${ports.httpPort}`;const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?browserId=long-running`);await once(ws,'open');const next=once(ws,'message');
 const response=await fetch(base+'/v1/response-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'Review'})});const job=await response.json();const request=JSON.parse((await next)[0]);
 assert.equal(request.backgroundJob,true);
 ws.send(JSON.stringify({type:'answer',requestId:request.requestId,text:'Partial answer'}));await pause(120);
 let current=await(await fetch(base+'/v1/response-jobs/'+job.id)).json();assert.equal(current.status,'in_progress');assert.equal((await(await fetch(base+'/health')).json()).busy,true);
 ws.close();await once(ws,'close');await pause(20);current=await(await fetch(base+'/v1/response-jobs/'+job.id)).json();assert.equal(current.status,'in_progress');assert.equal(current.phase,'unresponsive');assert.equal((await(await fetch(base+'/health')).json()).busy,true);
 const again=new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?browserId=long-running`);await once(again,'open');again.send(JSON.stringify({type:'answer',requestId:request.requestId,text:'Recovered answer'}));again.send(JSON.stringify({type:'stop',requestId:request.requestId,conversationId}));
 for(let i=0;i<100;i++){current=await(await fetch(base+'/v1/response-jobs/'+job.id)).json();if(current.status==='completed')break;await pause(5)}
 assert.equal(current.status,'completed');assert.equal(current.result.output[0].content[0].text,'Recovered answer');
});
test('background native observation ignores a short wall deadline and observes eventual completion',async()=>{
 const {observeConversationResponse}=await import('../src/conversation-stream.ts');let controller;const events=[];
 const response=new Response(new ReadableStream({start(c){controller=c}}),{headers:{'content-type':'text/event-stream'}});
 const observing=observeConversationResponse(response,{requestId:'long',messageId:conversationId,conversationId},e=>events.push(e),{backgroundJob:true,timeoutMs:20,idleTimeoutMs:10});
 await pause(50);assert.equal(events.some(e=>e.kind==='error'),false);
 controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({conversation_id:conversationId,message:{id:'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4',author:{role:'assistant'},channel:'final',content:{content_type:'text',parts:['Finished']},status:'finished_successfully',end_turn:true}})+'\n\ndata: [DONE]\n\n'));controller.close();await observing;assert.equal(events.at(-1).kind,'stop');
});
test('durable jobs preserve private answers and reserve unknown pending work across restart', async t=>{
 const {mkdtemp,rm,stat,readdir}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'localgpt-durable-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {createResponseJobStore}=await import('../src/response-jobs.ts');let now=1000;const store=createResponseJobStore({dir,now:()=>now,ttlMs:100});const pending=store.create(),done=store.create();store.answer(pending.id,'Partial');store.complete(done.id,{output:'Final'});store.flush();t.after(()=>store.close());
 const files=await readdir(dir);assert.equal(files.length,2);assert.equal((await stat(join(dir,files[0]))).mode&0o777,0o600);
 const restored=createResponseJobStore({dir,now:()=>now,ttlMs:100});assert.equal(restored.get(done.id).result.output,'Final');assert.equal(restored.get(pending.id).status,'in_progress');assert.equal(restored.get(pending.id).phase,'unresponsive');assert.equal(restored.text(pending.id),'Partial');assert.equal(restored.activeCount(),1);
 now+=101;assert.equal(restored.get(done.id),null);assert.equal((await readdir(dir)).length,1);assert.equal(restored.get(pending.id).status,'in_progress');
});
test('restarted service exposes terminal records and reserves a pending unknown browser slot',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'localgpt-service-jobs-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {createResponseJobStore}=await import('../src/response-jobs.ts');const stored=createResponseJobStore({dir});const pending=stored.create(),done=stored.create();stored.context(pending.id,{requestId:'r',browserId:'owner'});stored.answer(pending.id,'Partial result');stored.complete(done.id,{output:'Final'});stored.flush();t.after(()=>stored.close());
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:20,responseJobsDir:dir});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
 assert.equal((await(await fetch(base+'/health')).json()).busy,true);assert.equal((await(await fetch(base+'/v1/response-jobs/'+done.id)).json()).result.output,'Final');const current=await(await fetch(base+'/v1/response-jobs/'+pending.id)).json();assert.equal(current.status,'in_progress');assert.equal(current.phase,'unresponsive');assert.equal(current.context.browserId,'owner');
 const blocked=await fetch(base+'/v1/response-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'Do not duplicate'})});assert.equal(blocked.status,409);
});
test('native stream ambiguity preserves partial answer and service reservation without a duplicate dispatch',async t=>{
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:20});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');const next=once(ws,'message');const job=await(await fetch(base+'/v1/response-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'Wait'})})).json();const request=JSON.parse((await next)[0]);let sends=0;ws.on('message',()=>sends++);
 ws.send(JSON.stringify({type:'answer',requestId:request.requestId,text:'Partial'}));ws.send(JSON.stringify({type:'error',requestId:request.requestId,code:'response_stream_interrupted',message:'Connection lost'}));await pause(50);
 const state=await(await fetch(base+'/v1/response-jobs/'+job.id)).json();assert.equal(state.status,'in_progress');assert.equal(state.phase,'unresponsive');assert.equal((await(await fetch(base+'/health')).json()).busy,true);assert.equal(sends,0);
 const poll=await fetch(base+'/v1/response-jobs/'+job.id+'/events?wait_ms=10');const text=await poll.text();assert.match(text,/Partial/);assert.match(text,/wait_finished/);assert.equal((await(await fetch(base+'/health')).json()).busy,true);
 ws.send(JSON.stringify({type:'error',requestId:request.requestId,code:'chatgpt_generation_cancelled',message:'Native task cancelled'}));await pause(20);assert.equal((await(await fetch(base+'/v1/response-jobs/'+job.id)).json()).status,'failed');assert.equal((await(await fetch(base+'/health')).json()).busy,false);
});

test('durable terminal records omit echoed caller instructions while live results retain wire semantics',async t=>{
 const {mkdtemp,rm,readFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'localgpt-private-instructions-'));t.after(()=>rm(dir,{recursive:true,force:true}));const {createResponseJobStore}=await import('../src/response-jobs.ts');const store=createResponseJobStore({dir});const job=store.create();store.complete(job.id,{instructions:'private-instruction-sentinel',output:'Public answer'});assert.equal(store.get(job.id).result.instructions,'private-instruction-sentinel');assert.equal((await readFile(join(dir,job.id+'.json'),'utf8')).includes('private-instruction-sentinel'),false);
});

test('websocket observer events receive correlated acknowledgements only for admitted requests',async t=>{
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:100});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');const next=once(ws,'message');await fetch(base+'/v1/response-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'Observe'})});const request=JSON.parse((await next)[0]);
 const ack=once(ws,'message');ws.send(JSON.stringify({type:'answer',requestId:request.requestId,eventId:'event1',text:'Observed'}));const received=JSON.parse((await ack)[0]);assert.equal(received.type,'event_ack');assert.equal(received.requestId,request.requestId);assert.equal(received.eventId,'event1');assert.equal(received.accepted,true);
 const rejected=once(ws,'message');ws.send(JSON.stringify({type:'answer',requestId:'unadmitted',eventId:'event2',text:'Unknown'}));assert.equal(JSON.parse((await rejected)[0]).accepted,false);
});

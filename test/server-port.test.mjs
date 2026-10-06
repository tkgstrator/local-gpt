import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
const { createService } = await import(process.env.RUNTIME_SERVER_SOURCE || '../src/server.ts');
const cid='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
test('HTTP observations acknowledge accepted/rejected events and terminal replay after lane release',async t=>{
 const service=createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:50,bridgeToken:'fixture-token'});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
 const post=async(path,body)=>await(await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Browser-Id':'port-fixture','X-Bridge-Token':'fixture-token'},body:JSON.stringify(body)})).json();
 await post('/bridge/poll',{});const job=await post('/v1/response-jobs',{input:'Review'});const {request}=await post('/bridge/poll',{});assert.ok(request);
 const rejected=await post('/bridge/event',{type:'error',requestId:'unknown',code:'setup_browser_disconnected',message:'not sent'});assert.equal(rejected.accepted,false);
 assert.equal((await post('/bridge/event',{type:'answer',requestId:request.requestId,text:'Partial'})).accepted,true);
 const terminal={type:'error',requestId:request.requestId,code:'setup_browser_disconnected',message:'not sent'};assert.equal((await post('/bridge/event',terminal)).accepted,true);
 const saved=await(await fetch(base+'/v1/response-jobs/'+job.id)).json();assert.equal(saved.status,'failed');assert.equal((await post('/bridge/event',terminal)).accepted,true);
 assert.equal((await(await fetch(base+'/health')).json()).busy,false);
});
test('queued never-delivered HTTP job fails definitively when its polling lease expires',async t=>{
 const service=createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:50,pollingLeaseMs:100,bridgeToken:'fixture-token'});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
 const post=async(path,body)=>await(await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Browser-Id':'never-polled','X-Bridge-Token':'fixture-token'},body:JSON.stringify(body)})).json();await post('/bridge/poll',{});const job=await post('/v1/response-jobs',{input:'Review'});assert.ok(job.id);await new Promise(r=>setTimeout(r,180));
 const saved=await(await fetch(base+'/v1/response-jobs/'+job.id)).json();assert.equal(saved.status,'failed');assert.equal(saved.error.code,'browser_undelivered');assert.equal((await(await fetch(base+'/health')).json()).busy,false);
});

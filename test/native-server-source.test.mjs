import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createService } from '../src/server.ts';
import { createResponseJobStore } from '../src/response-jobs.ts';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';

async function fixture(t, options = {}) {
  const dir = options.responseJobsDir ?? mkdtempSync(join(tmpdir(), 'native-server-'));
  const service = createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:100,bridgeToken:'test',responseJobsDir:dir,imagesDir:join(dir,'images'),...options});
  const ports = await service.start();
  t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
  const base = `http://127.0.0.1:${ports.httpPort}`;
  const bridge = async (path, body={}, owner='owner') => {
    const res=await fetch(base+'/bridge/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'test','X-Browser-Id':owner},body:JSON.stringify(body)});
    return {status:res.status,...await res.json()};
  };
  const post = async(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const session = async()=> (await (await post('/v1/sessions',{projectName:null})).json()).id;
  const job = async(session_id)=>post('/v1/response-jobs',{input:'hello',session_id});
  if (!options.noInitialPoll) await bridge('poll');
  const ready = async () => {
    const probe=(await bridge('poll',{nativeProtocol:1})).request;
    assert.equal(probe.type,'native_readiness');
    assert.equal((await bridge('event',{type:'native_ready',requestId:probe.requestId,protocol:1,ready:true})).accepted,true);
  };
  return {base,bridge,post,session,job,dir,ready,ports};
}

test('native shared browser admits independent sessions and reserves same session',async t=>{
  const f=await fixture(t);
  await f.ready();
  const a=await f.session(), b=await f.session();
  assert.equal((await f.job(a)).status,202);
  const pa=(await f.bridge('poll')).request;
  assert.ok(pa.nativeUserMessageId);
  assert.equal((await f.job(a)).status,409);
  assert.equal((await f.job(b)).status,202);
  assert.notEqual((await f.bridge('poll')).request.requestId,pa.requestId);
});

test('ACK tombstone is browser-owner bound for legacy too',async t=>{
  const f=await fixture(t);
  const sid=await f.session();
  const response=await f.job(sid);assert.equal(response.status,202);
  const p=(await f.bridge('poll')).request;
  const event={type:'error',requestId:p.requestId,code:'editor_not_found',message:'no editor',eventId:'receipt'};
  assert.equal((await f.bridge('event',event)).accepted,true);
  assert.equal((await f.bridge('event',event,'foreign')).accepted,false);
});

test('native sync dispatch has durable intent and remains retrievable after timeout',async t=>{
 const f=await fixture(t);
 await f.ready();
 const sid=await f.session();
 const pending=f.post('/v1/responses',{input:'hello',session_id:sid});
 await new Promise(r=>setTimeout(r,20));
 const p=(await f.bridge('poll')).request;
 assert.ok(p.nativeUserMessageId);
 await f.bridge('event',{type:'native_intent',requestId:p.requestId,nativeUserMessageId:p.nativeUserMessageId});
 const response=await pending;
 assert.equal(response.status,504);
 const jobId=response.headers.get('X-Response-Job-Id');assert.ok(jobId);
 const job=await (await fetch(f.base+'/v1/response-jobs/'+jobId)).json();
 assert.equal(job.context.lifecycle,'possible_dispatch');
 assert.equal(job.context.nativeUserMessageId,p.nativeUserMessageId);
 assert.equal((await f.job(sid)).status,409);
 const other=await f.session();assert.equal((await f.job(other)).status,202);
});

test('native sessionless continuation refuses unresolved target before dispatch',async t=>{
 const f=await fixture(t);await f.ready();
 const response=await f.post('/v1/responses',{input:'hello',newChat:false});
 assert.equal(response.status,400);
 assert.equal((await f.bridge('poll')).request,null);
});

const cidA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cidB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('native identity cannot bypass the checked intent barrier',async t=>{
 const f=await fixture(t);await f.ready();const sid=await f.session(),A=await startNative(f,sid);
 assert.equal((await f.bridge('event',A.event({type:'native_identity',conversationId:cidA}))).accepted,false);
 assert.equal((await f.job(sid)).status,409);
});
test('native terminal cannot bind a CID before a checked identity receipt',async t=>{
 const f=await fixture(t);await f.ready();const sid=await f.session(),A=await startNative(f,sid);
 assert.equal((await f.bridge('event',A.event({type:'native_intent'}))).accepted,true);
 assert.equal((await f.bridge('event',A.event({type:'stop',conversationId:cidA,terminalEvidence:true}))).accepted,false);
 assert.equal((await f.job(sid)).status,409);
});
async function startNative(f, sid) {
 const res=await f.job(sid);assert.equal(res.status,202);const job=await res.json();
 const request=(await f.bridge('poll')).request;assert.ok(request.nativeUserMessageId);
 const event = value=>({...value,requestId:request.requestId,nativeUserMessageId:request.nativeUserMessageId});
 return {job,request,event};
}

test('native B completes before A; exact session bindings and durable owner tombstones survive',async t=>{
 const f=await fixture(t);await f.ready();const a=await f.session(),b=await f.session();
 const A=await startNative(f,a),B=await startNative(f,b);
 for(const [owned,cid] of [[A,cidA],[B,cidB]]) {
  assert.equal((await f.bridge('event',owned.event({type:'native_intent',eventId:'intent'}))).accepted,true);
  assert.equal((await f.bridge('event',owned.event({type:'native_identity',clientThreadId:'local-'+cid,conversationId:cid,eventId:'identity'}))).accepted,true);
 }
 const boundBeforeTerminal=(await (await fetch(f.base+'/v1/sessions')).json()).data;
 assert.equal(boundBeforeTerminal.find(s=>s.id===a).conversationId,cidA);
 assert.equal(boundBeforeTerminal.find(s=>s.id===b).conversationId,cidB);
 const answer=B.event({type:'answer',text:'B only',eventId:'b-answer'});
 assert.equal((await f.bridge('event',answer,'foreign')).accepted,false);
 await f.bridge('event',answer);
 const stop=B.event({type:'stop',conversationId:cidB,terminalEvidence:true,eventId:'b-stop'});
 assert.equal((await f.bridge('event',stop)).accepted,true);
 assert.equal((await f.bridge('event',stop)).accepted,true);
 assert.equal((await f.bridge('event',{...stop,conversationId:cidA})).accepted,false);
 assert.equal((await f.bridge('event',stop,'foreign')).accepted,false);
 assert.equal((await f.bridge('event',{...stop,eventId:'retry-after-lost-ack'})).accepted,true);
 assert.equal((await f.bridge('event',{...stop,eventId:'foreign-retry'},'foreign')).accepted,false);
 const bj=await (await fetch(f.base+'/v1/response-jobs/'+B.job.id)).json();
 assert.equal(bj.status,'completed');assert.equal(bj.result.output[0].content[0].text,'B only');
 assert.equal((await (await fetch(f.base+'/v1/response-jobs/'+A.job.id)).json()).status,'in_progress');
 await f.bridge('event',A.event({type:'answer',text:'A only'}));
 await f.bridge('event',A.event({type:'stop',conversationId:cidA,terminalEvidence:true}));
 const sessions=(await (await fetch(f.base+'/v1/sessions')).json()).data;
 assert.equal(sessions.find(s=>s.id===a).conversationId,cidA);assert.equal(sessions.find(s=>s.id===b).conversationId,cidB);
 const durable=JSON.parse(readFileSync(join(f.dir,B.job.id+'.json'),'utf8')).job;
 assert.equal(durable.context.lifecycle,'terminal');assert.equal(durable.context.serverConversationId,cidB);
});

test('native ambiguous errors and unproven stops retain selective reservations and block UI/reload',async t=>{
 const f=await fixture(t);await f.ready();const sid=await f.session();const A=await startNative(f,sid);
 await f.bridge('event',A.event({type:'native_intent'}));
 await f.bridge('event',A.event({type:'native_identity',conversationId:cidA}));
 assert.equal((await f.bridge('event',A.event({type:'error',code:'chatgpt_generation_failed',message:'callback failed'}))).accepted,true);
 assert.equal((await f.bridge('event',A.event({type:'error',code:'late-refusal',message:'not safe',preDispatch:true}))).accepted,true);
 assert.equal((await f.bridge('event',A.event({type:'stop',conversationId:cidA}))).accepted,false);
 assert.equal((await f.job(sid)).status,409);
 assert.equal((await f.post('/v1/sessions/delete',{session_id:sid})).status,409);
 assert.equal((await f.bridge('update-ready',{version:'1.0.0'})).ready,false);
 assert.equal((await f.job(await f.session())).status,202);
});

test('native intent/identity write failures deny ACK and retain identity until exact receipt replay',async t=>{
 const f=await fixture(t);await f.ready();const sid=await f.session();const A=await startNative(f,sid);
 rmSync(f.dir,{recursive:true,force:true});
 const intent=A.event({type:'native_intent',eventId:'intent'});
 assert.equal((await f.bridge('event',intent)).accepted,false);
 assert.equal((await f.job(sid)).status,409);
 mkdirSync(f.dir);
 assert.equal((await f.bridge('event',A.event({type:'native_identity',conversationId:cidA}))).accepted,false);
 assert.equal((await f.bridge('event',intent)).accepted,true);
 rmSync(f.dir,{recursive:true,force:true});
 const identity=A.event({type:'native_identity',conversationId:cidA,clientThreadId:'local-A',eventId:'identity'});
 assert.equal((await f.bridge('event',identity)).accepted,false);
 assert.equal((await f.job(sid)).status,409);
 mkdirSync(f.dir);
 assert.equal((await f.bridge('event',A.event({type:'stop',conversationId:cidA,terminalEvidence:true}))).accepted,false);
 assert.equal((await f.bridge('event',identity)).accepted,true);
 const durable=JSON.parse(readFileSync(join(f.dir,A.job.id+'.json'),'utf8')).job;
 assert.equal(durable.context.serverConversationId,cidA);assert.equal(durable.context.clientThreadId,'local-A');
});

test('native pre-dispatch refusal is terminal only before intent; foreign readiness never opens admission',async t=>{
 const f=await fixture(t);const probe=(await f.bridge('poll',{nativeProtocol:1})).request;
 assert.equal((await f.bridge('event',{type:'native_ready',requestId:probe.requestId,protocol:1,ready:true},'foreign')).accepted,false);
 assert.equal((await f.job(await f.session())).status,503);
 await f.bridge('event',{type:'native_ready',requestId:probe.requestId,protocol:1,ready:true});
 const sid=await f.session(),A=await startNative(f,sid);
 const refusal=A.event({type:'error',code:'native_model_unavailable',message:'No model',preDispatch:true,eventId:'refused'});
 assert.equal((await f.bridge('event',refusal)).accepted,true);
 assert.equal((await (await fetch(f.base+'/v1/response-jobs/'+A.job.id)).json()).status,'failed');
 assert.equal((await f.job(sid)).status,202);
});

test('restored native unknown is selectively reserved and reconciles owner receipts without redispatch',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'native-restore-'));const store=createResponseJobStore({dir});
 const context={requestId:'restored-request',browserId:'owner',mode:'native',lifecycle:'identified',nativeUserMessageId:'00000000-0000-4000-8000-000000000001',serverConversationId:cidA,conversationId:cidA};
 const saved=store.create(context);store.answer(saved.id,'Saved partial');store.close();
 const f=await fixture(t,{responseJobsDir:dir});await f.ready();
 assert.equal((await f.bridge('poll')).request,null);
 assert.equal((await f.job(await f.session())).status,202);
 const event={type:'answer',requestId:context.requestId,nativeUserMessageId:context.nativeUserMessageId,text:'Recovered exact branch',eventId:'recover'};
 assert.equal((await f.bridge('event',event,'foreign')).accepted,false);
 assert.equal((await f.bridge('event',event)).accepted,true);
 const stop={type:'stop',requestId:context.requestId,nativeUserMessageId:context.nativeUserMessageId,conversationId:cidA,terminalEvidence:true,eventId:'terminal'};
 assert.equal((await f.bridge('event',stop)).accepted,true);
 const done=await (await fetch(f.base+'/v1/response-jobs/'+saved.id)).json();
 assert.equal(done.status,'completed');assert.equal(done.result.output[0].content[0].text,'Recovered exact branch');
 assert.equal((await f.bridge('event',stop,'foreign')).accepted,false);
 assert.equal((await f.bridge('event',stop)).accepted,true);
});

test('legacy restored unknown remains globally reserved even when native readiness validates',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'legacy-restore-'));const store=createResponseJobStore({dir});
 const saved=store.create();store.context(saved.id,{requestId:'legacy',browserId:'owner'});store.close();
 const f=await fixture(t,{responseJobsDir:dir});await f.ready();
 assert.equal((await f.job(await f.session())).status,409);
 assert.equal((await f.post('/v1/responses',{input:'must not send'})).status,409);
 assert.equal((await f.bridge('poll')).request,null);
});

test('sync native timeout detaches delivery but exact later terminal result is retrievable',async t=>{
 const f=await fixture(t);await f.ready();const sid=await f.session();
 const responsePromise=f.post('/v1/responses',{input:'slow',session_id:sid});
 await new Promise(r=>setTimeout(r,20));const p=(await f.bridge('poll')).request;
 const event=value=>({...value,requestId:p.requestId,nativeUserMessageId:p.nativeUserMessageId});
 await f.bridge('event',event({type:'native_intent'}));
 await f.bridge('event',event({type:'native_identity',conversationId:cidA}));
 const response=await responsePromise;assert.equal(response.status,504);const jobId=response.headers.get('X-Response-Job-Id');
 await f.bridge('event',event({type:'answer',text:'Late exact answer'}));
 await f.bridge('event',event({type:'stop',conversationId:cidA,terminalEvidence:true}));
 const done=await (await fetch(f.base+'/v1/response-jobs/'+jobId)).json();
 assert.equal(done.status,'completed');assert.equal(done.result.output[0].content[0].text,'Late exact answer');
 assert.equal((await f.job(sid)).status,202);
});

test('native CID adoption is atomic across competing requests and rejects client-local IDs',async t=>{
 const f=await fixture(t);await f.ready();const a=await f.session(),b=await f.session();
 const A=await startNative(f,a),B=await startNative(f,b);
 await f.bridge('event',A.event({type:'native_intent'}));
 await f.bridge('event',B.event({type:'native_intent'}));
 const receiptA=A.event({type:'native_identity',conversationId:cidA,clientThreadId:'local-A',eventId:'A'});
 const receiptB=B.event({type:'native_identity',conversationId:cidA,clientThreadId:'local-B',eventId:'B'});
 const replies=await Promise.all([f.bridge('event',receiptA),f.bridge('event',receiptB)]);
 assert.equal(replies.filter(r=>r.accepted).length,1);
 assert.equal((await f.job(a)).status,409);assert.equal((await f.job(b)).status,409);
 const invalid=A.event({type:'native_identity',conversationId:'local-thread-not-server-id'});
 assert.equal((await f.bridge('event',invalid)).status,400);
 const sessions=(await (await fetch(f.base+'/v1/sessions')).json()).data;
 assert.equal(sessions.filter(s=>s.conversationId===cidA).length,1);
});

test('native WebSocket transport overlaps jobs and ACKs only the owning native identities',async t=>{
 const f=await fixture(t,{noInitialPoll:true});const messages=[];
 const ws=new WebSocket(`ws://127.0.0.1:${f.ports.wsPort}/?token=test&browserId=owner&nativeProtocol=1`);
 ws.on('message',raw=>messages.push(JSON.parse(raw)));
 t.after(()=>ws.close());await once(ws,'open');
 const until=async check=>{for(let i=0;i<100;i++){const value=check();if(value)return value;await new Promise(r=>setTimeout(r,5));}throw Error('No websocket message');};
 const probe=await until(()=>messages.find(m=>m.type==='native_readiness'));
 ws.send(JSON.stringify({type:'native_ready',requestId:probe.requestId,protocol:1,ready:true,eventId:'ready'}));
 assert.equal((await until(()=>messages.find(m=>m.eventId==='ready'))).accepted,true);
 const a=await f.session(),b=await f.session();
 const ja=await (await f.job(a)).json(),jb=await (await f.job(b)).json();
 const pa=await until(()=>messages.find(m=>m.type==='request'&&m.requestId===ja.context.requestId));
 const pb=await until(()=>messages.find(m=>m.type==='request'&&m.requestId===jb.context.requestId));
 assert.notEqual(pa.requestId,pb.requestId);
 ws.send(JSON.stringify({type:'native_intent',requestId:pb.requestId,nativeUserMessageId:pa.nativeUserMessageId,eventId:'wrong-native'}));
 assert.equal((await until(()=>messages.find(m=>m.eventId==='wrong-native'))).accepted,false);
 const event=value=>({...value,requestId:pb.requestId,nativeUserMessageId:pb.nativeUserMessageId});
 ws.send(JSON.stringify(event({type:'native_intent',eventId:'intent'})));
 assert.equal((await until(()=>messages.find(m=>m.eventId==='intent'))).accepted,true);
 ws.send(JSON.stringify(event({type:'native_identity',conversationId:cidB,eventId:'identity'})));
 assert.equal((await until(()=>messages.find(m=>m.eventId==='identity'))).accepted,true);
 ws.send(JSON.stringify(event({type:'answer',text:'Websocket B',eventId:'answer'})));
 ws.send(JSON.stringify(event({type:'stop',conversationId:cidB,terminalEvidence:true,eventId:'done'})));
 assert.equal((await until(()=>messages.find(m=>m.eventId==='done'))).accepted,true);
 const result=await (await fetch(f.base+'/v1/response-jobs/'+jb.id)).json();
 assert.equal(result.result.output[0].content[0].text,'Websocket B');
 assert.equal((await (await fetch(f.base+'/v1/response-jobs/'+ja.id)).json()).status,'in_progress');
});

test('all native requests refuse dispatch when initial durable intent cannot be written',async t=>{
 const f=await fixture(t);await f.ready();const sid=await f.session();
 rmSync(f.dir,{recursive:true,force:true});
 assert.equal((await f.post('/v1/responses',{input:'sync',session_id:sid})).status,503);
 assert.equal((await f.job(sid)).status,503);
 assert.equal((await f.bridge('poll')).request,null);
 mkdirSync(f.dir);
 assert.equal((await f.job(sid)).status,202);
});

test('native terminal write failure retains reservations and denies ACK until exact replay',async t=>{
 const f=await fixture(t);await f.ready();const sid=await f.session(),A=await startNative(f,sid);
 await f.bridge('event',A.event({type:'native_intent'}));
 await f.bridge('event',A.event({type:'native_identity',conversationId:cidA}));
 await f.bridge('event',A.event({type:'answer',text:'Durable final'}));
 const stop=A.event({type:'stop',conversationId:cidA,terminalEvidence:true,eventId:'stop'});
 rmSync(f.dir,{recursive:true,force:true});
 assert.equal((await f.bridge('event',stop)).accepted,false);
 assert.equal((await f.job(sid)).status,409);
 assert.equal((await (await fetch(f.base+'/v1/response-jobs/'+A.job.id)).json()).status,'in_progress');
 mkdirSync(f.dir);
 assert.equal((await f.bridge('event',stop)).accepted,true);
 assert.equal((await (await fetch(f.base+'/v1/response-jobs/'+A.job.id)).json()).status,'completed');
});

test('native images are saved durably before ACK and never cross independent request results',async t=>{
 const f=await fixture(t);await f.ready();const A=await startNative(f,await f.session()),B=await startNative(f,await f.session());
 const png={mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')};
 for(const [owned,cid,fileId] of [[A,cidA,'file_A'],[B,cidB,'file_B']]) {
  await f.bridge('event',owned.event({type:'native_intent'}));
  await f.bridge('event',owned.event({type:'native_identity',conversationId:cid}));
  assert.equal((await f.bridge('event',owned.event({type:'image',conversationId:cid,fileId,imageData:png,eventId:'image'}))).accepted,true);
  const durable=JSON.parse(readFileSync(join(f.dir,owned.job.id+'.json'),'utf8')).job;
  assert.equal(durable.context.images[0].fileId,fileId);
 }
 assert.equal((await f.bridge('event',A.event({type:'image',conversationId:cidB,fileId:'file_wrong',imageData:png}))).accepted,false);
 await f.bridge('event',B.event({type:'stop',conversationId:cidB,terminalEvidence:true}));
 const done=await (await fetch(f.base+'/v1/response-jobs/'+B.job.id)).json();
 assert.deepEqual(done.result.images.map(i=>i.fileId),['file_B']);
 assert.equal((await fetch(f.base+done.result.images[0].url)).status,200);
});

test('failed native image retrieval cannot produce a terminal result missing that image',async t=>{
 const f=await fixture(t,{imageFetcher:async()=>new Response('no',{status:403})});await f.ready();const A=await startNative(f,await f.session());
 await f.bridge('event',A.event({type:'native_intent'}));
 await f.bridge('event',A.event({type:'native_identity',conversationId:cidA}));
 const image=A.event({type:'image',conversationId:cidA,fileId:'file_retry',downloadUrl:'https://oaiusercontent.com/image.png',eventId:'image'});
 assert.equal((await f.bridge('event',image)).accepted,false);
 const stop=A.event({type:'stop',conversationId:cidA,terminalEvidence:true,eventId:'stop'});
 assert.equal((await f.bridge('event',stop)).accepted,false);
 assert.equal((await (await fetch(f.base+'/v1/response-jobs/'+A.job.id)).json()).status,'in_progress');
 assert.equal((await f.bridge('event',A.event({type:'image',conversationId:cidA,fileId:'file_retry',imageData:{mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')}}))).accepted,true);
 assert.equal((await f.bridge('event',stop)).accepted,true);
});

test('restored native ownership pins the shared browser before another browser connects',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'native-owner-'));const store=createResponseJobStore({dir});
 store.create({requestId:'owned',browserId:'original-owner',mode:'native',lifecycle:'possible_dispatch',nativeUserMessageId:'00000000-0000-4000-8000-000000000001'});store.close();
 const f=await fixture(t,{responseJobsDir:dir,noInitialPoll:true});
 const probe=(await f.bridge('poll',{nativeProtocol:1},'foreign')).request;
 await f.bridge('event',{type:'native_ready',requestId:probe.requestId,protocol:1,ready:true},'foreign');
 assert.equal((await f.job(await f.session())).status,409);
 assert.equal((await f.bridge('poll',{},'foreign')).request,null);
});

test('checked durable context reports write failure instead of dispatch permission', t=>{
 const dir=mkdtempSync(join(tmpdir(),'native-store-')); const store=createResponseJobStore({dir});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const job=store.create();rmSync(dir,{recursive:true,force:true});
 assert.throws(()=>store.contextChecked(job.id,{requestId:'r',browserId:'b',nativeUserMessageId:'00000000-0000-4000-8000-000000000001',lifecycle:'possible_dispatch'}), e=>e.code==='response_job_storage_unavailable');
});

test('native status and sequential read-only model/capability checks remain usable during generation',async t=>{
 const f=await fixture(t);await f.ready();const A=await startNative(f,await f.session());
 const health=await(await fetch(f.base+'/health')).json();
 assert.equal(health.nativeReady,true);assert.equal(health.activeGenerations,1);assert.equal(health.canStartIndependentGeneration,true);
 const pending=fetch(f.base+'/v1/models');await new Promise(r=>setTimeout(r,10));
 const request=(await f.bridge('poll')).request;assert.equal(request.type,'models');
 await f.bridge('event',{type:'models',requestId:request.requestId,models:['pro'],selected:'pro',selectionLabel:'Pro',source:'visible_ui'});
 assert.equal((await pending).status,200);
 const capabilities=fetch(f.base+'/v1/capabilities');await new Promise(r=>setTimeout(r,10));
 const capRequest=(await f.bridge('poll')).request;assert.equal(capRequest.type,'capabilities');
 const {emptyCapabilities}=await import('../src/capabilities.ts');
 await f.bridge('event',{type:'capabilities',requestId:capRequest.requestId,...emptyCapabilities()});
 assert.equal((await capabilities).status,200);
 assert.equal((await(await fetch(f.base+'/v1/response-jobs/'+A.job.id)).json()).status,'in_progress');
});

test('queued native requests expire as proven undelivered instead of permanent reservations',async t=>{
 const f=await fixture(t,{pollingLeaseMs:20});await f.ready();const sid=await f.session();const response=await f.job(sid);const job=await response.json()
 await new Promise(r=>setTimeout(r,80));
 const saved=await(await fetch(f.base+'/v1/response-jobs/'+job.id)).json();assert.equal(saved.status,'failed');assert.equal(saved.error.code,'native_dispatch_undelivered')
})
test('native dispatch refusal only releases the owned generation before SDK identity evidence',async t=>{
 const f=await fixture(t);await f.ready();const sid=await f.session();const A=await startNative(f,sid)
 await f.bridge('event',A.event({type:'native_intent'}))
 const event=A.event({type:'native_dispatch_refused',code:'native_journal_failed',message:'No SDK invocation'})
 assert.equal((await f.bridge('event',event,'foreign')).accepted,false)
 assert.equal((await f.bridge('event',event)).accepted,true)
 assert.equal((await(await fetch(f.base+'/v1/response-jobs/'+A.job.id)).json()).status,'failed')
 assert.equal((await f.job(sid)).status,202)
})

test('native rewritten streaming answer retains latest snapshot for terminal job recovery',async t=>{
 const f=await fixture(t,{timeoutMs:3000});await f.ready();const sid=await f.session()
 const pending=f.post('/v1/responses',{input:'hello',session_id:sid,stream:true});await new Promise(r=>setTimeout(r,10));const request=(await f.bridge('poll')).request
 const event=e=>({...e,requestId:request.requestId,nativeUserMessageId:request.nativeUserMessageId})
 await f.bridge('event',event({type:'native_intent'}));await f.bridge('event',event({type:'native_identity',conversationId:cidA}));await f.bridge('event',event({type:'answer',text:'Initial draft'}))
 const response=await pending,jobId=response.headers.get('X-Response-Job-Id'),reading=response.text()
 await f.bridge('event',event({type:'answer',text:'Corrected final'}));await f.bridge('event',event({type:'stop',conversationId:cidA,terminalEvidence:true}))
 assert.match(await reading,/answer_rewritten/);const saved=await(await fetch(f.base+'/v1/response-jobs/'+jobId)).json();assert.equal(saved.status,'completed');assert.equal(saved.result.output[0].content[0].text,'Corrected final')
})

test('native readiness can recover after boot contracts are initially unavailable',async t=>{
 const f=await fixture(t);const first=(await f.bridge('poll',{nativeProtocol:1})).request
 await f.bridge('event',{type:'native_ready',requestId:first.requestId,protocol:1,ready:false})
 assert.equal((await f.bridge('poll',{nativeProtocol:1})).request,null)
 await new Promise(r=>setTimeout(r,1100));const retry=(await f.bridge('poll',{nativeProtocol:1})).request
 assert.equal(retry?.type,'native_readiness');assert.notEqual(retry.requestId,first.requestId)
 await f.bridge('event',{type:'native_ready',requestId:retry.requestId,protocol:1,ready:true})
 assert.equal((await f.job(await f.session())).status,202)
})

test('lost readiness receipts expire without releasing generation ownership', async t => {
 const f=await fixture(t,{nativeReadinessTimeoutMs:25,pollingLeaseMs:5000});await f.ready()
 const sid=await f.session(),A=await startNative(f,sid)
 await f.bridge('event',A.event({type:'native_intent'}))
 // A fresh connection owns a probe whose response is lost.
 const first=(await f.bridge('poll',{nativeProtocol:1},'new-owner')).request
 await new Promise(r=>setTimeout(r,40))
 const retry=(await f.bridge('poll',{nativeProtocol:1},'new-owner')).request
 assert.equal(retry?.type,'native_readiness');assert.notEqual(retry.requestId,first.requestId)
 assert.equal((await f.bridge('event',{type:'native_ready',requestId:first.requestId,protocol:1,ready:true},'new-owner')).accepted,false)
 assert.equal((await f.bridge('event',{type:'native_ready',requestId:retry.requestId,protocol:1,ready:true},'new-owner')).accepted,true)
 assert.equal((await f.job(sid)).status,409)
 assert.equal((await (await fetch(f.base+'/v1/response-jobs/'+A.job.id)).json()).status,'in_progress')
})

test('WebSocket readiness retries a lost receipt and clears its probe on HTTP fallback', async t => {
 const f=await fixture(t,{noInitialPoll:true,nativeReadinessTimeoutMs:100,pollingLeaseMs:5000})
 const ws=new WebSocket(`ws://127.0.0.1:${f.ports.wsPort}/?token=test&browserId=owner&nativeProtocol=1`)
 t.after(()=>ws.close());const messages=[];let probes=0
 ws.on('message',raw=>{const message=JSON.parse(String(raw));messages.push(message)
  if(message.type==='native_readiness'&&++probes===2)ws.send(JSON.stringify({type:'native_ready',requestId:message.requestId,protocol:1,ready:true,eventId:'ready-retry'}))
 })
 const until=async check=>{for(let i=0;i<1000;i++){const value=check();if(value)return value;await new Promise(r=>setTimeout(r,5))}throw Error('No WebSocket receipt')}
 await once(ws,'open');assert.equal((await until(()=>messages.find(m=>m.eventId==='ready-retry'))).accepted,true)
 assert.ok(probes>=2)
 const sid=await f.session();const response=await f.job(sid);assert.equal(response.status,202)
 const job=await response.json()
 const request=await until(()=>messages.find(m=>m.type==='request'));assert.ok(request)
 ws.send(JSON.stringify({type:'native_intent',requestId:request.requestId,nativeUserMessageId:request.nativeUserMessageId,eventId:'owned-intent'}))
 assert.equal((await until(()=>messages.find(m=>m.eventId==='owned-intent'))).accepted,true)
 const closed=once(ws,'close');ws.close();await closed
 const fallback=(await f.bridge('poll',{nativeProtocol:1})).request
 assert.equal(fallback?.type,'native_readiness')
 assert.equal((await f.bridge('event',{type:'native_ready',requestId:fallback.requestId,protocol:1,ready:true})).accepted,true)
 assert.equal((await f.job(sid)).status,409)
 assert.equal((await (await fetch(f.base+'/v1/response-jobs/'+job.id)).json()).status,'in_progress')
})

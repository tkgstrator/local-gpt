import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

for (const mode of ['http', 'websocket']) test(`different sessions run sequentially across ${mode} tabs without mixing replies`, async t => {
  const service = require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:3000,bridgeToken:'parallel-test'});
  const ports = await service.start(); t.after(() => service.close()); const base=`http://127.0.0.1:${ports.httpPort}`;
  const create = async title => (await (await fetch(base+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,projectName:null})})).json()).id;
  const sessions = await Promise.all(['A','B'].map(create)); const received=new Map(), sockets=new Map();
  const bridge = async (id,path,body) => (await fetch(base+'/bridge/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'parallel-test','X-Browser-Id':id},body:JSON.stringify(body)})).json();
  for (const id of ['tab-a','tab-b']) {
    if (mode==='http') await bridge(id,'poll',{});
    else {
      const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?token=parallel-test&browserId=${id}`); await once(ws,'open');
      ws.on('message',raw=>received.set(id,JSON.parse(raw))); sockets.set(id,ws);
    }
  }
  const post = (session,input) => fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:session,input})});
  const next = async () => {
    for(let i=0;i<100;i++) {
      if(mode==='http') for(const id of ['tab-a','tab-b']) {const request=(await bridge(id,'poll',{})).request;if(request)received.set(id,request);}
      if(received.size) return [...received.entries()][0];
      await new Promise(r=>setTimeout(r,10));
    }
    throw Error('No request');
  };
  const send = async (id,event) => mode==='http' ? bridge(id,'event',event) : sockets.get(id).send(JSON.stringify(event));
  const first=post(sessions[0],'Topic A'); const [owner,a]=await next();
  const rejected=await post(sessions[1],'Topic B'); assert.equal(rejected.status,409); assert.equal((await rejected.json()).error.code,'browser_busy');
  const duplicate=await post(sessions[0],'Do not send twice'); assert.equal(duplicate.status,409); assert.equal((await duplicate.json()).error.code,'browser_busy');
  const health=await(await fetch(base+'/health')).json(); assert.equal(health.browsers,2); assert.equal(health.availableBrowsers,0); assert.equal(health.sharedBrowserId,owner); assert.equal(received.size,1);
  const wrongOwner=owner==='tab-a'?'tab-b':'tab-a';
  // Both answer and stop from another tab must leave the active request untouched.
  await send(wrongOwner,{type:'answer',requestId:a.requestId,text:'Wrong tab answer'});
  await send(wrongOwner,{type:'stop',requestId:a.requestId,conversationId:'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4'});
  await send(owner,{type:'answer',requestId:a.requestId,text:'Reply Topic A'});
  await send(owner,{type:'stop',requestId:a.requestId,conversationId:'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3'});
  assert.equal((await first).status,200); const firstBody=await (await first).json();
  assert.equal(firstBody.session_id,sessions[0]); assert.equal(firstBody.output[0].content[0].text,'Reply Topic A'); received.clear();
  assert.equal((await(await fetch(base+'/health')).json()).availableBrowsers,1);
  // Retry only the explicitly rejected request after the preceding job has completed.
  const second=post(sessions[1],'Topic B'); const [bOwner,b]=await next(); assert.equal(b.text,'Topic B');
  await send(bOwner,{type:'answer',requestId:b.requestId,text:'Reply Topic B'});
  await send(bOwner,{type:'stop',requestId:b.requestId,conversationId:'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4'});
  const secondResponse=await second; assert.equal(secondResponse.status,200); const secondBody=await secondResponse.json();
  assert.equal(secondBody.session_id,sessions[1]); assert.equal(secondBody.output[0].content[0].text,'Reply Topic B');
  const stored=await(await fetch(base+'/v1/sessions')).json();
  assert.equal(stored.data.find(s=>s.id===sessions[0]).conversationId,'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3');
  assert.equal(stored.data.find(s=>s.id===sessions[1]).conversationId,'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4');
});

for (const mode of ['http', 'websocket']) test(`all sessions keep sharing the selected ${mode} tab after an old owner reconnects`, async t => {
  const service = require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1500,pollingLeaseMs:100,bridgeToken:'shared-tab'});
  const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
  const bridge=async(id,path,body)=>(await fetch(base+'/bridge/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'shared-tab','X-Browser-Id':id},body:JSON.stringify(body)})).json();
  const sockets=new Map(),received=new Map();
  const connect=async id=>{if(mode==='http')await bridge(id,'poll',{});else{const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?token=shared-tab&browserId=${id}`);await once(ws,'open');ws.on('message',raw=>received.set(id,JSON.parse(raw)));sockets.set(id,ws);}};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const a=await(await post('/v1/sessions',{projectName:null})).json(),b=await(await post('/v1/sessions',{projectName:null})).json();
  const next=async ids=>{for(let i=0;i<100;i++){if(mode==='http')for(const id of ids){const r=(await bridge(id,'poll',{})).request;if(r)received.set(id,r);}if(received.size)return [...received.entries()][0];await new Promise(r=>setTimeout(r,5));}throw Error('No request');};
  const send=async(id,event)=>mode==='http'?bridge(id,'event',event):sockets.get(id).send(JSON.stringify(event));
  const finish=async(promise,ids,expected,cid)=>{const [owner,r]=await next(ids);await send(owner,{type:'answer',requestId:r.requestId,text:'Done'});await send(owner,{type:'stop',requestId:r.requestId,conversationId:cid});assert.equal((await promise).status,200);received.clear();assert.equal(owner,expected);};
  const cidA='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3',cidB='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4';
  await connect('tab-a');await finish(post('/v1/responses',{session_id:a.id,input:'Bind A'}),['tab-a'],'tab-a',cidA);
  if(mode==='http')await new Promise(r=>setTimeout(r,160));else{const closed=once(sockets.get('tab-a'),'close');sockets.get('tab-a').close();await closed;}
  await connect('tab-b');await finish(post('/v1/responses',{session_id:b.id,input:'Bind B'}),['tab-b'],'tab-b',cidB);
  await connect('tab-a');
  await finish(post('/v1/responses',{session_id:a.id,input:'Resume A'}),['tab-a','tab-b'],'tab-b',cidA);
  const models=fetch(base+'/v1/models');const [owner,r]=await next(['tab-a','tab-b']);await send(owner,{type:'error',requestId:r.requestId,code:'test_failure',message:'Done'});assert.equal((await models).status,502);assert.equal(owner,'tab-b');
  const health=await(await fetch(base+'/health')).json();assert.equal(health.sharedBrowserId,'tab-b');
});

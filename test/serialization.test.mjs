import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

for (const mode of ['http', 'websocket']) test(`all browser operations share one admission slot across ${mode} tabs`, async t => {
  const service = require('../dist/server.cjs').createService({host:'127.0.0.1', httpPort:0, wsPort:0, timeoutMs:3000, bridgeToken:'single-flight'});
  const ports = await service.start(); t.after(() => service.close());
  const base = `http://127.0.0.1:${ports.httpPort}`;
  const post = (path, body) => fetch(base + path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const create = async title => (await (await post('/v1/sessions', {title,projectName:null})).json()).id;
  const [a, b] = await Promise.all(['A', 'B'].map(create));
  const received = new Map(), sockets = new Map();
  const bridge = async (id, path, body) => (await fetch(base+'/bridge/'+path, {method:'POST', headers:{'Content-Type':'application/json','X-Bridge-Token':'single-flight','X-Browser-Id':id}, body:JSON.stringify(body)})).json();
  for (const id of ['tab-a', 'tab-b']) {
    if (mode === 'http') await bridge(id, 'poll', {});
    else {
      const ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?token=single-flight&browserId=${id}`);
      await once(ws, 'open'); ws.on('message', raw => received.set(id, JSON.parse(raw))); sockets.set(id, ws);
    }
  }
  const nextRequest = async () => {
    for (let i=0;i<100;i++) {
      if (mode === 'http') for (const id of ['tab-a','tab-b']) { const r=(await bridge(id,'poll',{})).request; if(r) received.set(id,r); }
      if(received.size) return [...received.entries()][0];
      await new Promise(r=>setTimeout(r,10));
    }
    throw Error('No admitted request');
  };
  const event = async (id, value) => mode === 'http' ? bridge(id,'event',value) : sockets.get(id).send(JSON.stringify(value));
  const health = async () => (await fetch(base+'/health')).json();
  assert.equal((await health()).availableBrowsers,1);
  // First bind a session, so deletion would require a browser interaction.
  const first = post('/v1/responses',{session_id:a,input:'Bind A'});
  const [owner, bind] = await nextRequest();
  const conversationId = '6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
  await event(owner,{type:'answer',requestId:bind.requestId,text:'Bound'});
  await event(owner,{type:'stop',requestId:bind.requestId,conversationId});
  assert.equal((await first).status,200); received.clear();
  // Capabilities reads must also hold the same slot as generation and deletion.
  const active = fetch(base+'/v1/capabilities');
  const [lane, request] = await nextRequest();
  assert.equal(request.type,'capabilities');
  const busy = await health(); assert.equal(busy.browsers,2); assert.equal(busy.busy,true); assert.equal(busy.availableBrowsers,0);
  for (const attempt of [
    () => post('/v1/responses',{session_id:b,input:'Do not switch chats'}),
    () => post('/v1/chat/completions',{messages:[{role:'user',content:'Do not send'}]}),
    () => fetch(base+'/v1/models'), () => fetch(base+'/v1/capabilities'),
    () => fetch(base+'/v1/dots'),
    () => post('/v1/sessions/delete',{session_id:a}),
  ]) {
    const response = await attempt(); assert.equal(response.status,409); assert.equal((await response.json()).error.code,'browser_busy');
  }
  assert.equal(received.size,1);
  // Session metadata reads/creates continue while a browser task runs.
  assert.equal((await fetch(base+'/v1/sessions')).status,200); assert.equal((await post('/v1/sessions',{title:'Metadata only'})).status,201);
  await event(lane,{type:'error',requestId:request.requestId,code:'test_failure',message:'Release slot'});
  assert.equal((await active).status,502); received.clear(); assert.equal((await health()).availableBrowsers,1);
  const resumed = post('/v1/responses',{session_id:a,input:'Resume A'});
  const [resumedOwner, resumedRequest] = await nextRequest(); assert.equal(resumedOwner,owner);
  const duplicate = await post('/v1/responses',{session_id:a,input:'Duplicate'}); assert.equal(duplicate.status,409); assert.equal((await duplicate.json()).error.code,'browser_busy');
  await event(owner,{type:'answer',requestId:resumedRequest.requestId,text:'Resumed'});
  await event(owner,{type:'stop',requestId:resumedRequest.requestId,conversationId});
  assert.equal((await resumed).status,200); assert.equal((await health()).busy,false);
});

test('navigation keeps the global slot while its owner disconnects, then timeout releases it', async t => {
  const service = require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:300});
  const ports = await service.start(); t.after(() => service.close());
  const base = `http://127.0.0.1:${ports.httpPort}`;
  const post = (path,body) => fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const session = await (await post('/v1/sessions',{projectName:null})).json();
  const connect = async id => { const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?browserId=${id}`); await once(ws,'open'); return ws; };
  const owner = await connect('owner'), spare = await connect('spare');
  const conversationId='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
  const initialMessage=once(owner,'message'); const initial=post('/v1/responses',{session_id:session.id,input:'Bind'});
  const request=JSON.parse((await initialMessage)[0]);
  owner.send(JSON.stringify({type:'answer',requestId:request.requestId,text:'Bound'}));
  owner.send(JSON.stringify({type:'stop',requestId:request.requestId,conversationId})); assert.equal((await initial).status,200);
  const next=once(owner,'message'); const active=post('/v1/responses',{session_id:session.id,input:'Resume'});
  const resumed=JSON.parse((await next)[0]); const ready=once(owner,'message');
  owner.send(JSON.stringify({type:'navigate',requestId:resumed.requestId,conversationId})); assert.equal(JSON.parse((await ready)[0]).type,'navigation_ready');
  const closed=once(owner,'close'); owner.close(); await closed;
  const health=await(await fetch(base+'/health')).json(); assert.equal(health.browsers,1); assert.equal(health.busy,true); assert.equal(health.availableBrowsers,0);
  const blocked=await fetch(base+'/v1/models'); assert.equal(blocked.status,409); assert.equal((await blocked.json()).error.code,'browser_busy');
  assert.equal((await active).status,504); assert.equal((await(await fetch(base+'/health')).json()).availableBrowsers,1);
  const spareRequest=once(spare,'message'); const models=fetch(base+'/v1/models'); const observed=JSON.parse((await spareRequest)[0]);
  spare.send(JSON.stringify({type:'error',requestId:observed.requestId,code:'test_failure',message:'Done'})); assert.equal((await models).status,502);
});

test('model, dot and bound deletion operations each block generation on other tabs', async t => {
  const service = require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1000,bridgeToken:'single-flight'});
  const ports=await service.start(); t.after(()=>service.close()); const base=`http://127.0.0.1:${ports.httpPort}`;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const bridge=async(id,path,body)=>(await fetch(base+'/bridge/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'single-flight','X-Browser-Id':id},body:JSON.stringify(body)})).json();
  await bridge('one','poll',{}); await bridge('two','poll',{});
  const session=await(await post('/v1/sessions',{projectName:null})).json();
  const waitRequest=async()=>{for(let i=0;i<100;i++){const r=(await bridge('one','poll',{})).request;if(r)return r;await new Promise(r=>setTimeout(r,5));}throw Error('No request');};
  const initial=post('/v1/responses',{input:'Bind',session_id:session.id}); const bind=await waitRequest();
  const conversationId='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
  await bridge('one','event',{type:'answer',requestId:bind.requestId,text:'Bound'}); await bridge('one','event',{type:'stop',requestId:bind.requestId,conversationId}); assert.equal((await initial).status,200);
  for (const [expected,start] of [
    ['models',()=>fetch(base+'/v1/models')],
    ['dots',()=>fetch(base+'/v1/dots')],
    ['delete_conversation',()=>post('/v1/sessions/delete',{session_id:session.id})],
  ]) {
    const active=start(), request=await waitRequest(); assert.equal(request.type,expected);
    const blocked=await post('/v1/responses',{input:'Other request',newChat:true}); assert.equal(blocked.status,409); assert.equal((await blocked.json()).error.code,'browser_busy');
    assert.equal((await bridge('two','poll',{})).request,null);
    await bridge('one','event',{type:'error',requestId:request.requestId,code:'test_failure',message:'Release slot'}); assert.equal((await active).status,502);
  }
});

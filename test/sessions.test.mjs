import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require=createRequire(import.meta.url);const {WebSocket}=require('ws');
const conversation='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
test('cleanup deletes only the requested session after the matching browser confirmation', async t => {
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1000});
 const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
 const create=async()=> (await(await fetch(base+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectName:null})})).json());
 const session=await create(); const retained=await create();
 const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');
 ws.on('message',raw=>{const r=JSON.parse(raw);ws.send(JSON.stringify({type:'stop',requestId:r.requestId,conversationId:conversation}));});
 await fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'Test',session_id:session.id})});
 ws.removeAllListeners('message');
 const remove=()=>fetch(base+'/v1/sessions/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:session.id})});
 ws.once('message',raw=>{const r=JSON.parse(raw);assert.equal(r.type,'delete_conversation');assert.equal(r.conversationId,conversation);ws.send(JSON.stringify({type:'conversation_deleted',requestId:r.requestId,conversationId:'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4'}));});
 assert.equal((await remove()).status,502);
 assert.equal((await(await fetch(base+'/v1/sessions')).json()).data.length,2);
 ws.once('message',raw=>{const r=JSON.parse(raw);ws.send(JSON.stringify({type:'conversation_deleted',requestId:r.requestId,conversationId:conversation}));});
 const result=await remove();assert.equal(result.status,200);assert.equal((await result.json()).conversationDeleted,true);
 assert.deepEqual((await(await fetch(base+'/v1/sessions')).json()).data.map(s=>s.id),[retained.id]);
 assert.equal((await remove()).status,404);
});

test('unused unbound sessions can be deleted without a connected browser',async t=>{
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1000});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
 const session=await(await fetch(base+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectName:null})})).json();
 const response=await fetch(base+'/v1/sessions/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:session.id})});
 assert.equal(response.status,200);assert.equal((await response.json()).conversationDeleted,false);
 assert.equal((await(await fetch(base+'/v1/sessions')).json()).data.length,0);
});

test('cleanup refuses a session with an in-flight generation',async t=>{
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1000});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
 const session=await(await fetch(base+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectName:null})})).json();
 const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');
 const next=once(ws,'message');const response=fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'Test',session_id:session.id})});
 const request=JSON.parse((await next)[0]);
 const deletion=await fetch(base+'/v1/sessions/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:session.id})});
 assert.equal(deletion.status,409);assert.equal((await deletion.json()).error.code,'browser_busy');
 ws.send(JSON.stringify({type:'stop',requestId:request.requestId,conversationId:conversation}));assert.equal((await response).status,200);
 assert.equal((await(await fetch(base+'/v1/sessions')).json()).data.length,1);
});
test('sessions persist metadata across restart without storing message text',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'localgpt-session-'));t.after(()=>rm(dir,{recursive:true,force:true}));const {createSessionStore}=require('../dist/sessions.cjs');let store=createSessionStore(join(dir,'sessions.sqlite'));const s=store.create({title:'Topic A',model:'model-a',reasoning:{effort:'standard'}});store.bind(s.id,conversation);store.close();store=createSessionStore(join(dir,'sessions.sqlite'));t.after(()=>store.close());assert.equal(store.get(s.id).conversationId,conversation);assert.equal(store.list()[0].effort,'standard');assert.throws(()=>store.bind(s.id,'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4'));assert.equal(store.get(s.id).text,undefined);
});
test('Responses session binds first conversation and reuses its ID on continuation',async t=>{
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1000});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
 const session=await (await fetch(base+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"title":"Topic A","projectName":null}'})).json();const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');let count=0;
 ws.on('message',raw=>{const r=JSON.parse(raw);assert.equal(r.type,'request');count++;assert.equal(r.newChat,count===1);assert.equal(r.conversationId,count===1?undefined:conversation);ws.send(JSON.stringify({type:'answer',requestId:r.requestId,text:'Reply '+count}));ws.send(JSON.stringify({type:'stop',requestId:r.requestId,conversationId:conversation}));});
 for(let i=0;i<2;i++){const res=await fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'Continue',session_id:session.id})});assert.equal(res.status,200);assert.equal((await res.json()).session_id,session.id);}
 const list=await (await fetch(base+'/v1/sessions')).json();assert.equal(list.data[0].conversationId,conversation);
 const missing=await fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'Continue',session_id:'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4'})});assert.equal(missing.status,404);
});
test('session resume survives browser navigation and WebSocket reconnection before generation',async t=>{
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:2000});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;const session=await(await fetch(base+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectName:null})})).json();
 let ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');ws.on('message',raw=>{const r=JSON.parse(raw);ws.send(JSON.stringify({type:'stop',requestId:r.requestId,conversationId:conversation}));});
 const post=()=>fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'Continue',session_id:session.id})});assert.equal((await post()).status,200);ws.removeAllListeners('message');
 ws.on('message',raw=>{const r=JSON.parse(raw);if(r.type==='request')ws.send(JSON.stringify({type:'navigate',requestId:r.requestId,conversationId:conversation}));else if(r.type==='navigation_ready')ws.close();});
 const reply=post();await once(ws,'close');ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);ws.on('message',raw=>{const r=JSON.parse(raw);assert.equal(r.conversationId,conversation);ws.send(JSON.stringify({type:'answer',requestId:r.requestId,text:'Resumed'}));ws.send(JSON.stringify({type:'stop',requestId:r.requestId,conversationId:conversation}));});
 const response=await reply;assert.equal(response.status,200);assert.equal((await response.json()).output[0].content[0].text,'Resumed');
});

test('session continuation survives HTTP page reload with the same browser identity', async t => {
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:2000,bridgeToken:'session-test'}); const ports=await service.start(); t.after(()=>service.close()); const base=`http://127.0.0.1:${ports.httpPort}`;
 const bridge=async(path,body)=> (await fetch(base+'/bridge/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'session-test','X-Browser-Id':'same-tab'},body:JSON.stringify(body)})).json();
 const session=await(await fetch(base+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({projectName:null})})).json(); await bridge('poll',{});
 const post=()=>fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'Continue',session_id:session.id})});
 const next=async()=>{ for(let i=0;i<50;i++){const r=(await bridge('poll',{})).request;if(r)return r;await new Promise(r=>setTimeout(r,10));}throw Error('No queued request');};
 let response=post();let r=await next();await bridge('event',{type:'stop',requestId:r.requestId,conversationId:conversation});assert.equal((await response).status,200);
 response=post();r=await next();await bridge('event',{type:'navigate',requestId:r.requestId,conversationId:conversation});const resumed=await next();assert.equal(resumed.requestId,r.requestId);assert.equal(resumed.conversationId,conversation);await bridge('event',{type:'answer',requestId:r.requestId,text:'HTTP resumed'});await bridge('event',{type:'stop',requestId:r.requestId,conversationId:conversation});assert.equal((await(await response).json()).output[0].content[0].text,'HTTP resumed');
});

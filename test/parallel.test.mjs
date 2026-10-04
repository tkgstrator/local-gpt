import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require=createRequire(import.meta.url);const {WebSocket}=require('ws');
for(const mode of ['http','websocket'])test(`different sessions generate concurrently on separate ${mode} tabs without mixing replies`,async t=>{
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:3000,bridgeToken:'parallel-test'});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
 const create=async title=>(await(await fetch(base+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})})).json()).id;
 const sessions=await Promise.all(['A','B'].map(create));const received=new Map();const sockets=[];
 const bridge=async(id,path,body)=>(await fetch(base+'/bridge/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'parallel-test','X-Browser-Id':id},body:JSON.stringify(body)})).json();
 for(const id of ['tab-a','tab-b'])if(mode==='http')await bridge(id,'poll',{});else{const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?token=parallel-test&browserId=${id}`);await once(ws,'open');ws.on('message',raw=>received.set(id,JSON.parse(raw)));sockets.push(ws);}
 const post=(session,input)=>fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:session,input})});
 const replies=[post(sessions[0],'Topic A'),post(sessions[1],'Topic B')];
 for(let i=0;i<100&&received.size<2;i++){if(mode==='http')for(const id of ['tab-a','tab-b']){const r=(await bridge(id,'poll',{})).request;if(r)received.set(id,r);}await new Promise(r=>setTimeout(r,10));}
 assert.equal(received.size,2);assert.deepEqual([...received.values()].map(r=>r.text).sort(),['Topic A','Topic B']);
 const health=await(await fetch(base+'/health')).json();assert.equal(health.browsers,2);assert.equal(health.availableBrowsers,0);
 const duplicate=await post(sessions[0],'Do not send twice');assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).error.code,'session_busy');
 const third=await create('C');assert.equal((await post(third,'No free tab')).status,409);
 // An answer from the wrong tab cannot complete the other session.
 const a=received.get('tab-a'),b=received.get('tab-b');const send=async(id,event)=>{if(mode==='http')await bridge(id,'event',event);else sockets[id==='tab-a'?0:1].send(JSON.stringify(event));};
 await send('tab-b',{type:'answer',requestId:a.requestId,text:'Wrong tab answer'});
 for(const [id,r,index] of [['tab-b',b,1],['tab-a',a,0]]){await send(id,{type:'answer',requestId:r.requestId,text:'Reply '+r.text});await send(id,{type:'stop',requestId:r.requestId,conversationId:`6ac07bb1-b2b4-43e8-8304-5424a5cf2ef${index+3}`});}
 for(let i=0;i<2;i++){const r=await replies[i];assert.equal(r.status,200);const body=await r.json();assert.equal(body.session_id,sessions[i]);assert.equal(body.output[0].content[0].text,'Reply Topic '+['A','B'][i]);}
});

import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
async function fixture(t, timeoutMs = 500) {
  const { createService } = require('../dist/server.cjs');
  const service = createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs});
  const ports = await service.start(); t.after(()=>service.close());
  const post = body => fetch(`http://127.0.0.1:${ports.httpPort}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}`); await once(ws,'open');
  return {post,ws};
}
test('Responses text and instructions produce a completed output message', async t => {
  const {post,ws}=await fixture(t);
  ws.on('message',raw=>{const r=JSON.parse(raw); assert.equal(r.text,'[developer]\nBe concise\n\n[user]\nHello'); ws.send(JSON.stringify({type:'answer',requestId:r.requestId,text:'Hello\nthere'})); ws.send(JSON.stringify({type:'stop',requestId:r.requestId}));});
  const res=await post({input:'Hello',instructions:'Be concise',store:false}); assert.equal(res.status,200);
  const body=await res.json(); assert.equal(body.object,'response'); assert.equal(body.status,'completed'); assert.equal(body.output[0].content[0].text,'Hello\nthere'); assert.equal(body.usage,null); assert.equal(body.store,false);
});
test('Responses accepts text message arrays',async t=>{
  const {post,ws}=await fixture(t); ws.on('message',raw=>{const r=JSON.parse(raw); assert.equal(r.text,'[user]\nOne\n\n[assistant]\nTwo\n\n[user]\nThree'); ws.send(JSON.stringify({type:'stop',requestId:r.requestId}));});
  assert.equal((await post({input:[{role:'user',content:[{type:'input_text',text:'One'}]},{role:'assistant',content:'Two'},{role:'user',content:'Three'}]})).status,200);
});
test('Responses rejects unsupported features and empty inputs before dispatch',async t=>{
  const {post}=await fixture(t);
  for(const body of [{input:' '},{input:[]},{input:'hello',tools:[]},{input:'hello',previous_response_id:'resp_x'},{input:'hello',store:true},{input:[{role:'user',content:[{type:'input_image',image_url:'x'}]}]}]) assert.equal((await post(body)).status,400);
});
test('Responses stream exposes deltas before generation finishes and ends with completed',async t=>{
  const {post,ws}=await fixture(t,3000); const incoming=once(ws,'message'); const res=await post({input:'Hello',stream:true});
  const [raw]=await incoming; const {requestId}=JSON.parse(raw); const reader=res.body.getReader(); const decoder=new TextDecoder(); let s='';
  ws.send(JSON.stringify({type:'answer',requestId,text:'Hi'}));
  while(!s.includes('response.output_text.delta')) s+=decoder.decode((await reader.read()).value);
  assert.match(s,/"delta":"Hi"/); assert.doesNotMatch(s,/response.completed/);
  ws.send(JSON.stringify({type:'answer',requestId,text:'Hi there'})); ws.send(JSON.stringify({type:'stop',requestId}));
  for(;;){const chunk=await reader.read();if(chunk.done)break;s+=decoder.decode(chunk.value);}
  const events=s.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
  assert.equal(events.filter(e=>e.type==='response.completed').length,1); assert.equal(events.filter(e=>e.type==='response.output_text.delta').map(e=>e.delta).join(''),'Hi there');
  // Official SDKs append content parts at their current array length.
  const added=events.find(e=>e.type==='response.output_item.added');
  const contentAdded=events.find(e=>e.type==='response.content_part.added');
  assert.deepEqual(added.item.content,[]);
  assert.equal(contentAdded.content_index,added.item.content.length);
  assert.equal(contentAdded.item_id,added.item.id);
  assert.deepEqual(events.map(e=>e.sequence_number),events.map((_,i)=>i)); assert.equal(events.at(-1).response.output[0].content[0].text,'Hi there');
});
test('Responses streaming failure is terminal and never completed',async t=>{
 const {post,ws}=await fixture(t); ws.on('message',raw=>{const {requestId}=JSON.parse(raw);ws.send(JSON.stringify({type:'answer',requestId,text:'partial'}));ws.send(JSON.stringify({type:'error',requestId,code:'dom_error',message:'Failed'}));});
 const res=await post({input:'hello',stream:true});const body=await res.text();assert.match(body,/event: response.failed/);assert.doesNotMatch(body,/event: response.completed/);assert.match(body,/dom_error/);
});
test('Responses streaming timeout emits failed',async t=>{const {post}=await fixture(t,40);const body=await(await post({input:'Hello',stream:true})).text();assert.match(body,/response.failed/);assert.match(body,/browser_timeout/);});
test('Responses stream rejects rewritten output',async t=>{const {post,ws}=await fixture(t);ws.on('message',raw=>{const {requestId}=JSON.parse(raw);for(const text of ['Hi','Changed'])ws.send(JSON.stringify({type:'answer',requestId,text}));});const body=await(await post({input:'hello',stream:true})).text();assert.match(body,/answer_rewritten/);assert.doesNotMatch(body,/event: response.completed/);});

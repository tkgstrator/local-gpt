import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createService } from '../src/server.ts';
import { installPageObserver } from '../src/page-observer.ts';
import { installNativeChat } from '../src/native-chat.ts';
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(read) { for (let i = 0; i < 300; i++) { const value = await read(); if (value) return value; await pause(20); } throw Error('Connected native fixture timed out'); }
const cidA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',cidB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('source bridge and observer connect one mocked native tab to two real server-owned requests', async t => {
  // The native core/store here is mocked. This verifies connected source wiring,
  // not the availability of these contracts in a real ChatGPT tab.
  const dir = mkdtempSync(join(process.cwd(), '.native-connected-test-'));
  const service = createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:10000,bridgeToken:'test',responseJobsDir:dir,imagesDir:join(dir,'images')});
  const ports = await service.start(), base = `http://127.0.0.1:${ports.httpPort}`;
  const page = new Window({url:'https://chatgpt.com/c/cccccccc-cccc-4ccc-8ccc-cccccccccccc'}), saved=new Map();
  for(const key of ['window','document','location','HTMLTextAreaElement','WebSocket','CustomEvent','sessionStorage','__BRIDGE_TOKEN__']) {saved.set(key,globalThis[key]);globalThis[key]=key==='window'?page:key==='__BRIDGE_TOKEN__'?'test':page[key];}
  t.after(async()=>{page.dispatchEvent(new page.Event('pagehide'));await page.happyDOM.abort();page.close();for(const [key,value] of saved)globalThis[key]=value;await service.close();rmSync(dir,{recursive:true,force:true});});
  page.document.body.innerHTML='<form><div role="textbox" contenteditable="true">Manual draft</div><button aria-label="Send">Send</button></form>';
  let clicks=0;page.document.querySelector('button').onclick=()=>clicks++;
  const producers=new Map(),calls=[];
  page.fetch=async(_input,init)=>new Response(new ReadableStream({start(controller){producers.set(JSON.parse(init.body).messages[0].id,controller);}}),{headers:{'content-type':'text/event-stream'}});
  installPageObserver(page);
  const scope={};
  installNativeChat(page,async()=>({scope,models:{versionOptions:[{id:'v',slugs:['pro'],options:[{slug:'pro',thinkingEffort:'high',isAvailable:true}]}]},selected:{slug:'pro',thinkingEffort:'high',versionId:'v'},projectRows:[],upload:async()=>{throw Error('not used')},
    build:text=>({extraDeveloperInstructionMessages:[],message:{id:crypto.randomUUID(),author:{role:'user'},content:{content_type:'text',parts:[text]},metadata:{}}}),
    submit:async(received,options)=>{
      assert.equal(received,scope);const cid=calls.length?cidB:cidA;calls.push({options,cid});
      options.onClientThreadIdChange('local-'+cid);
      await page.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({messages:[options.userCompletionMessages.message]})});
      options.onServerThreadIdChange(cid);
    },
  }));
  let ready=false, lostIntentAck=false;
  const intents=[];
  const { startBrowserApp } = await import('../src/browser-app.ts');
  startBrowserApp(async(path,data,browserId)=>{
    const response=await fetch(base+'/bridge/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'test','X-Browser-Id':browserId},body:JSON.stringify(data)});
    const result=await response.json();
    if(data.type==='native_intent') {
      intents.push(data);
      if(!lostIntentAck&&result.accepted===true) {
        lostIntentAck=true;
        assert.equal(calls.length,0);
        throw Error('Simulated lost ACK after durable intent storage');
      }
    }
    if(data.type==='native_ready'&&data.ready&&result.accepted)ready=true;
    return result;
  });
  await until(()=>ready);
  const post=async(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const session=async()=> (await (await post('/v1/sessions',{projectName:null})).json()).id;
  const a=await session(),b=await session();
  const A=await (await post('/v1/response-jobs',{input:'same prompt',session_id:a})).json();
  await until(()=>calls.length===1);
  assert.equal(lostIntentAck,true);
  assert.equal(intents.length,2);
  assert.deepEqual(intents[0],intents[1]);
  const B=await (await post('/v1/response-jobs',{input:'same prompt',session_id:b})).json();
  await until(()=>calls.length===2);
  assert.notEqual(calls[0].options.userCompletionMessages.message.id,calls[1].options.userCompletionMessages.message.id);
  const finish=(call,text)=>{const controller=producers.get(call.options.userCompletionMessages.message.id);controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({conversation_id:call.cid,message:{id:crypto.randomUUID(),author:{role:'assistant'},channel:'final',recipient:'all',status:'finished_successfully',end_turn:true,content:{content_type:'text',parts:[text]}}})}\n\ndata: [DONE]\n\n`));controller.close();};
  const read=async id=>(await fetch(base+'/v1/response-jobs/'+id)).json();
  finish(calls[1],'B exact');await until(async()=> (await read(B.id)).status==='completed');
  assert.equal((await read(A.id)).status,'in_progress');
  finish(calls[0],'A exact');await until(async()=> (await read(A.id)).status==='completed');
  assert.equal((await read(A.id)).result.output[0].content[0].text,'A exact');assert.equal((await read(B.id)).result.output[0].content[0].text,'B exact');
  const sessions=(await (await fetch(base+'/v1/sessions')).json()).data;
  assert.equal(sessions.find(s=>s.id===a).conversationId,cidA);assert.equal(sessions.find(s=>s.id===b).conversationId,cidB);
  assert.equal(clicks,0);assert.equal(page.document.querySelector('[role="textbox"]').textContent,'Manual draft');
});

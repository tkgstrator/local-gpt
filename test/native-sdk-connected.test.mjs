import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.ts';
import { installNativeChat } from '../src/native-chat.ts';
import { installPageObserver } from '../src/page-observer.ts';
const cidA='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3', cidB='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(read){for(let i=0;i<300;i++){const v=await read();if(v)return v;await pause(20)}throw Error('connected recovery timed out')}
function graph(cid,user,text){const id=crypto.randomUUID();return {conversation_id:cid,current_node:user,private:'raw-graph-secret',mapping:{
 [user]:{id:user,parent:null,message:{id:user,author:{role:'user'}}},
 [id]:{id,parent:user,message:{id,author:{role:'assistant'},channel:'final',recipient:'all',status:'finished_successfully',end_turn:true,content:{content_type:'text',parts:[text]}}}
}}}
test('SDK recovery crosses observer/browser/server with independent A/B jobs and B continuation', {timeout:15000}, async t=>{
 const dir=mkdtempSync(join(tmpdir(),'localgpt-sdk-connected-'));
 const service=createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:10000,bridgeToken:'test-token',responseJobsDir:dir,imagesDir:join(dir,'images')});
 const {httpPort}=await service.start(); const base=`http://127.0.0.1:${httpPort}`;
 const page=new Window({url:'https://chatgpt.com/'}), saved=new Map();
 for(const key of ['window','document','location','HTMLTextAreaElement','WebSocket','CustomEvent','sessionStorage','__BRIDGE_TOKEN__']){saved.set(key,globalThis[key]);globalThis[key]=key==='window'?page:key==='__BRIDGE_TOKEN__'?'test-token':page[key]}
 t.after(async()=>{page.dispatchEvent(new page.Event('pagehide'));await pause(10);await page.happyDOM.abort();page.close();for(const [key,value]of saved)globalThis[key]=value;await service.close();rmSync(dir,{recursive:true,force:true})});
 page.document.body.innerHTML='<div role="textbox" contenteditable="true">manual draft</div>';
 globalThis.WebSocket=class{constructor(){throw Error('HTTP test transport')}};
 const events=[],snapshots=new Map(),submits=[],reads=[],disarms=[];
 page.addEventListener('localgpt:stream-disarm',event=>disarms.push(event.detail));
 page.fetch=async(_input,init)=>{assert.equal(init.method,'POST');return new Response('data: {\n\n',{headers:{'content-type':'text/event-stream'}})};
 const contract={scope:{},projectRows:[],models:{versionOptions:[{id:'v',slugs:['pro'],options:[{slug:'pro',isAvailable:true}]}]},selected:{slug:'pro',thinkingEffort:null,versionId:'v'},upload:async()=>{},
 build:text=>({extraDeveloperInstructionMessages:[],message:{id:crypto.randomUUID(),author:{role:'user'},content:{content_type:'text',parts:[text]},metadata:{}}}),
 prepareExistingConversation:async cid=>({conversationId:cid,parentMessageId:submits.find(s=>s.cid===cid).user}),
 readConversationSnapshot:async cid=>{reads.push(cid);return snapshots.get(cid)},
 submit:(_scope,o)=>{const user=o.userCompletionMessages.message.id,cid=o.conversationId??(submits.length===0?cidA:cidB);submits.push({cid,user});snapshots.set(cid,graph(cid,user,`final ${submits.length}`));void page.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({...(o.conversationId?{conversation_id:cid}:{}),messages:[o.userCompletionMessages.message]})});o.onServerThreadIdChange(cid);return new Promise(()=>{})}
 };
 const native=installNativeChat(page,async()=>contract);installPageObserver(page,native);
 const {startBrowserApp}=await import('../src/browser-app.ts');
 startBrowserApp(async(path,data)=>{if(path==='event')events.push(data);const r=await fetch(base+'/bridge/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'test-token','X-Browser-Id':'sdk-browser'},body:JSON.stringify(data)});return r.json()});
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json()};
 await wait(()=>events.some(e=>e.type==='native_ready'&&e.ready));
 const sA=await post('/v1/sessions',{projectName:null}),sB=await post('/v1/sessions',{projectName:null});
 const jA=await post('/v1/response-jobs',{input:'same',session_id:sA.id}),jB=await post('/v1/response-jobs',{input:'same',session_id:sB.id});
 const completed=async id=>{const j=await(await fetch(base+'/v1/response-jobs/'+id)).json();return j.status==='completed'?j:null};
 let rA,rB;
 try {rA=await wait(()=>completed(jA.id));rB=await wait(()=>completed(jB.id))} catch(error){throw Error(error.message+' '+JSON.stringify({events,submits,reads,jA,jB}))}
 assert.equal(rA.context.conversationId,cidA);assert.equal(rB.context.conversationId,cidB);
 const jB2=await post('/v1/response-jobs',{input:'continue',session_id:sB.id});await wait(()=>completed(jB2.id));
 assert.deepEqual(submits.map(s=>s.cid),[cidA,cidB,cidB]);assert.deepEqual(reads,[cidA,cidB,cidB]);
 await wait(()=>disarms.length===3);
 const owned=events.find(e=>e.type==='native_intent');
 await assert.rejects(native.readConversationSnapshot(owned.requestId,owned.nativeUserMessageId,cidA),/not_owned/);
 assert.equal(JSON.stringify(events).includes('raw-graph-secret'),false);
 assert.equal(page.document.querySelector('[role="textbox"]').textContent,'manual draft');
});

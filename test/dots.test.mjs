import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
const require=createRequire(import.meta.url);
const dot={id:'account~dot-a',name:'Dot A',threadId:'01a0f5a6-b92e-7717-80f2-6b889e0c102d',paused:false};
test('dots normalization supports multiple dots and excludes ordinary agents and private fields',()=>{
 const {normalizeDots}=require('../dist/dots.cjs');const item={id:dot.id,display_name:dot.name,active_root_thread_id:dot.threadId,aeon_kind:'orbit',is_paused:false,description:'private'};
 const result=normalizeDots({items:[item,{...item,id:'dot-b',display_name:'Dot B'},{...item,id:'worker',aeon_kind:'task'}],cursor:'next'});
 assert.deepEqual(result.dots.map(d=>d.name),['Dot A','Dot B']);assert.equal(result.cursor,'next');assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(normalizeDots({items:[]}),null);
});
test('dot messages distinguish outgoing messages and return text without action labels',()=>{
 const {dotMessages}=require('../dist/dots.cjs');const page=new Window();page.document.body.innerHTML='<textarea id="unrelated">unrelated manual draft</textarea><main class="thread-pane"><article class="message-row self" data-message-id="u1"><div class="message-text">Hello</div></article><article class="message-row" data-message-id="a1"><div class="message-text">Reply</div><button>Reply action</button></article></main>';
 assert.deepEqual(dotMessages(page.document),[{id:'u1',role:'user',text:'Hello'},{id:'a1',role:'dot',text:'Reply'}]);page.close();
});
test('dots REST carries list/select/send/read operations and rejects malformed messages',async t=>{
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1000});const ports=await service.start();t.after(()=>service.close());const {WebSocket}=require('ws');const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');
 ws.on('message',raw=>{const r=JSON.parse(raw);assert.equal(r.type,'dots');const op=r.operation;let result;
 if(op.action==='list')result={action:'list',dots:[dot],cursor:null,source:'chatgpt_api',selected:dot.id};
 if(op.action==='select')result={action:'select',dot,status:'selected'};
 if(op.action==='send')result={action:'send',dotId:dot.id,messageId:'outgoing1',status:'sent'};
 if(op.action==='messages')result={action:'messages',dotId:dot.id,messages:[{id:'answer1',role:'dot',text:'Dot reply'}],source:'visible_ui',scope:'rendered_messages',complete:false};
 ws.send(JSON.stringify({type:'dots',requestId:r.requestId,result}));});
 const base=`http://127.0.0.1:${ports.httpPort}`;assert.equal((await (await fetch(base+'/v1/dots')).json()).dots[0].id,dot.id);
 for(const [path,body] of [['select',{dotId:dot.id}],['messages',{dotId:dot.id,text:'Hello'}]])assert.equal((await fetch(base+'/v1/dots/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,200);
 assert.equal((await (await fetch(base+'/v1/dots/messages?dotId='+dot.id+'&afterMessageId=outgoing1')).json()).messages[0].text,'Dot reply');
 assert.equal((await fetch(base+'/v1/dots/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dotId:dot.id,text:' '})})).status,400);
});
test('built extension sends only to selected dot, preserves drafts and reads replies after outgoing cursor',async t=>{
 const page=new Window({url:`https://chatgpt.com/dots/${dot.threadId}`});t.after(async()=>{page.dispatchEvent(new page.Event('pagehide'));await page.happyDOM.abort();page.close();});
 page.document.body.innerHTML='<textarea id="unrelated">unrelated manual draft</textarea><main class="thread-pane"><article class="message-row" data-message-id="old"><div class="message-text">Old private message</div></article><div contenteditable="true" role="textbox" aria-label="Message"></div><button aria-label="Send">Send</button></main>';
 await page.happyDOM.waitUntilComplete();let queued=null;const events=[];page.chrome={runtime:{sendMessage:async r=>{if(r.path==='poll'){const request=queued;queued=null;return {ok:true,data:{request}};}events.push(r.data);return {ok:true,data:{ok:true}};}}};
 const globals=['chrome','window','document','location','HTMLTextAreaElement','WebSocket','CustomEvent','crypto','setTimeout','clearTimeout'];
 new Function(...globals,await readFile('dist/extension/content.js','utf8'))(...globals.map(k=>k==='window'?page:['setTimeout','clearTimeout'].includes(k)?page[k].bind(page):page[k]));
 page.dispatchEvent(new page.CustomEvent('localgpt:dots',{detail:JSON.stringify({dots:[dot],cursor:null,source:'chatgpt_api',selected:null})}));
 const request=async(operation,id)=>{queued={type:'dots',requestId:id,operation};for(let i=0;i<100;i++){const event=events.find(e=>e.requestId===id);if(event)return event;await new Promise(r=>setTimeout(r,20));}throw Error('No event');};
 const editor=page.document.querySelector('[contenteditable]');editor.textContent='manual draft';const refused=await request({action:'send',dotId:dot.id,text:'new text'},'draft');assert.equal(refused.code,'composer_not_empty');assert.equal(editor.textContent,'manual draft');editor.textContent='';
 page.document.querySelector('button').addEventListener('click',()=>{const text=editor.textContent;editor.textContent='';page.document.querySelector('main').insertAdjacentHTML('beforeend',`<article class="message-row self" data-message-id="sent1"><div class="message-text"></div></article>`);page.document.querySelector('[data-message-id="sent1"] .message-text').textContent=text;});
 const sent=await request({action:'send',dotId:dot.id,text:'Hello'},'send');assert.equal(sent.result.messageId,'sent1');assert.equal(page.document.querySelector('#unrelated').value,'unrelated manual draft');
 page.document.querySelector('main').insertAdjacentHTML('beforeend','<article class="message-row" data-message-id="reply1"><div class="message-text">New reply</div></article>');
 const read=await request({action:'messages',dotId:dot.id,afterMessageId:'sent1',limit:20},'read');assert.deepEqual(read.result.messages,[{id:'reply1',role:'dot',text:'New reply'}]);
 const missing=await request({action:'messages',dotId:dot.id,afterMessageId:'missing',limit:20},'cursor');assert.equal(missing.code,'message_cursor_not_visible');
 const sendButton=page.document.querySelector('button');sendButton.disabled=true;queued={type:'dots',requestId:'moved',operation:{action:'send',dotId:dot.id,text:'Do not send elsewhere'}};for(let i=0;i<100&&!editor.textContent;i++)await new Promise(r=>setTimeout(r,20));page.history.pushState({},'', '/dots/01a0f5a6-b92e-7717-80f2-6b889e0c102e');sendButton.disabled=false;for(let i=0;i<100&&!events.find(e=>e.requestId==='moved');i++)await new Promise(r=>setTimeout(r,20));assert.equal(events.find(e=>e.requestId==='moved').code,'conversation_changed');page.history.pushState({},'', `/dots/${dot.threadId}`);editor.textContent='';
 const wrong=await request({action:'send',dotId:'unknown',text:'Hello'},'wrong');assert.equal(wrong.code,'dot_not_found');
});

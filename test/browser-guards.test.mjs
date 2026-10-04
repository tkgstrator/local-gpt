import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readFile } from 'node:fs/promises';
const target='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
async function fixture(t, url='https://chatgpt.com/') {
 const page=new Window({url});t.after(async()=>{page.dispatchEvent(new page.Event('pagehide'));await page.happyDOM.abort();page.close();});
 page.document.body.innerHTML='<div role="textbox" contenteditable="true"></div><button aria-label="Send">Send</button>';await page.happyDOM.waitUntilComplete();
 let queued=null;const events=[];let polls=0;let holdNavigation;const navigationStarted=new Promise(resolve=>holdNavigation=resolve);let releaseNavigation;const navigationGate=new Promise(resolve=>releaseNavigation=resolve);
 page.chrome={runtime:{sendMessage:async r=>{if(r.path==='poll'){polls++;const request=queued;queued=null;return {ok:true,data:{request}};}events.push(r.data);if(r.data.type==='navigate'){holdNavigation();await navigationGate;}return {ok:true,data:{ok:true}};}}};
 const globals=['chrome','window','document','location','HTMLTextAreaElement','WebSocket','CustomEvent','crypto','sessionStorage','setTimeout','clearTimeout'];new Function(...globals,await readFile('dist/extension/content.js','utf8'))(...globals.map(k=>k==='window'?page:['setTimeout','clearTimeout'].includes(k)?page[k].bind(page):page[k]));
 return {page,events,queue:r=>queued=r,polls:()=>polls,navigationStarted,releaseNavigation,async event(id){for(let i=0;i<150;i++){const e=events.find(e=>e.requestId===id&&e.type==='error');if(e)return e;await new Promise(r=>setTimeout(r,20));}throw Error('No error event');}};
}
test('built extension refuses session navigation while a manual generation is active',async t=>{
 const f=await fixture(t);f.page.document.body.insertAdjacentHTML('beforeend','<button data-testid="stop-button">Stop</button>');f.queue({type:'request',requestId:'busy',text:'Continue',newChat:false,conversationId:target});assert.equal((await f.event('busy')).code,'browser_busy');assert.equal(f.page.location.pathname,'/');assert.equal(f.events.some(e=>e.type==='navigate'),false);
});
test('old HTTP page stops polling while session navigation acknowledgement is delayed',async t=>{
 const f=await fixture(t);f.queue({type:'request',requestId:'navigate',text:'Continue',newChat:false,conversationId:target});await f.navigationStarted;const before=f.polls();await new Promise(r=>setTimeout(r,1600));assert.equal(f.polls(),before);f.releaseNavigation();
});
test('built extension refuses unrelated conversation answers after sending from home',async t=>{
 const f=await fixture(t);f.page.document.querySelector('button').addEventListener('click',()=>{f.page.history.pushState({},'',`/c/${target}`);f.page.document.body.insertAdjacentHTML('beforeend','<div data-message-author-role="user">Different question</div><div data-message-author-role="assistant">Private unrelated reply</div>');});f.queue({type:'request',requestId:'changed',text:'Our question',newChat:false});assert.equal((await f.event('changed')).code,'conversation_changed');assert.equal(f.events.some(e=>e.type==='answer'),false);
});

test('same text in an existing one-turn conversation cannot establish a new session binding',async t=>{
 const f=await fixture(t);f.page.document.querySelector('button').addEventListener('click',()=>{setTimeout(()=>{f.page.history.pushState({},'',`/c/${target}`);f.page.document.body.insertAdjacentHTML('beforeend','<div data-message-author-role="user">Our question</div><div data-message-author-role="assistant">Old unrelated answer</div>');},30);});f.queue({type:'request',requestId:'same-text',text:'Our question',newChat:false});assert.equal((await f.event('same-text')).code,'conversation_changed');assert.equal(f.events.some(e=>e.type==='answer'),false);
});
test('new session follows its captured submitted turn from home to its new conversation',async t=>{
 const f=await fixture(t);f.page.document.querySelector('button').addEventListener('click',()=>{f.page.document.body.insertAdjacentHTML('beforeend','<div data-message-author-role="user">Our question</div>');f.page.history.pushState({},'',`/c/${target}`);f.page.document.body.insertAdjacentHTML('beforeend','<div data-message-author-role="assistant">Our new answer</div>');});f.queue({type:'request',requestId:'new-session',text:'Our question',newChat:true});let stop;for(let i=0;i<200;i++){stop=f.events.find(e=>e.requestId==='new-session'&&e.type==='stop');if(stop)break;await new Promise(r=>setTimeout(r,20));}assert.equal(stop?.conversationId,target);assert.equal(f.events.find(e=>e.type==='answer')?.text,'Our new answer');assert.equal(f.events.some(e=>e.type==='error'),false);
});

test('manual attachments block requests without API files before session navigation',async t=>{
 const f=await fixture(t); const editor=f.page.document.querySelector('[role="textbox"]'); const form=f.page.document.createElement('form');editor.replaceWith(form);form.append(editor);form.insertAdjacentHTML('beforeend','<button aria-label="Remove manual.txt">Remove</button>');
 f.queue({type:'request',requestId:'manual-file',text:'Continue',newChat:false,conversationId:target});assert.equal((await f.event('manual-file')).code,'attachment_draft_present');assert.equal(f.events.some(e=>e.type==='navigate'),false);assert.equal(f.page.location.pathname,'/');
});

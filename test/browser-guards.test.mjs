import { test, installNativeEditing } from './test-support.mjs';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readFile } from 'node:fs/promises';
const target='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
test('conversation cleanup confirms only the targeted chat and waits for removal', async t => {
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);
 f.page.document.body.insertAdjacentHTML('beforeend',`<main><button aria-label="More">More</button></main><a href="/c/${target}">Test chat</a>`);
 f.page.document.querySelector('[aria-label="More"]').addEventListener('click',()=>{
   const menu=f.page.document.createElement('div');menu.setAttribute('role','menu');menu.innerHTML='<button role="menuitem">Delete</button>';f.page.document.body.append(menu);
   menu.querySelector('button').addEventListener('click',()=>{
     menu.remove();f.page.document.querySelector('[role="textbox"]').setAttribute('aria-hidden','true');const dialog=f.page.document.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>Delete chat?</h2><button>Delete</button>';f.page.document.body.append(dialog);
     dialog.querySelector('button').addEventListener('click',()=>{dialog.remove();f.page.document.querySelector('a').remove();f.page.history.pushState({},'','/');f.page.dispatchEvent(new f.page.CustomEvent('localgpt:conversation-deleted',{detail:JSON.stringify({conversationId:target})}));});
   });
 });
 f.queue({type:'delete_conversation',requestId:'cleanup',conversationId:target});
 let terminal;for(let i=0;i<150;i++){terminal=f.events.find(e=>e.requestId==='cleanup'&&['error','conversation_deleted'].includes(e.type));if(terminal)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(terminal?.type,'conversation_deleted',JSON.stringify(terminal));assert.equal(terminal.conversationId,target);
});

test('conversation cleanup refuses a changed chat before the final delete click',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);let confirmed=false;
 f.page.document.body.insertAdjacentHTML('beforeend','<main><button aria-label="More">More</button></main>');
 f.page.document.querySelector('[aria-label="More"]').addEventListener('click',()=>{
   const menu=f.page.document.createElement('div');menu.setAttribute('role','menu');menu.innerHTML='<button role="menuitem">Delete</button>';f.page.document.body.append(menu);
   menu.querySelector('button').addEventListener('click',()=>{
     menu.remove();f.page.history.pushState({},'','/c/6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4');
     const dialog=f.page.document.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>Delete chat?</h2><button>Delete</button>';f.page.document.body.append(dialog);
     dialog.querySelector('button').addEventListener('click',()=>confirmed=true);
   });
 });
 f.queue({type:'delete_conversation',requestId:'changed-delete',conversationId:target});
 assert.equal((await f.event('changed-delete')).code,'conversation_changed');assert.equal(confirmed,false);
});

test('conversation cleanup preserves manual drafts',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);f.page.document.querySelector('[role="textbox"]').textContent='Keep my draft';
 f.queue({type:'delete_conversation',requestId:'draft-delete',conversationId:target});
 assert.equal((await f.event('draft-delete')).code,'composer_not_empty');assert.equal(f.page.document.querySelector('[role="textbox"]').textContent,'Keep my draft');
});
async function fixture(t, url='https://chatgpt.com/') {
 const page=new Window({url});t.after(async()=>{page.dispatchEvent(new page.Event('pagehide'));await page.happyDOM.abort();page.close();});
 page.document.body.innerHTML='<div role="textbox" contenteditable="true"></div><button aria-label="Send">Send</button>';await page.happyDOM.waitUntilComplete();
 installNativeEditing(page);
 const normalTimer=page.setTimeout.bind(page);page.setTimeout=(callback,delay,...args)=>normalTimer(callback,page.responseTimersThrottled&&delay===100?60000:delay,...args);
 let queued=null;const events=[];let failBridge=false;let polls=0;let holdNavigation;const navigationStarted=new Promise(resolve=>holdNavigation=resolve);let releaseNavigation;const navigationGate=new Promise(resolve=>releaseNavigation=resolve);
 page.chrome={runtime:{sendMessage:async r=>{if(failBridge&&r.path==='event')return {ok:false,error:'Simulated disconnect'};if(r.path==='poll'){polls++;const request=queued;queued=null;return {ok:true,data:{request}};}events.push(r.data);if(r.data.type==='navigate'){holdNavigation();await navigationGate;}return {ok:true,data:{ok:true,accepted:r.data.type!=='heartbeat'}};}}};
 const globals=['chrome','window','document','location','HTMLTextAreaElement','WebSocket','CustomEvent','crypto','sessionStorage','setTimeout','clearTimeout'];new Function(...globals,await readFile('dist/extension/content.js','utf8'))(...globals.map(k=>k==='window'?page:['setTimeout','clearTimeout'].includes(k)?page[k].bind(page):page[k]));
 return {page,events,setDisconnected:value=>failBridge=value,queue:r=>queued=r,polls:()=>polls,navigationStarted,releaseNavigation,async event(id){for(let i=0;i<150;i++){const e=events.find(e=>e.requestId===id&&e.type==='error');if(e)return e;await new Promise(r=>setTimeout(r,20));}throw Error('No error event');}};
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
test('new session binds to the conversation identified by its API stream',async t=>{
 const f=await fixture(t);apiReply(f,'Our new answer');f.page.document.querySelector('button').addEventListener('click',()=>{f.page.document.body.insertAdjacentHTML('beforeend','<div data-message-author-role="user">Our question</div>');f.page.history.pushState({},'',`/c/${target}`);f.page.document.body.insertAdjacentHTML('beforeend','<div data-message-author-role="assistant">Our new answer</div>');});f.queue({type:'request',requestId:'new-session',text:'Our question',newChat:true});let stop;for(let i=0;i<200;i++){stop=f.events.find(e=>e.requestId==='new-session'&&e.type==='stop');if(stop)break;await new Promise(r=>setTimeout(r,20));}assert.equal(stop?.conversationId,target);assert.equal(f.events.find(e=>e.type==='answer')?.text,'Our new answer');assert.equal(f.events.some(e=>e.type==='error'),false);
});

test('manual attachments block requests without API files before session navigation',async t=>{
 const f=await fixture(t); const editor=f.page.document.querySelector('[role="textbox"]'); const form=f.page.document.createElement('form');editor.replaceWith(form);form.append(editor);form.insertAdjacentHTML('beforeend','<button aria-label="Remove manual.txt">Remove</button>');
 f.queue({type:'request',requestId:'manual-file',text:'Continue',newChat:false,conversationId:target});assert.equal((await f.event('manual-file')).code,'attachment_draft_present');assert.equal(f.events.some(e=>e.type==='navigate'),false);assert.equal(f.page.location.pathname,'/');
});

test('new session follows its submitted message ID when React replaces the user bubble', async t => {
 const f = await fixture(t);
 apiReply(f,'Our new answer');
 const messageId = 'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f';
 f.page.document.querySelector('button').addEventListener('click', () => {
   f.page.document.body.insertAdjacentHTML('beforeend', `<div data-message-author-role="user" data-message-id="${messageId}">Our question</div>`);
   f.page.dispatchEvent(new f.page.CustomEvent('localgpt:submitted-turn', { detail: JSON.stringify({ messageId, conversationId: null }) }));
   setTimeout(() => {
     f.page.document.querySelector('[data-message-author-role="user"]').remove();
     f.page.history.pushState({}, '', `/c/${target}`);
     f.page.document.body.insertAdjacentHTML('beforeend', `<div data-chatgpt-search-message-ids="${messageId}"><div data-user-message-bubble>Our question</div></div><div data-message-author-role="assistant">Our new answer</div>`);
   }, 30);
 });
 f.queue({ type: 'request', requestId: 'replaced-turn', text: 'Our question', newChat: true });
 let terminal;
 for (let i = 0; i < 200; i++) {
   terminal = f.events.find(e => e.requestId === 'replaced-turn' && ['stop', 'error'].includes(e.type));
   if (terminal) break;
   await new Promise(r => setTimeout(r, 20));
 }
 assert.equal(terminal?.type, 'stop', JSON.stringify(terminal));
 assert.equal(terminal.conversationId, target);
 assert.equal(f.events.find(e => e.type === 'answer')?.text, 'Our new answer');
});

const neighborId='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4';
async function sidebarDeleteFixture(t,{receipt=true,deep=false}={}){
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);const clicks={target:0,neighbor:0,confirm:0};
 f.page.document.body.insertAdjacentHTML('beforeend',`<nav id="sidebar"><a id="skip" href="/c/${target}#main">Skip to content</a><div id="neighbor-row"><a href="/c/${neighborId}">Neighbor</a><button id="neighbor-action" aria-label="Chat actions"></button></div>${deep?`<div id="target-row"><div role="group"><div><div><div><a href="/c/${target}">Ours</a></div></div></div><button id="target-action" aria-label="Chat actions"></button></div></div>`:`<div id="target-row"><a href="/c/${target}">Ours</a><button id="target-action" aria-label="Chat actions"></button></div>`}</nav>${deep?`<div id="titlebar" data-testid="app-shell-header-context-menu-surface"><button id="header-more" aria-label="More">More</button></div>`:''}`);
 const doc=f.page.document;const headerMore={count:0};doc.getElementById('header-more')?.addEventListener('click',()=>headerMore.count++);
 doc.getElementById('neighbor-action').addEventListener('click',()=>clicks.neighbor++);
 doc.getElementById('target-action').addEventListener('click',()=>{
  clicks.target++;const menu=doc.createElement('div');menu.setAttribute('role','menu');menu.innerHTML='<button role="menuitem">Delete</button>';doc.body.append(menu);
  menu.querySelector('button').addEventListener('click',()=>{menu.remove();const dialog=doc.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>Delete chat?</h2><button>Delete</button>';doc.body.append(dialog);
   doc.getElementById('sidebar').setAttribute('aria-hidden','true');
   dialog.querySelector('button').addEventListener('click',()=>{clicks.confirm++;dialog.remove();doc.getElementById('sidebar').removeAttribute('aria-hidden');doc.getElementById('target-row').remove();f.page.history.pushState({},'','/');if(receipt)f.page.dispatchEvent(new f.page.CustomEvent('localgpt:conversation-deleted',{detail:JSON.stringify({conversationId:target})}));});
  });
 });
 const terminal=async id=>{for(let i=0;i<150;i++){const e=f.events.find(e=>e.requestId===id&&['error','conversation_deleted'].includes(e.type));if(e)return e;await new Promise(r=>setTimeout(r,20));}return undefined;};
 return {f,clicks,doc,terminal,headerMore};
}
test('built cleanup ignores a skip link and neighbor row, requires the native receipt and removes only the exact target',async t=>{
 const {f,clicks,doc,terminal}=await sidebarDeleteFixture(t);
 f.queue({type:'delete_conversation',requestId:'sidebar-delete',conversationId:target});
 const done=await terminal('sidebar-delete');
 assert.equal(done?.type,'conversation_deleted',JSON.stringify(done));assert.equal(done.conversationId,target);
 assert.deepEqual(clicks,{target:1,neighbor:0,confirm:1});
 assert.ok(doc.getElementById('skip'),'A non-row hash link must not prevent receipt-confirmed deletion');
 assert.equal(doc.getElementById('target-row'),null);assert.ok(doc.getElementById('neighbor-row'));assert.equal(doc.querySelector(`a[href="/c/${neighborId}"]`)?.textContent,'Neighbor');
});
test('built cleanup without the native deletion receipt never reports success or touches the neighbor',async t=>{
 const {f,clicks,doc}=await sidebarDeleteFixture(t,{receipt:false});
 f.queue({type:'delete_conversation',requestId:'sidebar-no-receipt',conversationId:target});
 await new Promise(r=>setTimeout(r,1300));
 assert.equal(f.events.some(e=>e.type==='conversation_deleted'),false);assert.deepEqual(clicks,{target:1,neighbor:0,confirm:1});assert.ok(doc.getElementById('neighbor-row'));
});
test('built cleanup with skip link and neighbor still refuses while a generation is active',async t=>{
 const {f,clicks,doc}=await sidebarDeleteFixture(t);
 doc.body.insertAdjacentHTML('beforeend','<button data-testid="stop-button">Stop</button>');
 f.queue({type:'delete_conversation',requestId:'sidebar-busy',conversationId:target});
 assert.equal((await f.event('sidebar-busy')).code,'browser_busy');
 assert.deepEqual(clicks,{target:0,neighbor:0,confirm:0});assert.ok(doc.getElementById('target-row'));assert.ok(doc.getElementById('neighbor-row'));assert.equal(f.events.some(e=>e.type==='conversation_deleted'),false);
});
async function rowReuseFixture(t,phase){
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);const clicks={menu:0,confirm:0};const doc=f.page.document;
 doc.body.insertAdjacentHTML('beforeend',`<nav id="sidebar"><div id="target-row"><a id="target-link" href="/c/${target}">Ours</a><button id="target-action" aria-label="Chat actions"></button></div></nav>`);
 const reuse=()=>doc.getElementById('target-link').setAttribute('href',`/c/${neighborId}`);
 doc.getElementById('target-action').addEventListener('click',()=>{
  const menu=doc.createElement('div');menu.setAttribute('role','menu');menu.innerHTML='<button role="menuitem">Delete</button>';doc.body.append(menu);
  if(phase==='action')reuse();
  menu.querySelector('button').addEventListener('click',()=>{clicks.menu++;menu.remove();
   const dialog=doc.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>Delete chat?</h2><button>Delete</button>';doc.body.append(dialog);
   dialog.querySelector('button').addEventListener('click',()=>clicks.confirm++);
   if(phase==='menu')reuse();
  });
 });
 return {f,clicks};
}
test('built cleanup refuses when the target row is reused for another chat right after its action opens the menu',async t=>{
 const {f,clicks}=await rowReuseFixture(t,'action');
 f.queue({type:'delete_conversation',requestId:'row-reuse-action',conversationId:target});
 const done=await f.event('row-reuse-action');
 assert.equal(done.code,'conversation_changed');assert.equal(f.page.location.pathname,`/c/${target}`);
 assert.deepEqual(clicks,{menu:0,confirm:0});assert.equal(f.events.some(e=>e.type==='conversation_deleted'),false);
});
test('built cleanup refuses the final confirm when the target row is reused after the Delete menu opens the dialog',async t=>{
 const {f,clicks}=await rowReuseFixture(t,'menu');
 f.queue({type:'delete_conversation',requestId:'row-reuse-menu',conversationId:target});
 const done=await f.event('row-reuse-menu');
 assert.equal(done.code,'conversation_changed');assert.equal(f.page.location.pathname,`/c/${target}`);
 assert.equal(clicks.confirm,0);assert.equal(f.events.some(e=>e.type==='conversation_deleted'),false);
});
test('cleanup never treats navigation after a failed deletion as success',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);
 f.page.document.body.insertAdjacentHTML('beforeend','<main><button aria-label="More">More</button></main>');
 f.page.document.querySelector('[aria-label="More"]').onclick=()=>{
  const menu=f.page.document.createElement('div');menu.setAttribute('role','menu');menu.innerHTML='<button role="menuitem">Delete</button>';f.page.document.body.append(menu);
  menu.querySelector('button').onclick=()=>{menu.remove();const d=f.page.document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<h2>Delete chat?</h2><button>Delete</button>';f.page.document.body.append(d);d.querySelector('button').onclick=()=>{d.remove();f.page.history.pushState({},'','/');};};
 };
 f.queue({type:'delete_conversation',requestId:'failed-delete',conversationId:target});
 await new Promise(r=>setTimeout(r,1300));assert.equal(f.events.some(e=>e.type==='conversation_deleted'),false);
});
test('cleanup preserves drafts entered while opening the deletion dialog',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);let confirmed=false;
 f.page.document.body.insertAdjacentHTML('beforeend','<main><button aria-label="More">More</button></main>');
 f.page.document.querySelector('[aria-label="More"]').onclick=()=>{
  const menu=f.page.document.createElement('div');menu.setAttribute('role','menu');menu.innerHTML='<button role="menuitem">Delete</button>';f.page.document.body.append(menu);
  menu.querySelector('button').onclick=()=>{menu.remove();f.page.document.querySelector('[role="textbox"]').textContent='New draft';const d=f.page.document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<h2>Delete chat?</h2><button>Delete</button>';f.page.document.body.append(d);d.querySelector('button').onclick=()=>confirmed=true;};
 };
 f.queue({type:'delete_conversation',requestId:'new-draft',conversationId:target});
 assert.equal((await f.event('new-draft')).code,'composer_not_empty');assert.equal(confirmed,false);
});
test('response body and completion come from correlated API events even without an assistant DOM node',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);
 f.page.document.querySelector('button').onclick=()=>{
  f.page.addEventListener('localgpt:stream-arm',()=>{});
 };
 f.page.addEventListener('localgpt:stream-arm',e=>{
  const arm=JSON.parse(e.detail);
  setTimeout(()=>{
   const emit=(kind,text)=>f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,kind,...(text===undefined?{}:{text})})}));
   emit('answer','API本文');emit('stop');
  },30);
 });
 f.queue({type:'request',requestId:'api-answer',text:'test',newChat:false,conversationId:target});
 let terminal;for(let i=0;i<150;i++){terminal=f.events.find(e=>e.requestId==='api-answer'&&['stop','error'].includes(e.type));if(terminal)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(terminal?.type,'stop',JSON.stringify(terminal));assert.equal(f.events.find(e=>e.type==='answer')?.text,'API本文');
});
test('DOM-only answers and unrelated API streams cannot complete an API request',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);
 f.page.document.querySelector('button').onclick=()=>f.page.document.body.insertAdjacentHTML('beforeend','<div data-message-author-role="assistant">Fake DOM answer</div>');
 f.page.addEventListener('localgpt:stream-arm',()=>{setTimeout(()=>f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:'different-job',messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,kind:'answer',text:'Unrelated'})})),30);});
 f.queue({type:'request',requestId:'dom-only',text:'test',newChat:false,conversationId:target});
 await new Promise(r=>setTimeout(r,3600));assert.equal(f.events.some(e=>e.requestId==='dom-only'&&['answer','stop'].includes(e.type)),false);
});

function apiReply(f,text){
 f.page.addEventListener('localgpt:stream-arm',e=>{
  const arm=JSON.parse(e.detail);
  setTimeout(()=>{
   for(const event of [{kind:'answer',text},{kind:'stop'}]) f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,...event})}));
  },100);
 });
}
test('current ChatGPT empty paragraph decoration does not block generation',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);const editor=f.page.document.querySelector('[role="textbox"]');editor.innerHTML='<p class="placeholder" data-empty-paragraph="true" data-placeholder="Ask ChatGPT"><br class="ProseMirror-trailingBreak"></p>';let sent;
 apiReply(f,'Reply');f.page.document.querySelector('button').onclick=()=>{sent=editor.textContent;editor.textContent='';};
 f.queue({type:'request',requestId:'empty-decoration',text:'Our question',newChat:false,conversationId:target});
 let end;for(let i=0;i<150;i++){end=f.events.find(e=>e.requestId==='empty-decoration'&&['error','stop'].includes(e.type));if(end)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(end?.type,'stop',JSON.stringify(end));assert.equal(sent,'Our question');assert.equal(f.events.some(e=>e.requestId==='empty-decoration'&&e.type==='error'),false);
});
test('generation suspends a multiline draft and restores it without sending it',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);const editor=f.page.document.querySelector('[role="textbox"]');editor.innerHTML='<p>  manual</p><p>draft  </p>';let sent;
 apiReply(f,'Reply');f.page.document.querySelector('button').onclick=()=>{sent=editor.textContent;editor.textContent='';};
 f.queue({type:'request',requestId:'draft-generation',text:'Our question',newChat:false,conversationId:target});
 let end;for(let i=0;i<150;i++){end=f.events.find(e=>e.requestId==='draft-generation'&&['error','stop'].includes(e.type));if(end)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(end?.type,'stop',JSON.stringify(end));assert.equal(sent,'Our question');assert.equal(editor.textContent,'  manual\ndraft  ');
 assert.equal(JSON.stringify(f.events).includes('manual'),false);
});
test('a failure before send restores the original draft',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);const editor=f.page.document.querySelector('[role="textbox"]');editor.textContent='Keep on failure';let sent=false;f.page.document.querySelector('button').onclick=()=>sent=true;
 f.queue({type:'request',requestId:'draft-failure',text:'Our question',newChat:false,projectName:'Missing project'});
 assert.equal((await f.event('draft-failure')).code,'project_control_unavailable');assert.equal(sent,false);assert.equal(editor.textContent,'Keep on failure');
});
test('another session navigation durably saves the draft without sending it',async t=>{
 const f=await fixture(t);const editor=f.page.document.querySelector('[role="textbox"]');editor.textContent='Home draft';let sent=false;f.page.document.querySelector('button').onclick=()=>sent=true;
 f.queue({type:'request',requestId:'draft-navigation',text:'Our question',newChat:false,conversationId:target});await f.navigationStarted;
 const saved=JSON.parse(f.page.sessionStorage.getItem('localgpt:draft-backups:v1'));assert.deepEqual(saved,[{route:'/',text:'Home draft'}]);assert.equal(sent,false);assert.equal(editor.textContent,'');
 assert.equal(f.page.document.querySelector('#localgpt-saved-drafts').hidden,false);assert.equal(f.page.document.querySelector('#localgpt-saved-drafts a').getAttribute('href'),'/');f.releaseNavigation();
});
test('whitespace typed during project setup is protected after suspending a draft',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);const editor=f.page.document.querySelector('[role="textbox"]');editor.textContent='Original saved draft';let sent=false;f.page.document.querySelector('button').onclick=()=>sent=true;
 const add=f.page.document.createElement('button');add.textContent='Add new project';f.page.document.body.append(add);add.onclick=()=>{editor.textContent='  \n  ';f.page.document.body.insertAdjacentHTML('beforeend','<div role="dialog">Create project<input><button>Create project</button></div>');};
 f.queue({type:'request',requestId:'draft-race',text:'API input',newChat:false,projectName:'New project'});
 assert.equal((await f.event('draft-race')).code,'composer_not_empty');assert.equal(editor.textContent,'  \n  ');assert.equal(sent,false);assert.equal(JSON.parse(f.page.sessionStorage.getItem('localgpt:draft-backups:v1'))[0].text,'Original saved draft');
});
test('observed thinking remains active beyond ten seconds without visible answer', {timeout:16000}, async t=>{
 const f=await fixture(t);let arm;
 f.page.addEventListener('localgpt:stream-arm',e=>{
  arm=JSON.parse(e.detail);
  setTimeout(()=>{
   f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,kind:'started'})}));
   f.page.history.pushState({},'',`/c/${target}`);
  },20);
 });
 f.queue({type:'request',requestId:'thinking',text:'think',newChat:true});
 for(let i=0;i<100&&!arm;i++)await new Promise(r=>setTimeout(r,20));assert.ok(arm);
 await new Promise(r=>setTimeout(r,10300));assert.equal(f.events.some(e=>e.requestId==='thinking'&&['error','stop'].includes(e.type)),false);
 for(const event of [{kind:'answer',text:'Finished thinking'},{kind:'stop'}])f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,...event})}));
 for(let i=0;i<30&&!f.events.some(e=>e.type==='stop');i++)await new Promise(r=>setTimeout(r,20));assert.equal(f.events.find(e=>e.type==='stop')?.conversationId,target);
});
test('image-only response waits for correlated download metadata arriving after stream completion',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);
 f.page.addEventListener('localgpt:stream-arm',e=>{
  const arm=JSON.parse(e.detail);const emit=event=>f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,...event})}));
  setTimeout(()=>{emit({kind:'image_ref',fileId:'file_generated'});emit({kind:'stop'});},20);
  setTimeout(()=>emit({kind:'image',fileId:'file_generated',downloadUrl:'https://x.oaiusercontent.com/image?sig=test'}),200);
 });
 f.queue({type:'request',requestId:'api-image',text:'image',newChat:false,conversationId:target});
 let terminal;for(let i=0;i<100;i++){terminal=f.events.find(e=>e.requestId==='api-image'&&['stop','error'].includes(e.type));if(terminal)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(terminal?.type,'stop',JSON.stringify(terminal));const image=f.events.find(e=>e.type==='image');assert.equal(image?.fileId,'file_generated');assert.equal(image?.conversationId,target);assert.ok(f.events.indexOf(image)<f.events.indexOf(terminal));assert.equal(f.events.some(e=>e.type==='answer'),false);
});
test('new chat tolerates its temporary local-chatgpt route until the API identifies the permanent conversation',async t=>{
 const f=await fixture(t);const mid='f5eadb59-b96e-4ef5-9342-2f49d62b3c6f';
 f.page.addEventListener('localgpt:stream-arm',e=>{
  const {requestId}=JSON.parse(e.detail);const emit=(kind,conversationId,text)=>f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId,messageId:mid,conversationId,kind,...(text?{text}:{})})}));
  setTimeout(()=>{emit('started',null);f.page.history.pushState({},'','/c/local-chatgpt%3A1ac815df-e1ac-4c79-a387-6c9f36c61442');},20);
  setTimeout(()=>{emit('answer',target,'Native reply');emit('stop',target);},200);
  setTimeout(()=>f.page.history.pushState({},'',`/c/${target}`),400);
 });
 f.queue({type:'request',requestId:'temporary-route',text:'test',newChat:true});
 let terminal;for(let i=0;i<100;i++){terminal=f.events.find(e=>e.requestId==='temporary-route'&&['stop','error'].includes(e.type));if(terminal)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(terminal?.type,'stop',JSON.stringify(terminal));assert.equal(terminal.conversationId,target);
});
test('switching visible chats after a correlated send keeps the original API response',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);
 f.page.addEventListener('localgpt:stream-arm',e=>{
  const arm=JSON.parse(e.detail);const emit=event=>f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,...event})}));
  emit({kind:'started'});
  f.page.history.pushState({},'','/c/6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4');
  f.page.document.body.insertAdjacentHTML('beforeend','<div data-message-author-role="assistant">Other chat private text</div>');
  setTimeout(()=>{emit({kind:'answer',text:'Original API response'});emit({kind:'stop'});},20);
 });
 f.queue({type:'request',requestId:'switched-after-send',text:'Question',newChat:false,conversationId:target});
 let terminal;for(let i=0;i<100;i++){terminal=f.events.find(e=>e.requestId==='switched-after-send'&&['stop','error'].includes(e.type));if(terminal)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(terminal?.type,'stop',JSON.stringify(terminal));assert.equal(terminal.conversationId,target);assert.equal(f.events.find(e=>e.type==='answer')?.text,'Original API response');
});
test('a default project request starts inside the exact project and returns its native project ID',async t=>{
 const f=await fixture(t);const pid='g-p-6ac2076d66d081919fc3db8b4db4af71';
 f.page.document.body.insertAdjacentHTML('beforeend',`<div role="button" data-app-action-sidebar-project-id="${pid}" data-app-action-sidebar-project-label="LocalGPT"><button aria-label="New chat in LocalGPT">New</button></div>`);
 f.page.document.querySelector('[aria-label="New chat in LocalGPT"]').onclick=()=>f.page.history.pushState({},'',`/g/${pid}/project`);
 f.page.addEventListener('localgpt:stream-arm',e=>{
  const arm=JSON.parse(e.detail);assert.equal(arm.projectId,pid);assert.equal(f.page.location.pathname,`/g/${pid}/project`);
  const emit=event=>f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,projectId:pid,...event})}));
  setTimeout(()=>{emit({kind:'started'});f.page.history.pushState({},'',`/g/${pid}-localgpt/c/${target}`);emit({kind:'answer',text:'Grouped reply'});emit({kind:'stop'});},20);
 });
 f.queue({type:'request',requestId:'grouped-new',text:'Question',newChat:true,projectName:'LocalGPT'});
 let terminal;for(let i=0;i<100;i++){terminal=f.events.find(e=>e.requestId==='grouped-new'&&['stop','error'].includes(e.type));if(terminal)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(terminal?.type,'stop',JSON.stringify(terminal));assert.equal(terminal.projectId,pid);assert.equal(terminal.conversationId,target);
});
test('automatic project creation preserves its captured composer while the modal hides it',async t=>{
 const f=await fixture(t);const pid='g-p-6ac2076d66d081919fc3db8b4db4af71';
 const wrap=f.page.document.createElement('div');const editor=f.page.document.querySelector('[role="textbox"]');editor.replaceWith(wrap);wrap.append(editor);
 f.page.document.body.insertAdjacentHTML('beforeend','<button aria-label="Add new project">Add</button>');
 f.page.document.querySelector('[aria-label="Add new project"]').onclick=()=>{
  wrap.setAttribute('aria-hidden','true');const modal=f.page.document.createElement('div');modal.setAttribute('role','dialog');modal.innerHTML='<h2>Create project</h2><input aria-label="Project name"><button disabled>Create project</button>';f.page.document.body.append(modal);
  modal.querySelector('input').oninput=()=>modal.querySelector('button').disabled=false;
  modal.querySelector('button').onclick=()=>{assert.equal(modal.querySelector('input').value,'LocalGPT');modal.remove();wrap.removeAttribute('aria-hidden');f.page.document.body.insertAdjacentHTML('beforeend',`<div role="button" data-app-action-sidebar-project-id="${pid}" data-app-action-sidebar-project-label="LocalGPT"><button aria-label="New chat in LocalGPT">New</button></div>`);f.page.document.querySelector('[aria-label="New chat in LocalGPT"]').onclick=()=>f.page.history.pushState({},'',`/g/${pid}/project`);};
 };
 f.page.addEventListener('localgpt:stream-arm',e=>{const arm=JSON.parse(e.detail);for(const event of [{kind:'answer',text:'Created'},{kind:'stop'}])f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,projectId:pid,...event})}));});
 f.queue({type:'request',requestId:'project-create',text:'Question',newChat:true,projectName:'LocalGPT'});
 let terminal;for(let i=0;i<100;i++){terminal=f.events.find(e=>e.requestId==='project-create'&&['stop','error'].includes(e.type));if(terminal)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(terminal?.type,'stop',JSON.stringify(terminal));assert.equal(terminal.projectId,pid);
});
test('a restored attachment in the destination project blocks sending',async t=>{
 const f=await fixture(t);const pid='g-p-6ac2076d66d081919fc3db8b4db4af71';let sent=false;
 f.page.document.body.insertAdjacentHTML('beforeend',`<div role="button" data-app-action-sidebar-project-id="${pid}" data-app-action-sidebar-project-label="LocalGPT"><button aria-label="New chat in LocalGPT">New</button></div>`);
 f.page.document.querySelector('[aria-label="New chat in LocalGPT"]').onclick=()=>{
  f.page.history.pushState({},'',`/g/${pid}/project`);const editor=f.page.document.querySelector('[role="textbox"]');const form=f.page.document.createElement('form');editor.replaceWith(form);form.append(editor);form.insertAdjacentHTML('beforeend','<button aria-label="Remove manual.txt">Remove</button>');
 };
 f.page.document.querySelector('[aria-label="Send"]').onclick=()=>sent=true;
 f.queue({type:'request',requestId:'project-manual-file',text:'Question',newChat:true,projectName:'LocalGPT'});
 assert.equal((await f.event('project-manual-file')).code,'attachment_draft_present');assert.equal(sent,false);
});

test('background timer throttling cannot hold API answers after switching chats',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);
 f.page.addEventListener('localgpt:stream-arm',e=>{
  const arm=JSON.parse(e.detail);const emit=event=>f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,...event})}));
  emit({kind:'started'});f.page.responseTimersThrottled=true;f.page.history.pushState({},'','/c/6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4');
  setTimeout(()=>{emit({kind:'answer',text:'Background API result'});emit({kind:'stop'});},20);
 });
 f.queue({type:'request',requestId:'background-result',text:'Question',newChat:false,conversationId:target});
 for(let i=0;i<70&&!f.events.some(e=>e.requestId==='background-result'&&e.type==='stop');i++)await new Promise(r=>setTimeout(r,20));
 assert.equal(f.events.find(e=>e.requestId==='background-result'&&e.type==='answer')?.text,'Background API result');assert.ok(f.events.some(e=>e.requestId==='background-result'&&e.type==='stop'));
});
test('slow HTTP acknowledgements coalesce answers while preserving final text before stop',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);let release;const gate=new Promise(r=>release=r);t.after(()=>release());const original=f.page.chrome.runtime.sendMessage;let blocked=false;
 f.page.chrome.runtime.sendMessage=async r=>{const result=await original(r);if(r.data?.type==='answer'&&!blocked){blocked=true;await gate;}return result;};
 f.page.addEventListener('localgpt:stream-arm',e=>{
  const arm=JSON.parse(e.detail);const emit=event=>f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,...event})}));emit({kind:'started'});
  setTimeout(()=>{emit({kind:'answer',text:'1'});setTimeout(()=>{for(let i=2;i<=20;i++)emit({kind:'answer',text:String(i)});emit({kind:'stop'});},10);},10);
 });
 f.queue({type:'request',requestId:'coalesced',text:'Question',newChat:false,conversationId:target});
 for(let i=0;i<60&&!blocked;i++)await new Promise(r=>setTimeout(r,20));await new Promise(r=>setTimeout(r,80));release();
 for(let i=0;i<40&&!f.events.some(e=>e.requestId==='coalesced'&&e.type==='stop');i++)await new Promise(r=>setTimeout(r,20));
 const answers=f.events.filter(e=>e.requestId==='coalesced'&&e.type==='answer');assert.ok(answers.length<=2,`Queued ${answers.length} answers`);assert.equal(answers.at(-1).text,'20');assert.equal(f.events.filter(e=>e.requestId==='coalesced').at(-1).type,'stop');
});

test('quiet API response is released when HTTP transport disconnects',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);const original=f.page.chrome.runtime.sendMessage;
 f.page.chrome.runtime.sendMessage=async r=>{if(r.path==='event'&&r.data?.type==='heartbeat')throw Error('Disconnected');return original(r);};
 f.page.addEventListener('localgpt:stream-arm',e=>{const arm=JSON.parse(e.detail);f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,kind:'started'})}));});
 f.queue({type:'request',requestId:'quiet-disconnected',text:'Question',newChat:false,conversationId:target});assert.equal((await f.event('quiet-disconnected')).code,'browser_disconnected');
 f.page.chrome.runtime.sendMessage=original;await new Promise(r=>setTimeout(r,3200));
 f.page.addEventListener('localgpt:stream-arm',e=>{const arm=JSON.parse(e.detail);if(arm.requestId==='after-disconnect')setTimeout(()=>f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:arm.requestId,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,kind:'error',code:'test_complete'})})),20);});
 f.queue({type:'request',requestId:'after-disconnect',text:'New question',newChat:false,conversationId:target});assert.equal((await f.event('after-disconnect')).code,'test_complete');
});

test('background observer replays answer and stop after failed HTTP event and heartbeat reconnect', {timeout:10000},async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);let arm;const id='http-recover';
 f.page.addEventListener('localgpt:stream-arm',e=>{arm=JSON.parse(e.detail)});
 f.queue({type:'request',requestId:id,text:'Review',newChat:false,conversationId:target,backgroundJob:true,timeoutMs:1000});
 for(let i=0;i<100&&!arm;i++)await new Promise(r=>setTimeout(r,20));assert.ok(arm);
 const emit=event=>f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:id,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,...event})}));
 emit({kind:'started'});f.setDisconnected(true);emit({kind:'answer',text:'Recovered result'});await new Promise(r=>setTimeout(r,1100));emit({kind:'stop'});f.setDisconnected(false);
 for(let i=0;i<200&&!f.events.some(e=>e.requestId===id&&e.type==='stop');i++)await new Promise(r=>setTimeout(r,20));
 assert.equal(f.events.find(e=>e.requestId===id&&e.type==='answer')?.text,'Recovered result');assert.ok(f.events.some(e=>e.requestId===id&&e.type==='stop'));
});
test('background observer preserves partial answer when unknown stream error arrives in the same turn',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);let arm;const id='partial-before-error';f.page.addEventListener('localgpt:stream-arm',e=>arm=JSON.parse(e.detail));f.queue({type:'request',requestId:id,text:'Review',newChat:false,conversationId:target,backgroundJob:true,timeoutMs:1000});for(let i=0;i<100&&!arm;i++)await new Promise(r=>setTimeout(r,20));assert.ok(arm);
 const emit=event=>f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream',{detail:JSON.stringify({requestId:id,messageId:'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f',conversationId:target,...event})}));emit({kind:'started'});emit({kind:'answer',text:'Safe partial answer'});emit({kind:'error',code:'unsupported_response_stream'});
 for(let i=0;i<100&&!f.events.some(e=>e.requestId===id&&e.type==='answer');i++)await new Promise(r=>setTimeout(r,20));assert.equal(f.events.find(e=>e.requestId===id&&e.type==='answer')?.text,'Safe partial answer');assert.equal(f.events.some(e=>e.requestId===id&&e.type==='error'),false);assert.ok(f.events.some(e=>e.requestId===id&&e.type==='progress'&&e.phase==='unresponsive'));
});

test('native answer remains correlated when ChatGPT recycles an existing assistant element',async t=>{
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);apiReply(f,'Fresh review result');
 f.page.document.body.insertAdjacentHTML('beforeend','<div data-chatgpt-selection-message-id="old-answer"><div data-markdown-text-style="assistant-message">Old answer</div></div>');
 const recycled=f.page.document.querySelector('[data-chatgpt-selection-message-id]');f.page.document.querySelector('button').addEventListener('click',()=>{recycled.setAttribute('data-chatgpt-selection-message-id','new-answer');recycled.querySelector('[data-markdown-text-style]').textContent='Fresh review result';});
 f.queue({type:'request',requestId:'recycled',text:'Review this diff',newChat:false});let stop;for(let i=0;i<200;i++){stop=f.events.find(e=>e.requestId==='recycled'&&e.type==='stop');if(stop)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(f.events.find(e=>e.requestId==='recycled'&&e.type==='answer')?.text,'Fresh review result');assert.equal(stop?.conversationId,target);
});

async function headerDeleteFixture(t,{receipt=true,detach=false,header='<button id="header-more" aria-label="More">More</button>',routeAfterMore=false,outside=""}={}){
 const f=await fixture(t,`https://chatgpt.com/c/${target}`);const clicks={more:0,menu:0,confirm:0};const doc=f.page.document;
 doc.body.insertAdjacentHTML('beforeend',`<div id="titlebar" data-testid="app-shell-header-context-menu-surface">${header}</div><nav id="sidebar"><a href="/c/${neighborId}">Neighbor</a><button id="neighbor-action" aria-label="Chat actions"></button></nav>${outside}`);
 doc.getElementById('neighbor-action').addEventListener('click',()=>clicks.more+=100);
 doc.querySelectorAll('#titlebar button,#outside-more').forEach(b=>b.addEventListener('click',()=>{
  clicks.more++;if(routeAfterMore)f.page.history.pushState({},'',`/c/${neighborId}`);const menu=doc.createElement('div');menu.setAttribute('role','menu');menu.innerHTML='<button role="menuitem">Delete</button>';doc.body.append(menu);
  menu.querySelector('button').addEventListener('click',()=>{clicks.menu++;menu.remove();if(detach)doc.getElementById('titlebar').remove();const dialog=doc.createElement('div');dialog.setAttribute('role','dialog');dialog.innerHTML='<h2>Delete chat?</h2><button>Delete</button>';doc.body.append(dialog);
   dialog.querySelector('button').addEventListener('click',()=>{clicks.confirm++;dialog.remove();f.page.history.pushState({},'','/');if(receipt)f.page.dispatchEvent(new f.page.CustomEvent('localgpt:conversation-deleted',{detail:JSON.stringify({conversationId:target})}));});
  });
 }));
 const terminal=async id=>{for(let i=0;i<150;i++){const e=f.events.find(e=>e.requestId===id&&['error','conversation_deleted'].includes(e.type));if(e)return e;await new Promise(r=>setTimeout(r,20));}return undefined;};
 return {f,clicks,doc,terminal};
}
test('built cleanup deletes through the app-shell titlebar More outside main with receipt, route change and no row',async t=>{
 const {f,clicks,doc,terminal}=await headerDeleteFixture(t);
 f.queue({type:'delete_conversation',requestId:'header-delete',conversationId:target});
 const done=await terminal('header-delete');
 assert.equal(done?.type,'conversation_deleted',JSON.stringify(done));assert.equal(done.conversationId,target);
 assert.deepEqual(clicks,{more:1,menu:1,confirm:1});assert.equal(f.page.location.pathname,'/');assert.equal(doc.querySelector(`a[href="/c/${target}"]`),null);assert.ok(doc.querySelector(`a[href="/c/${neighborId}"]`));
});
test('built titlebar cleanup without the native receipt never reports success',async t=>{
 const {f,clicks}=await headerDeleteFixture(t,{receipt:false});
 f.queue({type:'delete_conversation',requestId:'header-no-receipt',conversationId:target});
 await new Promise(r=>setTimeout(r,1300));
 assert.equal(f.events.some(e=>e.type==='conversation_deleted'),false);assert.deepEqual(clicks,{more:1,menu:1,confirm:1});
});
test('built titlebar cleanup preserves a draft and never opens the menu',async t=>{
 const {f,clicks,doc}=await headerDeleteFixture(t);doc.querySelector('[role="textbox"]').textContent='Keep my draft';
 f.queue({type:'delete_conversation',requestId:'header-draft',conversationId:target});
 assert.equal((await f.event('header-draft')).code,'composer_not_empty');assert.equal(doc.querySelector('[role="textbox"]').textContent,'Keep my draft');assert.deepEqual(clicks,{more:0,menu:0,confirm:0});
});
test('built titlebar cleanup refuses to confirm when the titlebar owner is detached mid-flow',async t=>{
 const {f,clicks}=await headerDeleteFixture(t,{detach:true});
 f.queue({type:'delete_conversation',requestId:'header-detached',conversationId:target});
 assert.equal((await f.event('header-detached')).code,'conversation_changed');assert.deepEqual(clicks,{more:1,menu:1,confirm:0});assert.equal(f.page.location.pathname,`/c/${target}`);
});
for(const [name,header,extra] of [
 ['two More buttons in the exact titlebar surface','<button aria-label="More">More</button><button aria-label="More">More</button>',''],
 ['a More outside the allowed roots','','<div id="elsewhere"><button id="outside-more" aria-label="More">More</button></div>'],
]) test(`built titlebar fallback refuses ${name} and never opens any menu`,async t=>{
 const {f,clicks,doc}=await headerDeleteFixture(t,{header,outside:extra});
 f.queue({type:'delete_conversation',requestId:'header-refuse',conversationId:target});
 await new Promise(r=>setTimeout(r,1300));
 assert.equal(f.events.some(e=>e.type==='conversation_deleted'),false);assert.deepEqual(clicks,{more:0,menu:0,confirm:0});assert.equal(doc.querySelector('[role="menu"],[role="dialog"]'),null);
});
test('built titlebar cleanup aborts when the route changes after More but before menu Delete',async t=>{
 const {f,clicks}=await headerDeleteFixture(t,{routeAfterMore:true});
 f.queue({type:'delete_conversation',requestId:'header-route',conversationId:target});
 assert.equal((await f.event('header-route')).code,'conversation_changed');assert.deepEqual(clicks,{more:1,menu:0,confirm:0});assert.equal(f.events.some(e=>e.type==='conversation_deleted'),false);
});
test('built cleanup prefers a deep depth-4 owned sidebar row over a coexisting titlebar More',async t=>{
 const {f,clicks,doc,terminal,headerMore}=await sidebarDeleteFixture(t,{deep:true});
 f.queue({type:'delete_conversation',requestId:'deep-row',conversationId:target});
 const done=await terminal('deep-row');
 assert.equal(done?.type,'conversation_deleted',JSON.stringify(done));assert.equal(done.conversationId,target);
 assert.deepEqual(clicks,{target:1,neighbor:0,confirm:1});assert.equal(headerMore.count,0);assert.equal(doc.getElementById('target-row'),null);
});

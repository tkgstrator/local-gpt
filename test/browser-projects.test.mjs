import {test} from './test-support.mjs';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
const cid='6ac1f341-b4b4-83ee-afa2-6726f7913e60',pid='g-p-6ac2076d66d081919fc3db8b4db4af71';
const wait=async(check,deadline)=>{while(Date.now()<deadline){const value=check();if(value)return value;await new Promise(r=>setTimeout(r,2));}throw Error('wait expired');};
const fixture=t=>{const w=new Window({url:`https://chatgpt.com/c/${cid}`});t.after(()=>w.close());w.document.body.innerHTML=`<div role="button" data-app-action-sidebar-project-id="${pid}" data-app-action-sidebar-project-label="LocalGPT"><button aria-label="New chat in LocalGPT"></button></div>`;return w;};
test('project target uses exact native ID and rejects ambiguous names',async t=>{
 const {ensureProjectTarget}=await import('../src/browser-projects.ts');const w=fixture(t);
 assert.equal(await ensureProjectTarget(w.document,'LocalGPT',wait,Date.now()+100),pid);
 w.document.body.insertAdjacentHTML('beforeend',`<div role="button" data-app-action-sidebar-project-id="g-p-00000000000000000000000000000000" data-app-action-sidebar-project-label="LocalGPT"></div>`);
 await assert.rejects(ensureProjectTarget(w.document,'LocalGPT',wait,Date.now()+100),e=>e.code==='project_ambiguous');
});
test('known project IDs remain usable without creating a replacement when their row is hidden',async t=>{
 const {ensureProjectTarget}=await import('../src/browser-projects.ts');const w=fixture(t);w.document.querySelector('[data-app-action-sidebar-project-id]').remove();
 let creates=0;const add=w.document.createElement('button');add.textContent='Add new project';add.onclick=()=>creates++;w.document.body.append(add);
 assert.equal(await ensureProjectTarget(w.document,'LocalGPT',wait,Date.now()+50,()=>{},pid),pid);assert.equal(creates,0);
});
test('moving an existing chat requires the correlated native success receipt and keeps CID',async t=>{
 const {moveConversationToProject}=await import('../src/browser-projects.ts');const w=fixture(t);let armed;
 w.addEventListener('localgpt:project-arm',e=>armed=JSON.parse(e.detail));
 w.document.body.insertAdjacentHTML('beforeend',`<div role="group"><a href="/c/${cid}">Our chat</a><button aria-label="Chat actions"></button></div>`);
 w.document.querySelector('[aria-label="Chat actions"]').onclick=()=>{
  w.document.body.insertAdjacentHTML('beforeend','<div role="menu"><button role="menuitem">Move to project</button></div>');
  w.document.querySelector('[role="menuitem"]').onclick=()=>{
   w.document.body.insertAdjacentHTML('beforeend','<div role="menu"><button role="menuitem">LocalGPT</button></div>');
   w.document.querySelector('[role="menu"]:last-child button').onclick=()=>{
    w.history.pushState({},'',`/g/${pid}-localgpt/c/${cid}`);
    w.dispatchEvent(new w.CustomEvent('localgpt:conversation-project',{detail:JSON.stringify({conversationId:cid,projectId:pid})}));
   };
  };
 };
 await moveConversationToProject(w.document,cid,'LocalGPT',pid,()=>{},wait,Date.now()+1000);
 assert.deepEqual(armed,{conversationId:cid,projectId:pid});assert.ok(w.location.pathname.endsWith(`/c/${cid}`));
});
test('an optimistic project URL without native confirmation is never migration success',async t=>{
 const {moveConversationToProject}=await import('../src/browser-projects.ts');const w=fixture(t);
 w.document.body.insertAdjacentHTML('beforeend',`<div role="group"><a href="/c/${cid}">Our chat</a><button aria-label="Chat actions"></button></div>`);
 w.document.querySelector('[aria-label="Chat actions"]').onclick=()=>{
  w.document.body.insertAdjacentHTML('beforeend','<div role="menu"><button role="menuitem">Move to project</button></div>');
  w.document.querySelector('[role="menuitem"]').onclick=()=>{
   w.document.body.insertAdjacentHTML('beforeend','<div role="menu"><button role="menuitem">LocalGPT</button></div>');
   w.document.querySelector('[role="menu"]:last-child button').onclick=()=>w.history.pushState({},'',`/g/${pid}/c/${cid}`);
  };
 };
 await assert.rejects(moveConversationToProject(w.document,cid,'LocalGPT',pid,()=>{},wait,Date.now()+100));
});
test('already grouped URL still requires native membership confirmation',async t=>{
 const {moveConversationToProject}=await import('../src/browser-projects.ts');const w=fixture(t);w.history.pushState({},'',`/g/${pid}/c/${cid}`);
 await assert.rejects(moveConversationToProject(w.document,cid,'LocalGPT',pid,()=>{},wait,Date.now()+50));
 w.addEventListener('localgpt:project-check',()=>w.dispatchEvent(new w.CustomEvent('localgpt:conversation-project',{detail:JSON.stringify({conversationId:cid,projectId:pid})})));
 await moveConversationToProject(w.document,cid,'LocalGPT',pid,()=>{},wait,Date.now()+100);
});
const foreign='6ac1f341-b4b4-83ee-afa2-6726f7913e61';
const actionsFixture=(t,body)=>{const w=fixture(t);w.document.body.innerHTML=body;return w;};
const actionButton=id=>`<button id="${id}" aria-label="Chat actions"></button>`;
test('conversation actions select the exact target row button inside a shared wrapper',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 const w=actionsFixture(t,`<nav id="shared"><div id="foreign-row"><a href="/c/${foreign}">Other</a>${actionButton('foreign-action')}</div><div id="target-row"><a href="/c/${cid}">Ours</a>${actionButton('target-action')}</div></nav>`);
 assert.equal(conversationActions(w.document,cid),w.document.getElementById('target-action'));
 assert.equal(conversationActions(w.document,foreign),w.document.getElementById('foreign-action'));
});
test('a target row without an action never selects a neighboring conversation action',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 const w=actionsFixture(t,`<nav id="shared"><div id="target-row"><a href="/c/${cid}">Ours</a></div><div id="foreign-row"><a href="/c/${foreign}">Other</a>${actionButton('foreign-action')}</div></nav>`);
 assert.equal(conversationActions(w.document,cid),null);
 const nested=actionsFixture(t,`<nav><div><div><span><a href="/c/${cid}">Ours</a></span></div></div><div><a href="/c/${foreign}">Other</a>${actionButton('foreign-action')}</div></nav>`);
 assert.equal(conversationActions(nested.document,cid),null);
});
test('skip, hash, query, external, content and header links to the target never borrow a neighbor action',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 const neighbor=`<div id="foreign-row"><a href="/c/${foreign}">Other</a>${actionButton('foreign-action')}</div>`;
 for(const link of [
  `<a href="#main">Skip to content</a>`,
  `<a href="/c/${cid}#main">Skip to target</a>`,
  `<a href="/c/${cid}?model=x">Query link</a>`,
  `<a href="https://example.com/c/${cid}">External</a>`,
  `<a href="https://chatgpt.com.evil.example/c/${cid}">Lookalike</a>`,
 ]){
  const w=actionsFixture(t,`<div id="shared">${link}${neighbor}</div>`);
  assert.equal(conversationActions(w.document,cid),null,link);
 }
 const content=actionsFixture(t,`<div id="shared"><main><p>See <a href="/c/${cid}">this chat</a></p></main>${neighbor}</div>`);
 assert.equal(conversationActions(content.document,cid),null);
 const header=actionsFixture(t,`<div id="shared"><header><a href="/c/${cid}">Current chat</a></header>${neighbor}</div>`);
 assert.equal(conversationActions(header.document,cid),null);
});
test('an ineligible hash or query link to a neighbor conversation still blocks borrowing that neighbor action',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 for(const href of [`/c/${foreign}#main`,`/c/${foreign}?model=x`]){
  const w=actionsFixture(t,`<nav id="shared"><div id="target-row"><a href="/c/${cid}">Ours</a></div><div id="foreign-row"><a href="${href}">Other</a>${actionButton('foreign-action')}</div></nav>`);
  assert.equal(conversationActions(w.document,cid),null,href);
 }
});
test('a non-conversation new chat or project anchor with a foreign action stops the unsafe climb',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 for(const other of [`<a href="/">New chat</a>`,`<a href="/g/${pid}/project">LocalGPT project</a>`]){
  const w=actionsFixture(t,`<nav id="shared"><div id="target-row"><a href="/c/${cid}">Ours</a></div><div id="other-row">${other}${actionButton('foreign-action')}</div></nav>`);
  assert.equal(conversationActions(w.document,cid),null,other);
  const flat=actionsFixture(t,`<nav id="shared"><div><a href="/c/${cid}">Ours</a></div>${other}${actionButton('foreign-action')}</nav>`);
  assert.equal(conversationActions(flat.document,cid),null,other);
 }
});
test('a skip link beside the real target row still selects only the real row action',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 const w=actionsFixture(t,`<div id="shared"><a href="/c/${cid}#main">Skip</a><div id="foreign-row"><a href="/c/${foreign}">Other</a>${actionButton('foreign-action')}</div><div id="target-row"><a href="/c/${cid}">Ours</a>${actionButton('target-action')}</div></div>`);
 assert.equal(conversationActions(w.document,cid),w.document.getElementById('target-action'));
});
test('duplicate anchors for one action dedupe while distinct target actions remain ambiguous',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 const same=actionsFixture(t,`<div id="target-row"><a href="/c/${cid}">Ours</a><a href="/c/${cid}">Ours again</a>${actionButton('target-action')}</div>`);
 assert.equal(conversationActions(same.document,cid),same.document.getElementById('target-action'));
 const distinct=actionsFixture(t,`<nav><div><a href="/c/${cid}">Ours</a>${actionButton('first-action')}</div><div><a href="/c/${cid}">Ours</a>${actionButton('second-action')}</div></nav>`);
 assert.throws(()=>conversationActions(distinct.document,cid),e=>e.code==='project_ambiguous');
});
test('project conversation links support an action nested inside the link',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 const w=actionsFixture(t,`<nav><a href="/g/${pid}-localgpt/c/${foreign}">Other${actionButton('foreign-action')}</a><a href="/g/${pid}-localgpt/c/${cid}">Ours${actionButton('target-action')}</a></nav>`);
 assert.equal(conversationActions(w.document,cid),w.document.getElementById('target-action'));
});
test('empty and whitespace hrefs never establish conversation action ownership',async t=>{
 const {conversationActions,conversationActionOwned}=await import('../src/browser-projects.ts');
 for(const href of ['', '   ']){
  const w=actionsFixture(t,`<div><a href="${href}">Not a conversation row</a>${actionButton('unknown-action')}</div>`);
  assert.equal(conversationActions(w.document,cid),null);
  assert.equal(conversationActionOwned(w.document,cid,w.document.getElementById('unknown-action')),false);
 }
});
test('project new-chat readiness waits for old history and refuses restored drafts',async t=>{
 const {openProjectChat}=await import('../src/browser-projects.ts');const w=fixture(t);
 w.document.body.insertAdjacentHTML('beforeend','<div data-message-author-role="user">Old</div><div role="textbox" contenteditable="true"></div>');
 w.document.querySelector('button').onclick=()=>w.history.pushState({},'',`/g/${pid}/project`);
 await assert.rejects(openProjectChat(w.document,'LocalGPT',pid,wait,Date.now()+40,()=>{}));
 w.document.querySelector('[data-message-author-role]').remove();w.document.querySelector('[role="textbox"]').textContent='Restored draft';
 await assert.rejects(openProjectChat(w.document,'LocalGPT',pid,wait,Date.now()+100,()=>{}),e=>e.code==='composer_not_empty');
});
const deepRow=(own,extra='')=>`<div id="wrapper5"><div role="listitem" id="item6"><div role="list" id="list7"><div id="foreign-rows"><a href="/c/${foreign}">Other</a>${actionButton('foreign-action')}</div><div id="target-rows"><div role="group" id="group4"><div id="d3"><div id="d2"><div id="d1"><a id="target-link" href="/c/${cid}">Ours</a></div></div></div>${own}</div></div>${extra}</div></div></div>`;
test('native depth-4 group row selects its own 20x20 actions button despite foreign rows above',async t=>{
 const {conversationActions,conversationActionOwned}=await import('../src/browser-projects.ts');
 const w=actionsFixture(t,deepRow(actionButton('target-action')));
 w.document.getElementById('target-action').getClientRects=()=>[{width:20,height:20}];
 assert.equal(conversationActions(w.document,cid),w.document.getElementById('target-action'));
 assert.equal(conversationActionOwned(w.document,cid,w.document.getElementById('target-action')),true);
 assert.equal(conversationActionOwned(w.document,cid,w.document.getElementById('foreign-action')),false);
});
test('native depth-4 group row without its own action never borrows a button higher up',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 const w=actionsFixture(t,deepRow('',actionButton('higher-action')));
 assert.equal(conversationActions(w.document,cid),null);
});
const chain=(k,extra='')=>{let html=`<a id="target-link" href="/c/${cid}">Ours</a>`;for(let j=1;j<=k;j++)html=`<div>${html}${j===k?extra:''}</div>`;return html;};
test('a semantic group/listitem row without its own action never borrows a higher unknown Chat actions button',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 const w=actionsFixture(t,`<div role="list"><div role="listitem"><div role="group">${chain(3)}</div></div>${actionButton('higher-unknown')}</div>`);
 assert.equal(conversationActions(w.document,cid),null);
});
test('the action search is capped at eight levels',async t=>{
 const {conversationActions,conversationActionOwned}=await import('../src/browser-projects.ts');
 const w=actionsFixture(t,chain(8,actionButton('ninth-level')));
 assert.equal(conversationActions(w.document,cid),null);
 assert.equal(conversationActionOwned(w.document,cid,w.document.getElementById('ninth-level')),false);
});
test('deep depth-4 structural ownership remains when a modal hides the row',async t=>{
 const {conversationActions,conversationActionOwned}=await import('../src/browser-projects.ts');
 const w=actionsFixture(t,`<div id="row">${chain(4,actionButton('target-action'))}</div>`);
 const button=w.document.getElementById('target-action');
 w.document.getElementById('row').setAttribute('aria-hidden','true');
 assert.equal(conversationActions(w.document,cid),null);
 assert.equal(conversationActionOwned(w.document,cid,button),true);
});
test('deep duplicate anchors dedupe the one action while distinct deep actions stay ambiguous',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 const same=actionsFixture(t,chain(4,`<a href="/c/${cid}">Again</a>${actionButton('target-action')}`));
 assert.equal(conversationActions(same.document,cid),same.document.getElementById('target-action'));
 const distinct=actionsFixture(t,`<nav>${chain(4,actionButton('first-action'))}${chain(4,actionButton('second-action'))}</nav>`);
 assert.throws(()=>conversationActions(distinct.document,cid),e=>e.code==='project_ambiguous');
});
test('foreign anchors at depth four through seven are boundaries, including hash and query links',async t=>{
 const {conversationActions}=await import('../src/browser-projects.ts');
 for(let k=4;k<=7;k++)for(const href of [`/c/${foreign}`,`/c/${foreign}#main`,`/c/${foreign}?model=x`]){
  const w=actionsFixture(t,chain(k,`<a href="${href}">Other</a>${actionButton('foreign-action')}`));
  assert.equal(conversationActions(w.document,cid),null,`${k} ${href}`);
 }
});

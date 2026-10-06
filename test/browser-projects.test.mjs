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
test('project new-chat readiness waits for old history and refuses restored drafts',async t=>{
 const {openProjectChat}=await import('../src/browser-projects.ts');const w=fixture(t);
 w.document.body.insertAdjacentHTML('beforeend','<div data-message-author-role="user">Old</div><div role="textbox" contenteditable="true"></div>');
 w.document.querySelector('button').onclick=()=>w.history.pushState({},'',`/g/${pid}/project`);
 await assert.rejects(openProjectChat(w.document,'LocalGPT',pid,wait,Date.now()+40,()=>{}));
 w.document.querySelector('[data-message-author-role]').remove();w.document.querySelector('[role="textbox"]').textContent='Restored draft';
 await assert.rejects(openProjectChat(w.document,'LocalGPT',pid,wait,Date.now()+100,()=>{}),e=>e.code==='composer_not_empty');
});

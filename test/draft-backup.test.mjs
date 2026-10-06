import {test,installNativeEditing} from './test-support.mjs';
import assert from 'node:assert/strict';
import {Window} from 'happy-dom';
import {DraftBackups,readPlainDraft,DRAFT_KEY} from '../src/draft-backup.ts';
const route='/c/6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
function fixture(t,html='<div role="textbox" contenteditable="true"></div>'){
 const w=new Window({url:`https://chatgpt.com${route}`});t.after(()=>w.close());w.document.body.innerHTML=html;installNativeEditing(w);
 return {w,doc:w.document,editor:w.document.querySelector('[role="textbox"],textarea'),backups:new DraftBackups(()=>w.sessionStorage)};
}
for(const html of ['<textarea></textarea>','<div role="textbox" contenteditable="true"></div>'])test('draft suspension preserves exact whitespace and newlines: '+html, t=>{
 const f=fixture(t,html);const text='  first\nsecond\n  ';
 if(f.editor.tagName==='TEXTAREA')f.editor.value=text;else f.editor.innerHTML='<p>  first</p><p>second</p><p>  </p>';
 assert.equal(readPlainDraft(f.editor),text);f.backups.suspend(f.doc,route);
 assert.equal(readPlainDraft(f.editor),'');assert.equal(f.backups.list()[0].text,text);
 assert.equal(f.backups.restore(f.doc,route),true);assert.equal(readPlainDraft(f.editor),text);assert.equal(f.backups.list().length,0);
});
test('storage failure and unsupported formatting leave draft intact',t=>{
 const f=fixture(t);f.editor.textContent='keep';const b=new DraftBackups(()=>({getItem:()=>null,setItem:()=>{throw Error('quota')}}));
 assert.throws(()=>b.suspend(f.doc,route),e=>e.code==='draft_storage_unavailable');assert.equal(f.editor.textContent,'keep');
 f.editor.innerHTML='<p><strong>rich</strong></p>';assert.throws(()=>f.backups.suspend(f.doc,route),e=>e.code==='draft_unsupported');assert.equal(f.editor.innerHTML,'<p><strong>rich</strong></p>');
});
test('failed native clear keeps a durable backup and never sends',t=>{
 const f=fixture(t);f.editor.textContent='keep';f.doc.execCommand=()=>false;
 assert.throws(()=>f.backups.suspend(f.doc,route),e=>e.code==='draft_clear_failed');assert.equal(f.editor.textContent,'keep');assert.equal(f.backups.list()[0].text,'keep');
});
test('navigation/reload and a new manual draft do not overwrite saved text',t=>{
 const f=fixture(t);f.editor.textContent='old';f.backups.suspend(f.doc,route);const reloaded=new DraftBackups(()=>f.w.sessionStorage);
 assert.equal(reloaded.restore(f.doc,'/'),false);f.editor.textContent='new';assert.equal(reloaded.restore(f.doc,route),false);
 assert.throws(()=>reloaded.suspend(f.doc,route),e=>e.code==='draft_backup_conflict');assert.equal(reloaded.list()[0].text,'old');assert.equal(f.editor.textContent,'new');
 f.editor.textContent=' ';assert.equal(reloaded.restore(f.doc,route),false);f.editor.textContent='';assert.equal(reloaded.restore(f.doc,route),true);assert.equal(f.editor.textContent,'old');
});
test('attachments, huge drafts and invalid stored records never clear the composer',t=>{
 const f=fixture(t,'<form><div role="textbox" contenteditable="true">keep</div><button aria-label="Remove file"></button></form>');
 assert.throws(()=>f.backups.suspend(f.doc,route),e=>e.code==='attachment_draft_present');f.doc.querySelector('button').remove();f.editor.textContent='x'.repeat(65537);
 assert.throws(()=>f.backups.suspend(f.doc,route),e=>e.code==='draft_too_large');assert.equal(f.editor.textContent.length,65537);
 f.w.sessionStorage.setItem(DRAFT_KEY,'broken');f.editor.textContent='keep';assert.throws(()=>f.backups.suspend(f.doc,route),e=>e.code==='draft_storage_unavailable');assert.equal(f.editor.textContent,'keep');
});
test('empty ProseMirror paragraphs and trailingBreak are interpreted without losing newlines',t=>{
 const f=fixture(t);f.editor.innerHTML='<p>a<br class="ProseMirror-trailingBreak"></p><p><br class="ProseMirror-trailingBreak"></p>';
 assert.equal(readPlainDraft(f.editor),'a\n');f.editor.innerHTML='<p><br></p>';assert.equal(readPlainDraft(f.editor),'');
});
test('editor focus changes never overwrite newer text during suspension or restoration',t=>{
 const f=fixture(t);f.editor.textContent='original';f.editor.addEventListener('focus',()=>f.editor.textContent='newer',{once:true});
 assert.throws(()=>f.backups.suspend(f.doc,route),e=>e.code==='draft_clear_failed');assert.equal(f.editor.textContent,'newer');assert.equal(f.backups.list()[0].text,'original');
 f.editor.blur();f.editor.textContent='';f.editor.addEventListener('focus',()=>f.editor.textContent='another',{once:true});assert.equal(f.backups.restore(f.doc,route),false);assert.equal(f.editor.textContent,'another');assert.equal(f.backups.list()[0].text,'original');
});
test('native input replacing the composer cannot erase the only saved draft',t=>{
 const f=fixture(t);f.editor.textContent='saved';f.backups.suspend(f.doc,route);
 f.editor.addEventListener('input',()=>{const newer=f.editor.cloneNode(false);newer.textContent='';f.editor.replaceWith(newer);},{once:true});
 assert.throws(()=>f.backups.restore(f.doc,route),e=>e.code==='draft_restore_failed');assert.equal(f.doc.querySelector('[role="textbox"]').textContent,'');assert.equal(f.backups.list()[0].text,'saved');
});
test('decorated empty ProseMirror paragraph does not block native submission',t=>{
 const f=fixture(t);f.editor.innerHTML='<p class="placeholder" data-placeholder="Ask anything"><br class="ProseMirror-trailingBreak"></p>';
 assert.equal(readPlainDraft(f.editor),'');f.backups.suspend(f.doc,route);assert.equal(f.backups.list().length,0);
});
test('current ChatGPT empty paragraph decoration does not block native submission',t=>{
 const f=fixture(t);f.editor.innerHTML='<p class="placeholder" data-empty-paragraph="" data-placeholder="Ask anything"><br class="ProseMirror-trailingBreak"></p>';
 assert.equal(readPlainDraft(f.editor),'');f.backups.suspend(f.doc,route);assert.equal(f.backups.list().length,0);
});
test('current ChatGPT true-valued empty paragraph decoration does not block native submission',t=>{
 const f=fixture(t);f.editor.innerHTML='<p class="placeholder" data-empty-paragraph="true" data-placeholder="Ask ChatGPT"><br class="ProseMirror-trailingBreak"></p>';
 assert.equal(readPlainDraft(f.editor),'');f.backups.suspend(f.doc,route);assert.equal(f.backups.list().length,0);
});
test('empty paragraph metadata with content remains unsupported',t=>{
 const f=fixture(t);f.editor.innerHTML='<p data-empty-paragraph="true" data-placeholder="Ask ChatGPT">keep</p>';const original=f.editor.innerHTML;
 assert.throws(()=>f.backups.suspend(f.doc,route),e=>e.code==='draft_unsupported');assert.equal(f.editor.innerHTML,original);assert.equal(f.backups.list().length,0);
});
test('nonempty data-empty-paragraph metadata remains unsupported',t=>{
 const f=fixture(t);f.editor.innerHTML='<p data-empty-paragraph="semantic" data-placeholder="Ask anything"><br class="ProseMirror-trailingBreak"></p>';const original=f.editor.innerHTML;
 assert.throws(()=>f.backups.suspend(f.doc,route),e=>e.code==='draft_unsupported');assert.equal(f.editor.innerHTML,original);assert.equal(f.backups.list().length,0);
});
test('plain decorated paragraphs suspend and restore exact text despite DOM separators',t=>{
 const f=fixture(t);f.editor.innerHTML='<p class="composer-paragraph" dir="auto">  first</p>\n  <p data-placeholder="Ask anything">second<br class="ProseMirror-trailingBreak"></p>\n<p><br class="ProseMirror-trailingBreak"></p>';
 const text='  first\nsecond\n';assert.equal(readPlainDraft(f.editor),text);f.backups.suspend(f.doc,route);
 assert.equal(f.backups.list()[0].text,text);assert.equal(readPlainDraft(f.editor),'');assert.equal(f.backups.restore(f.doc,route),true);assert.equal(readPlainDraft(f.editor),text);
});
test('ambiguous semantic paragraph metadata and wrapper nodes remain intact',t=>{
 const f=fixture(t);for(const html of ['<p style="white-space:pre">keep</p>','<p contenteditable="false">keep</p>','<p hidden>keep</p>','<p aria-hidden="true">keep</p>','<p>keep</p>extra','<div><p>keep</p></div>']){
 f.editor.innerHTML=html;const original=f.editor.innerHTML;assert.throws(()=>f.backups.suspend(f.doc,route),e=>e.code==='draft_unsupported');assert.equal(f.editor.innerHTML,original);assert.equal(f.backups.list().length,0);
 }
});

test('NBSP DOM separators and semantic inline content cannot be flattened',t=>{
 const f=fixture(t);for(const html of ['<p>a</p>&nbsp;<p>b</p>','<p onclick="run()">keep</p>','<p data-mention="user">keep</p>','<p><img src="x"></p>']){
 f.editor.innerHTML=html;const original=f.editor.innerHTML;assert.throws(()=>f.backups.suspend(f.doc,route),e=>e.code==='draft_unsupported');assert.equal(f.editor.innerHTML,original);assert.equal(f.backups.list().length,0);
 }
});
test('native clear verifies a recreated decorated placeholder before restoring',t=>{
 const f=fixture(t);f.editor.innerHTML='<p class="composer-paragraph">keep</p>';const native=f.doc.execCommand.bind(f.doc);
 f.doc.execCommand=(command,show,text)=>{const result=native(command,show,text);if(command==='delete')f.editor.innerHTML='<p class="placeholder" data-placeholder="Ask anything"><br class="ProseMirror-trailingBreak"></p>';return result;};
 f.backups.suspend(f.doc,route);assert.equal(readPlainDraft(f.editor),'');assert.equal(f.backups.list()[0].text,'keep');assert.equal(f.backups.restore(f.doc,route),true);assert.equal(readPlainDraft(f.editor),'keep');
});

test('unsupported draft diagnostics identify structure without exposing content or attribute values',t=>{
 const f=fixture(t);f.editor.innerHTML='<p class="private-class" data-new-attribute="private-value">private text</p><div title="private-title"><span>nested private text</span></div>';
 let error;assert.throws(()=>f.backups.suspend(f.doc,route),e=>{error=e;return e.code==='draft_unsupported';});
 assert.match(error.message,/reason=unexpected_paragraph_attribute/);assert.match(error.message,/path=root\[0\]/);assert.match(error.message,/node=P/);assert.match(error.message,/attrs=class,data-new-attribute/);
 for(const secret of ['private-class','private-value','private text','private-title','nested private text'])assert.equal(error.message.includes(secret),false);
 assert.ok(new TextEncoder().encode(error.message).length<=512);assert.equal(f.backups.list().length,0);
});

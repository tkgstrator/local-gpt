import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const choice={model:'test-thinking',version:'test',versionLabel:'GPT-Test',title:'Medium',effort:'standard',index:1,count:5};
async function fixture(t,{confirm=true,available=true}={}) {
 const page=new JSDOM('<button aria-label="Select ChatGPT model" aria-expanded="false"></button><div role="textbox" contenteditable="true">manual draft</div>',{url:'https://chatgpt.com/'});t.after(()=>page.window.close());
 const selector=page.window.document.querySelector('button');let calls=0;selector.onclick=()=>{throw Error('UI click must not run');};
 const props={selectedModel:{slug:'test-pro',thinkingEffort:null,versionId:'test'},models:{versionOptions:[{id:'test',slugs:['test-thinking'],options:[{slug:'test-thinking',thinkingEffort:'standard',isAvailable:available}]}]},onModelChange(value){calls++;if(confirm)props.selectedModel=value;}};
 selector.__reactFiber$fixture={memoizedProps:{},return:{memoizedProps:props,return:null}};
 const module=await import('../src/model-selection.ts');module.installNativeModelSelection(page.window);
 return {page,props,module,calls:()=>calls};
}
test('native JS callback switches model and effort once without touching menu or draft',async t=>{
 const f=await fixture(t);const result=await f.module.selectModel(f.page.window.document,{choices:[choice]},choice.model,'standard');
 assert.equal(result.model,choice.model);assert.deepEqual(f.props.selectedModel,{slug:'test-thinking',thinkingEffort:'standard',versionId:'test'});assert.equal(f.calls(),1);assert.equal(f.page.window.document.querySelector('[role="textbox"]').textContent,'manual draft');assert.equal(f.page.window.document.querySelector('button').getAttribute('aria-expanded'),'false');
});
test('unavailable choice and disabled native option fail before calling state setter',async t=>{
 const f=await fixture(t,{available:false});await assert.rejects(f.module.selectModel(f.page.window.document,{choices:[choice]},choice.model),e=>e.code==='model_unavailable');assert.equal(f.calls(),0);
 await assert.rejects(f.module.selectModel(f.page.window.document,{choices:[]},'missing'),e=>e.code==='model_unavailable');
});
test('missing native model state fails without UI fallback',async t=>{
 const f=await fixture(t);delete f.page.window.document.querySelector('button').__reactFiber$fixture;
 await assert.rejects(f.module.selectModel(f.page.window.document,{choices:[choice]},choice.model),e=>e.code==='native_model_selection_unavailable');assert.equal(f.calls(),0);
});
test('unchanged native selection is reported as failure rather than success',async t=>{
 const f=await fixture(t,{confirm:false});await assert.rejects(f.module.selectModel(f.page.window.document,{choices:[choice]},choice.model),e=>e.code==='model_selection_failed');assert.equal(f.calls(),1);
});

test('already selected model is confirmed without a second state update',async t=>{
 const f=await fixture(t);f.props.selectedModel={slug:choice.model,thinkingEffort:choice.effort,versionId:choice.version};await f.module.selectModel(f.page.window.document,{choices:[choice]},choice.model);assert.equal(f.calls(),0);
});
test('disabled selector is preserved without bypassing native controls',async t=>{
 const f=await fixture(t);f.page.window.document.querySelector('button').disabled=true;await assert.rejects(f.module.selectModel(f.page.window.document,{choices:[choice]},choice.model),e=>e.code==='native_model_selection_unavailable');assert.equal(f.calls(),0);
});

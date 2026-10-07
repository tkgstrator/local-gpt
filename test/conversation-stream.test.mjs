import {test} from './test-support.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const id='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
const user='f5eadb59-b96e-4ef5-9342-2f49d62b3c6f';
const assistant='094c6dd5-45d0-4da3-bd50-a79ef778addb';
const frame=(v,event='delta')=>`event: ${event}\r\ndata: ${JSON.stringify(v)}\r\n\r\n`;
const message=(channel='final',role='assistant',recipient='all')=>({id:assistant,author:{role},channel,recipient,content:{content_type:'text',parts:['']},status:'in_progress',end_turn:false});
const root=m=>({p:'',o:'add',v:{message:m,conversation_id:id,error:null},c:0});
const finish={p:'',o:'patch',v:[{p:'/message/status',o:'replace',v:'finished_successfully'},{p:'/message/end_turn',o:'replace',v:true}]};
const recapId='26fe0c08-9cf6-4b52-985e-36d368c27144';
async function observe(body,status=200,options){
 const {observeConversationResponse}=require('../dist/conversation-stream.cjs');const events=[];
 const bytes=new TextEncoder().encode(body);let n=0;
 const response=new Response(new ReadableStream({pull(c){if(n===bytes.length)c.close();else c.enqueue(bytes.slice(n,n+=Math.min(3,bytes.length-n)));}}),{status,headers:{'content-type':'text/event-stream'}});
 await observeConversationResponse(response,{requestId:'job',messageId:user,conversationId:null},e=>events.push(e),options);return events;
}
const recap=(channel,over={})=>{const m={...message(null),id:recapId,content:{content_type:'reasoning_recap',content:'Private recap sentinel'},status:'finished_successfully',end_turn:false,...over};if(channel===undefined)delete m.channel;else m.channel=channel;return m;};
test('SSE v1 reconstructs split UTF8, inherited deltas and batch patches with explicit completion',async()=>{
 const e=await observe(frame('v1','delta_encoding')+frame(root(message()))+frame({p:'/message/content/parts/0',o:'append',v:'日本'})+frame({v:'語'})+frame(finish)+'data: [DONE]\r\n\r\n');
 assert.deepEqual(e.filter(x=>x.kind==='answer').map(x=>x.text),['日本','日本語']);assert.equal(e.at(-1).kind,'stop');assert.equal(e.at(-1).conversationId,id);assert.equal(e.at(-1).messageId,user);assert.equal(JSON.stringify(e).includes('metadata'),false);
});
test('hidden thinking, tool and system messages never become response text',async()=>{
 for(const m of [message('analysis'),message('final','tool'),message('final','assistant','python'),{...message(),metadata:{is_visually_hidden_from_conversation:true}}]){
 const e=await observe(frame(root(m))+frame({p:'/message/content/parts/0',o:'append',v:'private'})+frame(finish)+'data: [DONE]\n\n');assert.equal(e.some(x=>x.kind==='answer'),false);assert.equal(e.at(-1).kind,'error');
 }
});
test('truncated streams, API errors, unknown encoding and HTTP errors never report completion',async()=>{
 const inputs=[frame(root(message()))+frame({p:'/message/content/parts/0',o:'append',v:'partial'}),frame({error:{message:'secret',code:'failed'}},'message'),frame('v2','delta_encoding'),frame(root(message()))+'data: [DONE]\n\n'];
 for(const body of inputs){const e=await observe(body);assert.equal(e.at(-1).kind,'error');assert.equal(e.some(x=>x.kind==='stop'),false);assert.equal(JSON.stringify(e).includes('secret'),false);}
 assert.equal((await observe('',429)).at(-1).code,'chatgpt_http_error');
});
test('legacy full message SSE snapshots are supported and require successful end_turn',async()=>{
 const m={...message(null),content:{content_type:'text',parts:['Legacy']},status:'finished_successfully',end_turn:true};
 const e=await observe(frame({message:m,conversation_id:id},'message')+'data: [DONE]\n\n');assert.equal(e.find(x=>x.kind==='answer').text,'Legacy');assert.equal(e.at(-1).kind,'stop');
});
test('prototype-changing paths fail safely without mutating global objects',async()=>{
 const e=await observe(frame(root(message()))+frame({p:'/__proto__/polluted',o:'add',v:true}));assert.equal(e.at(-1).kind,'error');assert.equal({}.polluted,undefined);
});
test('thinking stream identifies the conversation before any visible answer',async()=>{
 const {observeConversationResponse}=require('../dist/conversation-stream.cjs');const events=[];let controller;
 const response=new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode(frame(root(message('analysis')))));}}),{headers:{'content-type':'text/event-stream'}});
 const pending=observeConversationResponse(response,{requestId:'job',messageId:user,conversationId:null},e=>events.push(e));
 await new Promise(r=>setTimeout(r,10));const started=events.find(e=>e.kind==='started'&&e.conversationId===id);controller.close();await pending;
 assert.ok(started);assert.equal(events.some(e=>e.kind==='answer'),false);
});
test('generated image tool results produce image refs and complete without text, never echo input images',async()=>{
 const metadata={generation:{gen_id:'test-generation'}};
 const image={content_type:'image_asset_pointer',asset_pointer:'sediment://file_generated',metadata};
 const tool={id:assistant,author:{role:'tool'},recipient:'all',channel:null,content:{content_type:'multimodal_text',parts:[image]},status:'finished_successfully',end_turn:null};
 const context={...message(),content:{content_type:'model_editable_context',model_set_context:'private'}};
 const e=await observe(frame(root(context))+frame(root({...tool,author:{role:'user'}}))+frame(root(tool))+'data: [DONE]\n\n');
 assert.deepEqual(e.filter(x=>x.kind==='image_ref').map(x=>x.fileId),['file_generated']);assert.equal(e.at(-1).kind,'stop');assert.equal(e.some(x=>x.kind==='answer'),false);assert.equal(JSON.stringify(e).includes('private'),false);
});
test('incomplete images and ordinary tool image attachments are not accepted as generated results',async()=>{
 for(const m of [{status:'in_progress',meta:{generation:{gen_id:'g'}}},{status:'finished_successfully',meta:{}}]){
 const tool={id:assistant,author:{role:'tool'},content:{content_type:'multimodal_text',parts:[{content_type:'image_asset_pointer',asset_pointer:'sediment://file_other',metadata:m.meta}]},status:m.status};
 const e=await observe(frame(root(tool))+'data: [DONE]\n\n');assert.equal(e.some(x=>x.kind==='image_ref'),false);assert.equal(e.at(-1).kind,'error');
 }
});
test('mixed text and image outputs require every observed output to finish',async()=>{
 const tool={id:'0a4135fb-dc6d-4758-a3b8-de183e959a09',author:{role:'tool'},content:{content_type:'multimodal_text',parts:[{content_type:'image_asset_pointer',asset_pointer:'sediment://file_generated',metadata:{generation:{gen_id:'g'}}}]},status:'in_progress'};
 const completed={...message(),content:{content_type:'text',parts:['Done']},status:'finished_successfully',end_turn:true};
 const first=await observe(frame(root(tool))+frame(root(completed))+'data: [DONE]\n\n');assert.equal(first.at(-1).kind,'error');
 const second=await observe(frame(root({...tool,status:'finished_successfully'}))+frame(root({...completed,status:'in_progress',end_turn:false}))+'data: [DONE]\n\n');assert.equal(second.at(-1).kind,'error');
});
test('native reasoning progress exposes phase without leaking thinking text',async()=>{
 const reasoning={...message('analysis'),content:{content_type:'text',parts:['Private reasoning never export']}};
 const final={...message('final'),content:{content_type:'text',parts:['Final only']},status:'finished_successfully',end_turn:true};
 const events=await observe(frame(root(reasoning))+frame(root(final))+'data: [DONE]\n\n');
 assert.ok(events.some(e=>e.kind==='progress'&&e.phase==='thinking'));assert.ok(events.some(e=>e.kind==='progress'&&e.phase==='answering'));assert.equal(JSON.stringify(events).includes('Private reasoning'),false);assert.equal(events.at(-1).kind,'stop');
});
test('idle native stream becomes unknown/unresponsive without cancelling, and recovers on activity',async()=>{
 const {observeConversationResponse}=await import('../src/conversation-stream.ts');let controller;const events=[];
 const response=new Response(new ReadableStream({start(c){controller=c}}),{headers:{'content-type':'text/event-stream'}});
 const observing=observeConversationResponse(response,{requestId:'idle',messageId:user,conversationId:null},e=>events.push(e),{timeoutMs:300,idleTimeoutMs:20});
 controller.enqueue(new TextEncoder().encode(frame(root(message('analysis')))));
 await new Promise(r=>setTimeout(r,50));assert.ok(events.some(e=>e.kind==='progress'&&e.phase==='unresponsive'));assert.equal(events.some(e=>e.kind==='error'),false);
 controller.enqueue(new TextEncoder().encode(frame(root({...message(),content:{content_type:'text',parts:['Recovered']},status:'finished_successfully',end_turn:true}))+'data: [DONE]\n\n'));controller.close();await observing;
 assert.equal(events.at(-1).kind,'stop');assert.ok(events.find(e=>e.kind==='progress'&&e.phase==='answering'));
});
test('explicit native failed and cancelled statuses are distinct from silence and timeouts',async()=>{
 for(const [status,code] of [['cancelled','chatgpt_generation_cancelled'],['failed','chatgpt_generation_failed']]){
  const events=await observe(frame(root({...message('final'),status}))+'data: [DONE]\n\n');assert.equal(events.at(-1).kind,'error');assert.equal(events.at(-1).code,code);
 }
});

test('failed hidden reasoning and tool steps do not fail a later successful final answer',async()=>{
 for(const intermediate of [message('analysis'),message('final','assistant','python'),message('final','tool'),{...message(),metadata:{is_visually_hidden_from_conversation:true}}]){
  intermediate.status='failed';intermediate.content.parts=['Private intermediate failure'];
  const final={...message(),content:{content_type:'text',parts:['Successful final answer']},status:'finished_successfully',end_turn:true};
  const events=await observe(frame(root(intermediate))+frame(root(final))+'data: [DONE]\n\n');
  assert.equal(events.at(-1).kind,'stop');assert.equal(events.some(e=>e.kind==='error'),false);assert.equal(JSON.stringify(events).includes('Private intermediate'),false);
 }
});

test('successful reasoning recap intermediates are neither output nodes nor exported before the real final',async()=>{
 for(const channel of [null,undefined]){
  const final={...message(),content:{content_type:'text',parts:['Final answer only']},status:'finished_successfully',end_turn:true};
  const nodes=[];
  const events=await observe(frame(root(recap(channel)))+frame(root(final))+'data: [DONE]\n\n',200,{onOutputNode:id=>nodes.push(id)});
  assert.equal(events.at(-1).kind,'stop');assert.equal(events.some(e=>e.kind==='error'),false);
  assert.deepEqual(events.filter(e=>e.kind==='answer').map(e=>e.text),['Final answer only']);
  assert.deepEqual(nodes,[assistant]);assert.equal(JSON.stringify(events).includes('Private recap sentinel'),false);
 }
});

test('a reasoning recap alone never completes the native stream',async()=>{
 for(const channel of [null,undefined]) for(const end_turn of [false,true]){
  const nodes=[];
  const events=await observe(frame(root(recap(channel,{end_turn})))+'data: [DONE]\n\n',200,{onOutputNode:id=>nodes.push(id)});
  assert.equal(events.at(-1).kind,'error');assert.equal(events.some(e=>e.kind==='stop'||e.kind==='answer'),false);
  assert.deepEqual(nodes,[]);assert.equal(JSON.stringify(events).includes('Private recap sentinel'),false);
 }
});

const deltaRecap=(status='finished_successfully')=>frame(root({...message(null),id:recapId,content:{content_type:'reasoning_recap',content:''},status:'in_progress',end_turn:false}))+frame({p:'/message/content/content',o:'append',v:'Private recap '})+frame({v:'sentinel'})+frame({p:'',o:'patch',v:[{p:'/message/content/content',o:'append',v:' tail'},{p:'/message/status',o:'replace',v:status}]});
const realFinal=()=>frame(root({...message(),content:{content_type:'text',parts:['Final answer only']},status:'finished_successfully',end_turn:true}));
test('delta v1 reasoning recap patches that omit content type are never answers, output nodes or exports',async()=>{
 const nodes=[];
 const events=await observe(frame('v1','delta_encoding')+deltaRecap()+realFinal()+'data: [DONE]\n\n',200,{onOutputNode:id=>nodes.push(id)});
 assert.equal(events.at(-1).kind,'stop');assert.equal(events.some(e=>e.kind==='error'),false);
 assert.deepEqual(events.filter(e=>e.kind==='answer').map(e=>e.text),['Final answer only']);
 assert.deepEqual(nodes,[assistant]);assert.equal(JSON.stringify(events).includes('Private recap'),false);
});
test('failed or cancelled reasoning recap does not fail a later successful final',async()=>{
 for(const status of ['failed','cancelled']){
  const events=await observe(frame('v1','delta_encoding')+deltaRecap(status)+realFinal()+'data: [DONE]\n\n');
  assert.equal(events.at(-1).kind,'stop',status);assert.equal(events.some(e=>e.kind==='error'),false,status);
  assert.deepEqual(events.filter(e=>e.kind==='answer').map(e=>e.text),['Final answer only']);assert.equal(JSON.stringify(events).includes('Private recap'),false);
 }
});
test('a reasoning recap after a successful final cannot reset stream completion',async()=>{
 for(const status of ['in_progress','finished_successfully','failed','cancelled']){
  const nodes=[];
  const events=await observe(frame('v1','delta_encoding')+realFinal()+deltaRecap(status)+'data: [DONE]\n\n',200,{onOutputNode:id=>nodes.push(id)});
  assert.equal(events.at(-1).kind,'stop',status);assert.equal(events.some(e=>e.kind==='error'),false,status);
  assert.deepEqual(events.filter(e=>e.kind==='answer').map(e=>e.text),['Final answer only']);assert.deepEqual(nodes,[assistant]);assert.equal(JSON.stringify(events).includes('Private recap'),false);
 }
});
test('a malformed actual final after a reasoning recap is still a failure',async()=>{
 const final={...message(),content:{content_type:'code',parts:['terminal output']},status:'finished_successfully',end_turn:true};
 const events=await observe(frame(root(recap(null)))+frame(root(final))+'data: [DONE]\n\n');
 assert.equal(events.at(-1).kind,'error');assert.equal(events.some(e=>e.kind==='stop'),false);assert.equal(JSON.stringify(events).includes('Private recap sentinel'),false);
});

test('background observation has no wall deadline; synchronous observation does',async()=>{
 const {observeConversationResponse}=await import('../src/conversation-stream.ts');
 const run=async backgroundJob=>{let controller;const events=[];const response=new Response(new ReadableStream({start(c){controller=c}}),{headers:{'content-type':'text/event-stream'}});
  const observing=observeConversationResponse(response,{requestId:'timeout',messageId:user,conversationId:id},e=>events.push(e),{backgroundJob,timeoutMs:20,idleTimeoutMs:1000});
  await new Promise(r=>setTimeout(r,60));const timedOut=events.some(e=>e.kind==='error'&&e.code==='response_stream_timeout');
  try{controller.enqueue(new TextEncoder().encode(frame(root({...message(),content:{content_type:'text',parts:['Late']},status:'finished_successfully',end_turn:true}))+'data: [DONE]\n\n'));controller.close();}catch{}
  await observing;return {timedOut,events};};
 const background=await run(true);assert.equal(background.timedOut,false);assert.equal(background.events.at(-1).kind,'stop');assert.equal((await run(false)).timedOut,true);
});

test('shared image classifier accepts generated tool markers and rejects uploads and ordinary tool attachments', async () => {
 const stream = await import('../src/conversation-stream.ts');
 const tool = { id: assistant, author: { role: 'tool' }, status: 'finished_successfully', content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_generated', metadata: { generation: { gen_id: 'g' } } }] } };
 assert.deepEqual(stream.classifyGeneratedImageMessage?.(tool), { id: assistant, fileIds: ['file_generated'], complete: true, error: null });
 const task = { ...tool, metadata: { async_task_type: 'image_gen' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file_second' }] } };
 assert.deepEqual(stream.classifyGeneratedImageMessage(task), { id: assistant, fileIds: ['file_second'], complete: true, error: null });
 for (const m of [{ ...tool, author: { role: 'user' } }, { ...tool, author: { role: 'tool', name: 'python' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_chart' }] } }]) assert.equal(stream.classifyGeneratedImageMessage(m), null);
 assert.equal(stream.classifyGeneratedImageMessage({ ...task, content: { content_type: 'audio', parts: [] } }).error, 'unsupported_image_asset');
 assert.equal(stream.classifyGeneratedImageMessage({ ...tool, status: 'in_progress' }).complete, false);
 assert.equal(stream.classifyGeneratedImageMessage({ ...tool, status: 'cancelled' }).error, 'image_generation_failed');
 assert.equal(stream.classifyGeneratedImageMessage({ ...task, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'https://example.com/file_second' }] } }).error, 'unsupported_image_asset');
});

test('marked failed or cancelled image tasks cannot become mixed text success with unsupported content', async () => {
 const { classifyGeneratedImageMessage, observeConversationResponse } = await import('../src/conversation-stream.ts');
 for (const status of ['failed', 'cancelled']) for (const content of [undefined, {content_type:'text',parts:['Tool failure']}, {content_type:'audio',parts:[]}]) {
  const tool = {id:assistant,author:{role:'tool'},metadata:{async_task_type:'image_gen'},status,content};
  assert.equal(classifyGeneratedImageMessage(tool)?.error, 'image_generation_failed');
  const events=[];
  const final={...message(),id:user,status:'finished_successfully',end_turn:true,content:{content_type:'text',parts:['Later assistant text']}};
  await observeConversationResponse(new Response(frame(root(tool))+frame(root(final))+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}),{requestId:'shape',messageId:user,conversationId:null},e=>events.push(e));
  assert.equal(events.at(-1)?.code,'image_generation_failed');assert.equal(events.some(e=>e.kind==='stop'),false);
 }
});

test('a malformed generated pointer beside a valid one cannot produce partial image success', async () => {
 const {classifyGeneratedImageMessage,observeConversationResponse}=await import('../src/conversation-stream.ts');
 for (const asset_pointer of [undefined,null,12,'sediment://invalid']) {
  const tool={id:assistant,author:{role:'tool'},metadata:{async_task_type:'image_gen'},status:'finished_successfully',content:{content_type:'multimodal_text',parts:[{content_type:'image_asset_pointer',asset_pointer:'sediment://file_valid'},{content_type:'image_asset_pointer',asset_pointer}]}};
  assert.equal(classifyGeneratedImageMessage(tool)?.error,'unsupported_image_asset');
  const events=[];const final={...message(),id:user,status:'finished_successfully',end_turn:true,content:{content_type:'text',parts:['Later text']}};
  await observeConversationResponse(new Response(frame(root(tool))+frame(root(final))+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}),{requestId:'shape',messageId:user,conversationId:null},e=>events.push(e));
  assert.equal(events.at(-1)?.code,'unsupported_image_asset');assert.equal(events.some(e=>e.kind==='stop'||e.kind==='image_ref'),false);
 }
});

test('empty assistant wrappers do not add separators to mixed SSE text and images', async () => {
 const {observeConversationResponse}=await import('../src/conversation-stream.ts');
 const tool={id:'0a4135fb-dc6d-4758-a3b8-de183e959a09',author:{role:'tool'},metadata:{async_task_type:'image_gen'},status:'finished_successfully',content:{content_type:'multimodal_text',parts:[{content_type:'image_asset_pointer',asset_pointer:'file-service://file_generated'}]}};
 const first={...message(),content:{content_type:'text',parts:['Explanation']},status:'finished_successfully',end_turn:false};
 const empty={...first,id:user,content:{content_type:'text',parts:['']},end_turn:true};
 const events=[];
 await observeConversationResponse(new Response(frame(root(first))+frame(root(tool))+frame(root(empty))+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}),{requestId:'empty',messageId:user,conversationId:null},e=>events.push(e));
 assert.equal(events.filter(e=>e.kind==='answer').at(-1)?.text,'Explanation');assert.equal(events.at(-1)?.kind,'stop');assert.equal(events.filter(e=>e.kind==='image_ref').length,1);
 const later={...first,id:user,content:{content_type:'text',parts:['Answer']},end_turn:true};const earlyEmpty={...empty,id:assistant,end_turn:false};const second=[];
 await observeConversationResponse(new Response(frame(root(earlyEmpty))+frame(root(later))+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}),{requestId:'empty-first',messageId:user,conversationId:null},e=>second.push(e));
 assert.equal(second.filter(e=>e.kind==='answer').at(-1)?.text,'Answer');assert.equal(second.at(-1)?.kind,'stop');
});

test('unfinished empty assistant stubs remain relevant outputs in the native stream', async () => {
 const {observeConversationResponse}=await import('../src/conversation-stream.ts');const events=[];
 const early={...message(),content:{content_type:'text',parts:['']}};
 const final={...message(),id:user,status:'finished_successfully',end_turn:true,content:{content_type:'text',parts:['Final']}};
 await observeConversationResponse(new Response(frame(root(early))+frame(root(final))+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}),{requestId:'unfinished-empty',messageId:user,conversationId:null},e=>events.push(e));
 assert.equal(events.at(-1)?.code,'response_incomplete');assert.equal(events.some(e=>e.kind==='stop'),false);
});

test('generation or dalle marked non-image parts forbid partial success beside a valid pointer', async () => {
 const {classifyGeneratedImageMessage,observeConversationResponse}=await import('../src/conversation-stream.ts');
 for (const name of ['generation','dalle']) for (const content_type of ['text','audio',undefined]) for (const messageMarker of [true,false]) {
  const valid={content_type:'image_asset_pointer',asset_pointer:'file-service://file_valid',metadata:{generation:{gen_id:'g'}}};
  const bad={content_type,text:'Private marker payload',metadata:{[name]:{}}};
  const tool={id:assistant,author:{role:'tool'},metadata:messageMarker?{async_task_type:'image_gen'}:{},status:'finished_successfully',content:{content_type:'multimodal_text',parts:[valid,bad]}};
  assert.equal(classifyGeneratedImageMessage(tool)?.error,'unsupported_image_asset');
  const events=[];const final={...message(),id:user,status:'finished_successfully',end_turn:true,content:{content_type:'text',parts:['Later final']}};
  await observeConversationResponse(new Response(frame(root(tool))+frame(root(final))+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}),{requestId:'marked-part',messageId:user,conversationId:null},e=>events.push(e));
  assert.equal(events.at(-1)?.code,'unsupported_image_asset');assert.equal(events.some(e=>e.kind==='image_ref'||e.kind==='stop'),false);
  assert.equal(JSON.stringify(events).includes('Private marker payload'),false);
 }
});

const thoughtsId='7d0f4f0e-2a61-4a4e-9a52-0f6a3a9b1c11';
const thoughts=(channel,over={})=>{const m={...message(null),id:thoughtsId,content:{content_type:'thoughts',thoughts:[{summary:'Private thoughts sentinel',content:'Private thoughts sentinel'}]},status:'finished_successfully',end_turn:false,...over};if(channel===undefined)delete m.channel;else m.channel=channel;return m;};
const finalMessage=()=>({...message(),content:{content_type:'text',parts:['Final answer only']},status:'finished_successfully',end_turn:true});
const noPrivate=events=>{const s=JSON.stringify(events);assert.equal(s.includes('Private thoughts sentinel'),false);assert.equal(s.includes('Private recap sentinel'),false);};
test('native thoughts then reasoning recap then final exports only the final and its node',async()=>{
 for(const channel of [null,undefined]){
  const nodes=[];
  const events=await observe(frame(root(thoughts(channel)))+frame(root(recap(channel)))+frame(root(finalMessage()))+'data: [DONE]\n\n',200,{onOutputNode:id=>nodes.push(id)});
  assert.equal(events.at(-1).kind,'stop');assert.equal(events.some(e=>e.kind==='error'),false);
  assert.deepEqual(events.filter(e=>e.kind==='answer').map(e=>e.text),['Final answer only']);
  assert.deepEqual(nodes,[assistant]);noPrivate(events);
 }
});
test('thoughts in any status never fail or complete the stream before a successful final',async()=>{
 for(const status of ['finished_successfully','in_progress','failed','cancelled']){
  const nodes=[];
  const events=await observe(frame(root(thoughts(null,{status})))+frame(root(recap(null)))+frame(root(finalMessage()))+'data: [DONE]\n\n',200,{onOutputNode:id=>nodes.push(id)});
  assert.equal(events.at(-1).kind,'stop',status);assert.equal(events.some(e=>e.kind==='error'),false,status);
  assert.deepEqual(events.filter(e=>e.kind==='answer').map(e=>e.text),['Final answer only'],status);
  assert.deepEqual(nodes,[assistant],status);noPrivate(events);
 }
});
test('delta v1 thoughts patches that omit content type are never answers, output nodes or exports',async()=>{
 for(const status of ['finished_successfully','failed','cancelled']){
  const nodes=[];
  const thoughtsFrames=frame(root({...thoughts(null),content:{content_type:'thoughts',thoughts:[]},status:'in_progress'}))+frame({p:'/message/content/thoughts',o:'append',v:[{summary:'Private thoughts ',content:'Private thoughts sentinel'}]})+frame({v:[{summary:'Private thoughts sentinel'}]})+frame({p:'',o:'patch',v:[{p:'/message/content/thoughts/0/content',o:'append',v:' tail'},{p:'/message/status',o:'replace',v:status}]});
  const events=await observe(frame('v1','delta_encoding')+thoughtsFrames+deltaRecap()+realFinal()+'data: [DONE]\n\n',200,{onOutputNode:id=>nodes.push(id)});
  assert.equal(events.at(-1).kind,'stop',status);assert.equal(events.some(e=>e.kind==='error'),false,status);
  assert.deepEqual(events.filter(e=>e.kind==='answer').map(e=>e.text),['Final answer only'],status);
  assert.deepEqual(nodes,[assistant],status);noPrivate(events);assert.equal(JSON.stringify(events).includes('Private thoughts'),false);
 }
});
test('a thoughts-only current node never completes the native stream',async()=>{
 for(const channel of [null,undefined]) for(const end_turn of [false,true]){
  const nodes=[];
  const events=await observe(frame(root(thoughts(channel,{id:assistant,end_turn})))+'data: [DONE]\n\n',200,{onOutputNode:id=>nodes.push(id)});
  assert.equal(events.at(-1).kind,'error');assert.equal(events.some(e=>e.kind==='stop'||e.kind==='answer'),false);
  assert.deepEqual(nodes,[]);noPrivate(events);
 }
});

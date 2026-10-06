import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require=createRequire(import.meta.url); const {WebSocket}=require('ws');
const conversationId='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
const projectId='g-p-0123456789abcdef0123456789abcdef';
async function setup(t, sessionsFile) {
  const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1000,sessionsFile});
  const ports=await service.start(); t.after(()=>service.close()); const base=`http://127.0.0.1:${ports.httpPort}`;
  const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?browserId=project-owner`); await once(ws,'open');
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const start=async(path,body)=>{const next=once(ws,'message');const response=post(path,body);return {request:JSON.parse((await next)[0]),response};};
  const send=value=>ws.send(JSON.stringify(value));
  return {base,ws,post,start,send};
}
test('sessions default to LocalGPT and bind only after confirmed project membership',async t=>{
  const {base,post,start,send}=await setup(t);
  const session=await(await post('/v1/sessions',{})).json(); assert.equal(session.projectName,'LocalGPT'); assert.equal(session.projectId,null);
  const first=await start('/v1/responses',{session_id:session.id,input:'Review'}); assert.equal(first.request.projectName,'LocalGPT');
  send({type:'answer',requestId:first.request.requestId,text:'Reviewed'}); send({type:'stop',requestId:first.request.requestId,conversationId});
  const rejected=await first.response; assert.equal(rejected.status,502); assert.equal((await rejected.json()).error.code,'project_unconfirmed');
  const second=await start('/v1/responses',{session_id:session.id,input:'Review again'});
  send({type:'answer',requestId:second.request.requestId,text:'Reviewed'}); send({type:'stop',requestId:second.request.requestId,conversationId,projectId});
  assert.equal((await second.response).status,200);
  const stored=(await(await fetch(base+'/v1/sessions')).json()).data.find(s=>s.id===session.id); assert.equal(stored.projectId,projectId); assert.equal(stored.conversationId,conversationId);
  const continuation=await start('/v1/responses',{session_id:session.id,input:'Continue'}); assert.equal(continuation.request.projectId,projectId);
  send({type:'stop',requestId:continuation.request.requestId,conversationId,projectId:'g-p-abcdef0123456789abcdef0123456789'});
  const mismatch=await continuation.response; assert.equal(mismatch.status,502); assert.equal((await mismatch.json()).error.code,'project_mismatch');
});
test('explicit project migration confirms exact conversation and blocks other browser tasks',async t=>{
  const {base,ws,post,start,send}=await setup(t);
  const session=await(await post('/v1/sessions',{})).json();
  const unbound=await post('/v1/sessions/project',{session_id:session.id}); assert.equal(unbound.status,200); assert.equal((await unbound.json()).conversationId,null);
  const bind=await start('/v1/responses',{session_id:session.id,input:'Bind'}); send({type:'stop',requestId:bind.request.requestId,conversationId,projectId}); assert.equal((await bind.response).status,200);
  const move=await start('/v1/sessions/project',{session_id:session.id}); assert.equal(move.request.type,'move_conversation'); assert.equal(move.request.projectName,'LocalGPT'); assert.equal(move.request.conversationId,conversationId); assert.equal(move.request.projectId,projectId);
  const blocked=await fetch(base+'/v1/capabilities'); assert.equal(blocked.status,409); assert.equal((await blocked.json()).error.code,'browser_busy');
  const ready=once(ws,'message'); send({type:'navigate',requestId:move.request.requestId,conversationId}); assert.equal(JSON.parse((await ready)[0]).type,'navigation_ready');
  send({type:'conversation_project',requestId:move.request.requestId,conversationId,projectId});
  const moved=await move.response; assert.equal(moved.status,200); const metadata=await moved.json(); assert.equal(metadata.projectId,projectId); assert.equal(metadata.conversationId,conversationId);
  const wrong=await start('/v1/sessions/project',{session_id:session.id}); send({type:'conversation_project',requestId:wrong.request.requestId,conversationId:'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4',projectId}); assert.equal((await wrong.response).status,502);
  const deletion=await start('/v1/sessions/delete',{session_id:session.id}); assert.equal(deletion.request.projectId,projectId); send({type:'conversation_deleted',requestId:deletion.request.requestId,conversationId}); assert.equal((await deletion.response).status,200);
});
test('project opt-out preserves ordinary chats and cannot silently enable migration',async t=>{
  const {post,start,send}=await setup(t);
  const session=await(await post('/v1/sessions',{projectName:null})).json(); assert.equal(session.projectName,null);
  const generation=await start('/v1/responses',{session_id:session.id,input:'Ordinary'}); assert.equal(generation.request.projectName,undefined);
  send({type:'stop',requestId:generation.request.requestId,conversationId}); assert.equal((await generation.response).status,200);
  const move=await post('/v1/sessions/project',{session_id:session.id}); assert.equal(move.status,400); assert.equal((await move.json()).error.code,'project_target_disabled');
});
test('MCP migrates a pre-existing bound LocalGPT session and exposes routing instructions',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'localgpt-project-')); t.after(()=>rm(dir,{recursive:true,force:true})); const path=join(dir,'sessions.sqlite');
  const store=require('../dist/sessions.cjs').createSessionStore(path); const old=store.create({title:'Existing task'}); store.bind(old.id,conversationId); store.close();
  const {base,ws,send}=await setup(t,path);
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js'); const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client=new Client({name:'project-test',version:'1'}); t.after(()=>client.close()); await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
  assert.match(client.getInstructions(),/one at a time service-wide/); assert.match(client.getInstructions(),/Never autonomously use Computer Use/);
  assert.ok((await client.listTools()).tools.some(tool=>tool.name==='localgpt_session_project'));
  const next=once(ws,'message'); const result=client.callTool({name:'localgpt_session_project',arguments:{session_id:old.id}}); const move=JSON.parse((await next)[0]);
  assert.equal(move.conversationId,conversationId); assert.equal(move.projectName,'LocalGPT'); send({type:'conversation_project',requestId:move.requestId,conversationId,projectId});
  const migrated=await result; assert.notEqual(migrated.isError,true); assert.equal(migrated.structuredContent.projectId,projectId); assert.equal(migrated.structuredContent.conversationId,conversationId);
});

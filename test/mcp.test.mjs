import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const require=createRequire(import.meta.url);const {WebSocket}=require('ws');
async function fixture(t,mode){const {createService}=require('../dist/server.cjs');const service=createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1000});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
 const client=new Client({name:'localgpt-test',version:'1.0.0'});
 const transport=mode==='stdio'?new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp-stdio.mjs')],env:{LOCALGPT_URL:base},stderr:'pipe'}):new StreamableHTTPClientTransport(new URL(base+'/mcp'));
 await client.connect(transport);t.after(()=>client.close());return{base,client,ports};}
for(const mode of ['stdio','http']) test(`MCP ${mode} initializes, lists tools, reads status/models and generates through browser bridge`,async t=>{
 const {client,ports}=await fixture(t,mode);assert.match(client.getInstructions(),/session_id/);assert.match(client.getInstructions(),/LocalGPT controls/);const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name).sort(),['localgpt_capabilities','localgpt_dot_messages','localgpt_dot_select','localgpt_dot_send','localgpt_dots','localgpt_models','localgpt_respond','localgpt_response_get','localgpt_response_start','localgpt_session_create','localgpt_sessions','localgpt_status']);
 const status=await client.callTool({name:'localgpt_status',arguments:{}});assert.equal(status.structuredContent.browserConnected,false);
 const missing=await client.callTool({name:'localgpt_models',arguments:{}});assert.equal(missing.isError,true);assert.match(missing.content[0].text,/browser_disconnected/);
 const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');ws.on('message',raw=>{const r=JSON.parse(raw);if(r.type==='capabilities')ws.send(JSON.stringify({type:'capabilities',requestId:r.requestId,models:[],plan:'pro',observedAt:new Date().toISOString(),source:'chatgpt_api',selectionSupported:false}));else if(r.type==='models')ws.send(JSON.stringify({type:'models',requestId:r.requestId,models:['Observed model'],selected:'Observed model',source:'visible_ui'}));else {assert.equal(r.text,'MCP text');ws.send(JSON.stringify({type:'answer',requestId:r.requestId,text:'MCP reply'}));ws.send(JSON.stringify({type:'stop',requestId:r.requestId,...(r.conversationId?{conversationId:r.conversationId}:{conversationId:'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3'})}));}});
 const models=await client.callTool({name:'localgpt_models',arguments:{}});assert.equal(models.structuredContent.selected,'Observed model');assert.equal(models.structuredContent.canSelect,false);
 const capabilities=await client.callTool({name:'localgpt_capabilities',arguments:{}});assert.equal(capabilities.structuredContent.plan,'pro');assert.equal(capabilities.structuredContent.source,'chatgpt_api');
 const invalid=await client.callTool({name:'localgpt_respond',arguments:{input:' '}});assert.equal(invalid.isError,true);
 const created=await client.callTool({name:'localgpt_session_create',arguments:{title:'MCP topic'}});assert.equal(created.isError,undefined);const sessionId=created.structuredContent.id;const listing=await client.callTool({name:'localgpt_sessions',arguments:{}});assert.equal(listing.structuredContent.data[0].id,sessionId);
 const sessionReply=await client.callTool({name:'localgpt_respond',arguments:{input:'MCP text',session_id:sessionId}});assert.equal(sessionReply.structuredContent.session_id,sessionId);
 const generated=await client.callTool({name:'localgpt_respond',arguments:{input:'MCP text'}});assert.equal(generated.isError,undefined);assert.equal(generated.structuredContent.output[0].content[0].text,'MCP reply');
});
test('MCP HTTP rejects foreign origins and hosts',async t=>{const {base}=await fixture(t,'http');for(const headers of [{Origin:'https://evil.example'},{Host:'evil.example'}])assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{}'})).status,403);});
test('stdio base URL refuses arbitrary external destinations',()=>{const {localApiBase}=require('../dist/mcp.cjs');for(const url of ['https://example.com','http://example.com','http://127.0.0.1:8766/private','http://user:secret@localhost:8766'])assert.throws(()=>localApiBase(url),/loopback/);assert.equal(localApiBase('http://127.0.0.1:8766'),'http://127.0.0.1:8766');});

test('shared HTTP API and private distribution bundles reject foreign hosts and origins',async t=>{
 const {base}=await fixture(t,'http');
 for(const path of ['/v1/responses','/v1/chat/completions','/v1/models','/v1/capabilities','/userscript','/extension','/health']) {
  const method=path==='/v1/responses'||path==='/v1/chat/completions'?'POST':'GET';
  for(const headers of [{Host:'evil.example'},{Origin:'https://evil.example'}])assert.equal((await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},...(method==='POST'?{body:'{}'}:{})})).status,403);
 }
});

import {test} from './test-support.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from 'node:http';
import {z} from 'zod';
const require=createRequire(import.meta.url);
test('LocalMCP proxy preserves schemas, annotations, authentication and results without browser requests',async t=>{
 let calls=0; const http=createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer test-token-at-least-16'){res.writeHead(401);res.end();return;}
 const upstream=new McpServer({name:'LocalMCP',version:'test'});
 upstream.registerTool('read_file',{description:'Read a file',inputSchema:{path:z.string().min(1)},annotations:{readOnlyHint:true,openWorldHint:false}},async args=>{calls++;return {content:[{type:'text',text:`read:${args.path}`}],structuredContent:{path:args.path}};});
 upstream.registerTool('execute',{inputSchema:{command:z.string()}},async()=>({content:[{type:'text',text:'shell'}]}));
 upstream.registerTool('unexpected_tool',{inputSchema:{}},async()=>({content:[{type:'text',text:'hidden'}]}));
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});res.on('close',()=>{void transport.close();void upstream.close();});await upstream.connect(transport);await transport.handleRequest(req,res);
 });await new Promise(r=>http.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{http.close(r);http.closeAllConnections();}));
 const config={url:`http://127.0.0.1:${http.address().port}/local`,token:'test-token-at-least-16'};
 const server=require('../dist/mcp.cjs').createMcpServer('http://127.0.0.1:8766');
 const {attachLocalMcpTools}=require('../src/localmcp.ts');await attachLocalMcpTools(server,config);t.after(()=>server.close());
 const client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(()=>client.close());
 const names=(await client.listTools()).tools;assert.ok(names.some(t=>t.name==='localmcp_read_file'&&t.annotations.readOnlyHint));assert.ok(names.some(t=>t.name==='localmcp_execute'));assert.ok(!names.some(t=>t.name==='localmcp_unexpected_tool'));
 assert.equal((await client.callTool({name:'localmcp_read_file',arguments:{path:'src/test.ts'}})).structuredContent.path,'src/test.ts');
 assert.equal((await client.callTool({name:'localmcp_read_file',arguments:{path:4}})).isError,true);assert.equal(calls,1);
 assert.equal((await client.callTool({name:'localmcp_status',arguments:{}})).structuredContent.connected,true);
});
test('LocalMCP config validates endpoint and does not disclose credentials',()=>{
 const {readLocalMcpConfig}=require('../src/localmcp.ts');
 assert.equal(readLocalMcpConfig({}),undefined);
 assert.throws(()=>readLocalMcpConfig({LOCALMCP_URL:'http://example.com/local',LOCALMCP_TOKEN:'secret'}));
 assert.throws(()=>readLocalMcpConfig({LOCALMCP_URL:'http://127.0.0.1:8876/local'}));
 assert.throws(()=>readLocalMcpConfig({LOCALMCP_URL:'http://localhost:8766/mcp',LOCALMCP_TOKEN:'test-token-at-least-16'}));
});

test('unavailable LocalMCP keeps LocalGPT available and never exposes its token in status',async t=>{
 const http=createServer((_req,res)=>{res.writeHead(401);res.end('private token');});await new Promise(r=>http.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{http.close(r);http.closeAllConnections();}));
 const server=require('../dist/mcp.cjs').createMcpServer('http://127.0.0.1:8766');t.after(()=>server.close());
 const {attachLocalMcpTools}=require('../src/localmcp.ts');const upstream=await attachLocalMcpTools(server,{url:`http://127.0.0.1:${http.address().port}/local`,token:'private-token-value'});t.after(()=>upstream.close());
 assert.equal(upstream.status().connected,false);assert.equal(upstream.status().error,'localmcp_unavailable');assert.equal(JSON.stringify(upstream.status()).includes('private-token-value'),false);
 const client=new Client({name:'test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(()=>client.close());
 const names=(await client.listTools()).tools.map(t=>t.name);assert.ok(names.includes('localgpt_respond'));assert.ok(names.includes('localmcp_status'));assert.ok(!names.includes('localmcp_write_file'));
});

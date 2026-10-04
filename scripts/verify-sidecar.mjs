import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync('dist/mcp-config-fused.json','utf8')).mcpServers.localgpt;
const client=new Client({name:'LocalGPT-sidecar-verification',version:'1'});
await client.connect(new StdioClientTransport({...config,stderr:'pipe'}));
try {
 const listed=await client.listTools();const toolNames=listed.tools.map(t=>t.name);assert.ok(toolNames.includes('localgpt_respond'));assert.ok(toolNames.includes('localmcp_read_file'));
 const status=await client.callTool({name:'localmcp_status',arguments:{}});assert.equal(status.structuredContent.connected,true);
 const path='localgpt-verification/sidecar-test.txt';
 async function call(name,args){const result=await client.callTool({name:`localmcp_${name}`,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return result;}
 await call('write_file',{path,content:'LocalGPT + LocalMCP: BEFORE\n'});
 await call('edit_file',{path,old_text:'BEFORE',new_text:'AFTER'});
 const read=await call('read_file',{path});assert.match(read.content[0].text,/AFTER/);
 const search=await call('search',{pattern:'AFTER',path:'localgpt-verification'});assert.match(search.content[0].text,/sidecar-test/);
 const outside=await client.callTool({name:'localmcp_read_file',arguments:{path:'../outside-workspace.txt'}});assert.equal(outside.isError,true);
 const executed=await call('execute',{command:'printf LOCALMCP_EXEC_OK'});assert.match(executed.content[0].text,/LOCALMCP_EXEC_OK/);
 console.log(JSON.stringify({gateway:'stdio',tools:toolNames,writeEditReadSearch:'passed',outsideRootRejected:true,shell:'passed',chatgptPlugin:'not_verified'},null,2));
} finally {await client.close();}

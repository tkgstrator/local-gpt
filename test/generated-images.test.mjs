import {test} from './test-support.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('generated images persist with a stable URL and host path across restarts',async t=>{
 const {createImageStore}=require('../dist/generated-images.cjs');const dir=await mkdtemp(join(tmpdir(),'localgpt-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const fetcher=async(url,opts)=>{assert.equal(new URL(url).hostname,'test.oaiusercontent.com');assert.equal(opts.redirect,'error');return new Response(png,{headers:{'content-type':'image/png'}});};
 const store=createImageStore(dir,'/host/generated',fetcher);const image=await store.save('file_generated','https://test.oaiusercontent.com/image?sig=test');assert.match(image.path,/^\/host\/generated\/[a-f0-9-]+\.png$/);assert.equal(image.bytes,png.length);assert.equal(image.mimeType,'image/png');
 const restarted=createImageStore(dir,'/host/generated',fetcher);const loaded=restarted.read(image.id);assert.deepEqual(await readFile(loaded.file),png);assert.equal(JSON.stringify(loaded.metadata).includes('sig='),false);assert.equal(restarted.read('../secrets'),null);
});
test('image store rejects private URLs, redirects, disguised content and oversized downloads',async t=>{
 const {createImageStore}=require('../dist/generated-images.cjs');const dir=await mkdtemp(join(tmpdir(),'localgpt-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));let calls=0;
 const store=createImageStore(dir,undefined,async()=>{calls++;return new Response('<svg/>',{headers:{'content-type':'image/png'}});});
 for(const url of ['http://127.0.0.1/private','https://evil.test/a','https://oaiusercontent.com.evil.test/a','https://user:password@x.oaiusercontent.com/a'])await assert.rejects(store.save('file_generated',url));assert.equal(calls,0);
 await assert.rejects(store.save('file_generated','https://x.oaiusercontent.com/a'));
 const large=createImageStore(dir,undefined,async()=>new Response(png,{headers:{'content-type':'image/png','content-length':'99999999'}}));await assert.rejects(large.save('file_generated','https://x.oaiusercontent.com/a'));
});
test('HTTP image-only responses persist files and retain them after conversation deletion',async t=>{
 const {createService}=require('../dist/server.cjs'),{WebSocket}=require('ws');const {once}=await import('node:events');
 const dir=await mkdtemp(join(tmpdir(),'localgpt-api-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const service=createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1000,imagesDir:dir,imageFetcher:async()=>new Response(png,{headers:{'content-type':'image/png'}})});const ports=await service.start();t.after(()=>service.close());
 const base=`http://127.0.0.1:${ports.httpPort}`,cid='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');
 ws.on('message',raw=>{const r=JSON.parse(raw);if(r.type==='delete_conversation'){ws.send(JSON.stringify({type:'conversation_deleted',requestId:r.requestId,conversationId:cid}));return;}ws.send(JSON.stringify({type:'image',requestId:r.requestId,conversationId:cid,fileId:'file_generated',downloadUrl:'https://x.oaiusercontent.com/image?sig=test'}));ws.send(JSON.stringify({type:'stop',requestId:r.requestId,conversationId:cid}));});
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const s=await (await post('/v1/sessions',{title:'image',projectName:null})).json();const response=await post('/v1/responses',{input:'image',session_id:s.id});assert.equal(response.status,200);const result=await response.json();assert.equal(result.status,'completed');assert.equal(result.images.length,1);assert.deepEqual(Buffer.from(await (await fetch(base+result.images[0].url)).arrayBuffer()),png);assert.equal(JSON.stringify(result).includes('sig='),false);
 assert.equal((await post('/v1/sessions/delete',{session_id:s.id})).status,200);assert.equal((await fetch(base+result.images[0].url)).status,200);
});
test('MCP returns generated image pixels with persistent file metadata',async t=>{
 const {createService}=require('../dist/server.cjs'),{WebSocket}=require('ws');const {once}=await import('node:events');const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const dir=await mkdtemp(join(tmpdir(),'localgpt-mcp-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const service=createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1000,imagesDir:dir,imageFetcher:async()=>new Response(png,{headers:{'content-type':'image/png'}})});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
 const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');ws.on('message',raw=>{const r=JSON.parse(raw);ws.send(JSON.stringify({type:'image',requestId:r.requestId,conversationId:'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3',fileId:'file_generated',imageData:{mimeType:'image/png',data:png.toString('base64')}}));ws.send(JSON.stringify({type:'stop',requestId:r.requestId,conversationId:'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3'}));});
 const client=new Client({name:'image-test',version:'1'});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
 const result=await client.callTool({name:'localgpt_respond',arguments:{input:'generate'}});assert.equal(result.isError,undefined);const image=result.content.find(c=>c.type==='image');assert.equal(image?.mimeType,'image/png');assert.equal(image?.data,png.toString('base64'));assert.equal(result.structuredContent.images.length,1);assert.ok(result.structuredContent.images[0].path.startsWith(dir));
});

test('native image bytes persist without a server-side authenticated fetch',async t=>{
 const {createImageStore}=require('../dist/generated-images.cjs');const dir=await mkdtemp(join(tmpdir(),'native-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=createImageStore(dir,undefined,()=>{throw Error('Must not fetch');});
 const image=await store.saveData('file_native',{mimeType:'image/png',data:png.toString('base64')});assert.deepEqual(await readFile(store.read(image.id).file),png);
 await assert.rejects(store.saveData('file_bad',{mimeType:'image/jpeg',data:png.toString('base64')}));
});

test('native image validation accepts a valid payload at the full 8 MiB limit without overflowing',async t=>{
 const {createImageStore}=require('../dist/generated-images.cjs');const dir=await mkdtemp(join(tmpdir(),'large-native-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bytes=Buffer.alloc(8*1024*1024);png.copy(bytes,0);const store=createImageStore(dir);
 const image=await store.saveData('file_large',{mimeType:'image/png',data:bytes.toString('base64')});assert.equal(image.bytes,bytes.length);
 await assert.rejects(store.saveData('file_too_large',{mimeType:'image/png',data:Buffer.concat([bytes,Buffer.from([0])]).toString('base64')}));
});
test('HTTP bridge accepts native image payloads larger than the normal API request limit',async t=>{
 const {createService}=require('../dist/server.cjs');const dir=await mkdtemp(join(tmpdir(),'native-http-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const service=createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:5000,bridgeToken:'native-test',imagesDir:dir});const ports=await service.start();t.after(()=>service.close());const base=`http://127.0.0.1:${ports.httpPort}`;
 const bridge=(path,body)=>fetch(base+'/bridge/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'native-test','X-Browser-Id':'native-tab'},body:JSON.stringify(body)});
 await bridge('poll',{});const result=fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'generate'})});
 let request;for(let i=0;i<100&&!request;i++){request=(await (await bridge('poll',{})).json()).request;await new Promise(r=>setTimeout(r,10));}assert.ok(request);
 const bytes=Buffer.alloc(1024*1024);png.copy(bytes);const cid='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
 assert.equal((await bridge('event',{type:'image',requestId:request.requestId,conversationId:cid,fileId:'file_http',imageData:{mimeType:'image/png',data:bytes.toString('base64')}})).status,200);
 await bridge('event',{type:'stop',requestId:request.requestId,conversationId:cid});const response=await result;assert.equal(response.status,200);assert.equal((await response.json()).images[0].bytes,bytes.length);
});

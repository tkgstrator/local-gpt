import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { once } from 'node:events';
const require=createRequire(import.meta.url);
test('automatic file references contain paths and instructions without reading private file contents',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'localgpt-files-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=join(dir,'example.ts'),image=join(dir,'example.png');await writeFile(source,'PRIVATE SOURCE BODY: const answer = 42;');await writeFile(image,Buffer.from([137,80,78,71]));
 const {loadFiles,filePrompt}=await import('../src/attachments.ts');const files=loadFiles([{path:source,mode:'auto'},{path:image,mode:'auto'},{path:'/only-on-localmcp/project/missing.pdf',mode:'auto'}]);
 assert.deepEqual(files,[{mode:'reference',path:source},{mode:'reference',path:image},{mode:'reference',path:'/only-on-localmcp/project/missing.pdf'}]);
 const prompt=filePrompt(files);assert.ok(prompt.includes(JSON.stringify(source)));assert.match(prompt,/LocalMCP/);assert.equal(prompt.includes('PRIVATE SOURCE BODY'),false);assert.equal(prompt.includes('const answer'),false);assert.equal(JSON.stringify(files).includes('base64'),false);
 assert.deepEqual(loadFiles([{path:dir,mode:'auto'}]),[{mode:'reference',path:dir}]);
});
test('inline text mode is rejected before touching an unavailable host path',async()=>{
 const {loadFiles}=await import('../src/attachments.ts');assert.throws(()=>loadFiles([{path:'/only-on-localmcp/private.txt',mode:'text'}]),/LocalMCP/);
});
test('only explicit uploads read local bytes and retain file type and size limits',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'localgpt-uploads-'));t.after(()=>rm(dir,{recursive:true,force:true}));const {loadFiles,filePrompt}=await import('../src/attachments.ts');
 const source=join(dir,'code.ts'),image=join(dir,'image.png'),pdf=join(dir,'doc.pdf');await writeFile(source,'const ok = true;');await writeFile(image,Buffer.from([137,80,78,71]));await writeFile(pdf,'%PDF-1.4');
 const files=loadFiles([{path:source,mode:'upload'},{path:image,mode:'upload'},{path:pdf,mode:'upload'}]);assert.deepEqual(files.map(f=>f.mode),['upload','upload','upload']);assert.deepEqual(files.map(f=>f.mime),['text/plain','image/png','application/pdf']);assert.equal(Buffer.from(files[0].base64,'base64').toString(),'const ok = true;');assert.equal(filePrompt(files),'');
 assert.throws(()=>loadFiles([{path:dir,mode:'upload'}]),/regular file/);assert.throws(()=>loadFiles([{path:join(dir,'missing'),mode:'upload'}]));
 const invalid=join(dir,'invalid.bin');await writeFile(invalid,Buffer.from([255,0]));assert.throws(()=>loadFiles([{path:invalid,mode:'upload'}]));
 const huge=join(dir,'huge.log');await writeFile(huge,Buffer.alloc(8*1024*1024+1));assert.throws(()=>loadFiles([{path:huge,mode:'upload'}]),/8 MiB/);
 const large=join(dir,'large.pdf');await writeFile(large,Buffer.alloc(6*1024*1024));assert.throws(()=>loadFiles([{path:large,mode:'upload'},{path:large,mode:'upload'},{path:large,mode:'upload'}]),/16 MiB/);
});
test('Responses sends LocalMCP references and uploads only explicitly selected files',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'localgpt-files-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=join(dir,'example.ts'),image=join(dir,'example.png');await writeFile(source,'PRIVATE SOURCE BODY');await writeFile(image,Buffer.from([137,80,78,71]));
 const service=require('../dist/server.cjs').createService({host:'127.0.0.1',httpPort:0,wsPort:0,timeoutMs:1000});const ports=await service.start();t.after(()=>service.close());const {WebSocket}=require('ws');const ws=new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);await once(ws,'open');
 const seen=[];ws.on('message',raw=>{const r=JSON.parse(raw);seen.push(r);ws.send(JSON.stringify({type:'answer',requestId:r.requestId,text:'File received'}));ws.send(JSON.stringify({type:'stop',requestId:r.requestId}));});const base=`http://127.0.0.1:${ports.httpPort}`;
 const post=files=>fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'Review files',files})});
 assert.equal((await post([{path:source},{path:image,mode:'upload'}])).status,200);assert.match(seen[0].text,/LocalMCP/);assert.ok(seen[0].text.includes(JSON.stringify(source)));assert.equal(seen[0].text.includes('PRIVATE SOURCE BODY'),false);assert.equal(seen[0].files.length,1);assert.equal(seen[0].files[0].name,'example.png');
 assert.equal((await post([{path:'/only-on-localmcp/missing.txt'}])).status,200);assert.ok(seen[1].text.includes('/only-on-localmcp/missing.txt'));assert.equal(seen[1].files,undefined);
 const inline=await post([{path:source,mode:'text'}]);assert.equal(inline.status,400);assert.equal((await inline.json()).error.code,'invalid_attachment');
});
test('browser file upload targets the active form and waits for the removal chip and completed progress',async t=>{
 const page=new Window();t.after(()=>page.close());page.document.body.innerHTML='<form hidden><input type="file" aria-label="Attach files"></form><form id="active"><div role="textbox" contenteditable="true">Review</div><input type="file" aria-label="Attach files" multiple><button aria-label="Send" disabled></button></form>';const form=page.document.querySelector('#active');form.querySelector('input').addEventListener('change',()=>{form.insertAdjacentHTML('beforeend','<button aria-label="Remove example.png">example.png</button><span role="progressbar"></span>');setTimeout(()=>{form.querySelector('[role="progressbar"]').remove();form.querySelector('[aria-label="Send"]').disabled=false;},100);});let checks=0;await require('../dist/browser-files.cjs').attachFiles(page.document,[{name:'example.png',mime:'image/png',base64:'iVBORw=='}],()=>checks++);assert.ok(checks>1);assert.equal(form.querySelector('input').files[0].name,'example.png');assert.equal(page.document.querySelector('form[hidden] input').files.length,0);await assert.rejects(require('../dist/browser-files.cjs').attachFiles(page.document,[{name:'second.png',mime:'image/png',base64:'iVBORw=='}],()=>{}),/Manual attachments/);
});

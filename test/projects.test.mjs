import {test} from './test-support.mjs';
import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionStore,CreateSessionSchema} from '../src/sessions.ts';
const cid='6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
const pid='g-p-0123456789abcdef0123456789abcdef';
test('project routes distinguish project IDs, conversation IDs and provisional IDs',async()=>{
 const {parseChatRoute,conversationPath,projectPath,ProjectIdSchema}=await import('../src/projects.ts');
 assert.deepEqual(parseChatRoute(`/c/${cid}`),{projectId:null,conversationId:cid,provisionalId:null});
 assert.deepEqual(parseChatRoute(`/g/${pid}-localgpt/project`),{projectId:pid,conversationId:null,provisionalId:null});
 assert.deepEqual(parseChatRoute(`/g/${pid}/c/${cid}`),{projectId:pid,conversationId:cid,provisionalId:null});
 assert.deepEqual(parseChatRoute(`/g/${pid}-localgpt/c/${cid}`),{projectId:pid,conversationId:cid,provisionalId:null});
 assert.deepEqual(parseChatRoute(`/c/local-chatgpt%3A${cid}`),{projectId:null,conversationId:null,provisionalId:cid});
 assert.deepEqual(parseChatRoute(`/g/${pid}-localgpt/c/local-chatgpt%3A${cid}`),{projectId:pid,conversationId:null,provisionalId:cid});
 assert.equal(conversationPath(cid,pid),`/g/${pid}/c/${cid}`);assert.equal(conversationPath(cid),`/c/${cid}`);assert.equal(projectPath(pid),`/g/${pid}/project`);
 for(const value of ['g-p-0123456789abcdef0123456789abcde','g-p-0123456789ABCDEF0123456789abcdef','g-0123456789abcdef0123456789abcdef'])assert.equal(ProjectIdSchema.safeParse(value).success,false);
 for(const path of [`/g/${pid}/anything`,`/c/${cid}/extra`,`/dots/${cid}`,`/c/not-a-uuid`,`https://chatgpt.com/c/${cid}`,`/g/${pid}/c/${cid}?x=1`,`/c/local-chatgpt%3Anot-a-uuid`])assert.equal(parseChatRoute(path),null,path);
 assert.throws(()=>conversationPath('other',pid));assert.throws(()=>projectPath('../private'));
});
test('new sessions default to LocalGPT grouping and allow explicit opt out',()=>{
 const store=createSessionStore();try{
 assert.equal(CreateSessionSchema.parse({}).projectName,'LocalGPT');
 assert.equal(store.create({}).projectName,'LocalGPT');assert.equal(store.create({}).projectId,null);
 assert.equal(store.create({projectName:null}).projectName,null);
 assert.throws(()=>store.create({projectName:' '}));
 }finally{store.close();}
});
test('explicit project moves preserve the known project identity in the browser protocol',async()=>{
 const {BrowserRequestSchema}=await import('../src/protocol.ts');
 const parsed=BrowserRequestSchema.parse({type:'move_conversation',requestId:'move',conversationId:cid,projectName:'LocalGPT',projectId:pid});
 assert.equal(parsed.projectId,pid);
});
test('legacy SQLite sessions migrate grouping without changing bound conversation IDs',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'localgpt-projects-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'sessions.sqlite');
 const old=new Database(path);old.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, conversationId TEXT, model TEXT, effort TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)');
 old.query('INSERT INTO sessions VALUES (?, ?, ?, NULL, NULL, ?, ?)').run(cid,'Existing work',cid,'2026-01-01','2026-01-01');old.close();
 let store=createSessionStore(path);assert.equal(store.get(cid).conversationId,cid);assert.equal(store.get(cid).projectName,'LocalGPT');assert.equal(store.get(cid).projectId,null);
 store.setProject(cid,'LocalGPT',pid);assert.equal(store.get(cid).conversationId,cid);assert.equal(store.get(cid).projectId,pid);
 assert.throws(()=>store.bind(cid,'6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4'));assert.throws(()=>store.setProject(cid,'LocalGPT','invalid-project'));
 assert.equal(store.get(cid).conversationId,cid);assert.equal(store.get(cid).projectId,pid);
 const created=store.create({projectName:'Other'});assert.equal(created.projectName,'Other');assert.equal(created.projectId,null);
 store.close();store=createSessionStore(path);try{assert.equal(store.get(cid).conversationId,cid);assert.equal(store.get(cid).projectId,pid);assert.equal(store.get(created.id).projectName,'Other');}finally{store.close();}
});

import {Database} from 'bun:sqlite';
import {existsSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const source=resolve('.localgpt-sessions.sqlite');
if(!existsSync(source)){console.log('No existing host sessions to migrate.');process.exit(0);}
const snapshot=source+'.migration';
const db=new Database(source,{readonly:true});
const count=db.query('SELECT COUNT(*) AS count FROM sessions').get().count;
writeFileSync(snapshot,db.serialize(),{mode:0o600});db.close();
const copy='import{existsSync,copyFileSync,chmodSync}from"node:fs";import{Database}from"bun:sqlite";const path="/var/lib/localgpt/sessions.sqlite";if(existsSync(path))throw Error("Target sessions database already exists; refusing to overwrite");const source=new Database("/import/sessions.sqlite",{readonly:true});const count=source.query("SELECT COUNT(*) AS count FROM sessions").get().count;source.close();copyFileSync("/import/sessions.sqlite",path);chmodSync(path,0o600);console.log(`Migrated ${count} sessions`);';
const result=spawnSync('docker',['compose','--env-file','.localmcp.env','run','--rm','--no-deps','-v',`${snapshot}:/import/sessions.sqlite:ro`,'localgpt','bun','-e',copy],{stdio:'inherit'});
if(result.status!==0)throw Error('Session migration failed; existing target was not overwritten. The private snapshot remains for recovery.');
unlinkSync(snapshot);console.log(`Preserved ${count} existing host session IDs.`);

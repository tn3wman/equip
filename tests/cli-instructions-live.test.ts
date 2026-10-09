import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
const exec=promisify(execFile);

test('the bundled CLI detects instruction locations, syncs the same global policy, and reports native receipts',async t=>{
 const root=await mkdtemp(join(tmpdir(),'equip-instructions-cli-'));const {app,close}=await createApp({dataDir:join(root,'data'),autoUpdateIntervalMs:0});const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base='http://127.0.0.1:'+(server.address() as any).port;
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await close();await rm(root,{recursive:true,force:true});});
 let cookie='';
 async function post(path:string,body:unknown){const r=await fetch(base+'/api'+path,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(body)});cookie=r.headers.get('set-cookie')?.split(';')[0]??cookie;const b=await r.json();assert.ok(r.ok,JSON.stringify(b));return b;}
 await post('/auth/register',{name:'CLI instruction owner',email:'cli-instructions@example.test',password:'a private test password'});
 const homes=[];
 for(const name of ['First','Second']) {
  const home=join(root,name),state=join(home,'equip');await mkdir(join(home,'.claude'),{recursive:true});await mkdir(join(home,'.codex'));await mkdir(state);
  const a=await post('/device/authorize',{name,os:'linux',arch:'arm64'});await post('/device/approve',{userCode:a.userCode});const d=await post('/device/token',{deviceCode:a.deviceCode});
  await writeFile(join(state,'state.json'),JSON.stringify({token:d.token,deviceId:d.deviceId,server:base,name,autoDetect:true,targets:[]}),{mode:0o600});homes.push({home,state,deviceId:d.deviceId});
 }
 const draft=await post('/instructions',{title:'Shared instructions',filename:'AGENTS.md',scope:'global',files:[{path:'AGENTS.md',content:'# Shared rules\n\nRun focused tests.\n'}]});const published=await post('/instructions/'+draft.id+'/publish',{expectedRevision:''});
 for(const {home,state} of homes) await exec(process.execPath,[resolve('dist/equip.cjs'),'sync'],{env:{...process.env,EQUIP_HOME:state,EQUIP_AGENT_HOME:home,EQUIP_SKILLS_ROOT:resolve('node_modules/skills'),EQUIP_NO_SERVICE:'1'},timeout:10000});
 for(const {home} of homes){assert.equal(await readFile(join(home,'.claude/CLAUDE.md'),'utf8'),published.files[0].content);assert.equal(await readFile(join(home,'.codex/AGENTS.md'),'utf8'),published.files[0].content);}
 let w=await(await fetch(base+'/api/workspace',{headers:{cookie}})).json();assert.ok(w.devices.every((d:any)=>d.instructionLocations.length===2&&d.receipts.length===2&&d.receipts.every((r:any)=>r.kind==='instructions'&&r.status==='synchronized'&&r.revision===published.revision)));
 const [first,second]=homes;
 const enabled=await fetch(base+'/api/devices/'+first.deviceId+'/local-sync',{method:'PATCH',headers:{'content-type':'application/json',cookie},body:JSON.stringify({enabled:true})});assert.ok(enabled.ok,await enabled.text());
 const localContent='# Shared rules\n\nRun focused tests after local edits.\n';
 await rm(join(first.home,'.claude/CLAUDE.md'));await symlink(join(first.home,'.codex/AGENTS.md'),join(first.home,'.claude/CLAUDE.md'));
 await writeFile(join(first.home,'.codex/AGENTS.md'),localContent);
 await exec(process.execPath,[resolve('dist/equip.cjs'),'sync'],{env:{...process.env,EQUIP_HOME:first.state,EQUIP_AGENT_HOME:first.home,EQUIP_SKILLS_ROOT:resolve('node_modules/skills'),EQUIP_NO_SERVICE:'1'},timeout:10000});
 const updated=await(await fetch(base+'/api/instructions/'+draft.id,{headers:{cookie}})).json();
 assert.notEqual(updated.revision,published.revision);assert.equal(updated.files[0].content,localContent);assert.equal(updated.versions[0].revision,updated.revision);assert.match(updated.versions[0].message,/Published local edit from First/);
 await exec(process.execPath,[resolve('dist/equip.cjs'),'sync'],{env:{...process.env,EQUIP_HOME:second.state,EQUIP_AGENT_HOME:second.home,EQUIP_SKILLS_ROOT:resolve('node_modules/skills'),EQUIP_NO_SERVICE:'1'},timeout:10000});
 assert.equal(await readFile(join(second.home,'.claude/CLAUDE.md'),'utf8'),localContent);assert.equal(await readFile(join(second.home,'.codex/AGENTS.md'),'utf8'),localContent);
 w=await(await fetch(base+'/api/workspace',{headers:{cookie}})).json();
 for(const device of w.devices){assert.equal(device.appliedGeneration,w.generation);assert.equal(device.localSync?.error??null,null);assert.equal(device.receipts.length,2);assert.ok(device.receipts.every((r:any)=>r.kind==='instructions'&&r.status==='synchronized'&&r.revision===updated.revision));}
 await exec(process.execPath,[resolve('dist/equip.cjs'),'disconnect','--remove'],{env:{...process.env,EQUIP_HOME:first.state,EQUIP_AGENT_HOME:first.home,EQUIP_SKILLS_ROOT:resolve('node_modules/skills'),EQUIP_NO_SERVICE:'1'},timeout:10000});
 assert.equal(await lstat(join(first.home,'.claude/CLAUDE.md')).catch(()=>null),null);
 assert.equal(await lstat(join(first.home,'.codex/AGENTS.md')).catch(()=>null),null);
 assert.equal(await readFile(join(homes[1].home,'.claude/CLAUDE.md'),'utf8'),localContent);
});

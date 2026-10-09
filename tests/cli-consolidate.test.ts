import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { consolidate } from '../cli/consolidate.ts';
import type { DesiredState, Skill, SkillFile } from '../shared/types.ts';

function skill(name='fixture'):Skill {
  const files=[{path:'SKILL.md',content:`---\nname: ${name}\ndescription: Fixture\n---\n`}];
  return {id:`skill_${name}`,name,title:name,description:'Fixture',author:'Test',source:'custom',kind:'custom',category:'Custom',icon:'package',color:'#000',selected:true,enabled:true,autoUpdate:false,revision:'revision',versions:[],files,requirements:[],targets:[],updatedAt:new Date().toISOString()};
}

const desired=(item:Skill):DesiredState=>({generation:1,skills:[item],resolutions:{}});

async function fixture(t:any) {
  const root=await mkdtemp(join(tmpdir(),'equip-consolidate-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'state');const agentHome=join(root,'agent-home');
  await mkdir(home,{recursive:true});await mkdir(agentHome,{recursive:true});
  return {root,home,agentHome};
}

test('legacy backups are durably archived before their folders are deleted',async t=>{
  const {home,agentHome}=await fixture(t);const item=skill();
  const folder=join(home,'backups','1700000000000-fixture-conflict');
  await mkdir(join(folder,'generated'),{recursive:true});
  await writeFile(join(folder,'SKILL.md'),item.files[0].content);
  await writeFile(join(folder,'generated','state.json'),'generated\n');
  let existedDuringArchive=false;let archived:SkillFile[]=[];
  const result=await consolidate(home,agentHome,desired(item),async payload=>{
    existedDuringArchive=Boolean(await lstat(folder).catch(()=>null));archived=payload.files;
  });
  assert.equal(existedDuringArchive,true);
  assert.deepEqual(new Set(archived.map(file=>file.path)),new Set(['SKILL.md','generated/state.json']));
  assert.equal(await lstat(folder).catch(()=>null),null);
  assert.equal(await lstat(join(home,'backups')).catch(()=>null),null);
  assert.deepEqual(result,{linked:0,archived:1,removedBackups:1,errors:[]});
});

test('a failed legacy backup archive retains the only copy',async t=>{
  const {home,agentHome}=await fixture(t);const item=skill();
  const folder=join(home,'backups','1700000000000-fixture-conflict');
  await mkdir(folder,{recursive:true});await writeFile(join(folder,'SKILL.md'),item.files[0].content);
  const result=await consolidate(home,agentHome,desired(item),async()=>{throw new Error('server unavailable');});
  assert.equal(await readFile(join(folder,'SKILL.md'),'utf8'),item.files[0].content);
  assert.equal(result.archived,0);assert.equal(result.removedBackups,0);
  assert.match(result.errors[0],/server unavailable/);
});

test('the standard managed skill root becomes one canonical link and archives generated files',async t=>{
  const {home,agentHome}=await fixture(t);const item=skill();
  const shared=join(agentHome,'.agents','skills',item.name);
  const canonical=join(home,'skills',item.name);
  await mkdir(join(shared,'.generated'),{recursive:true});await mkdir(canonical,{recursive:true});
  await writeFile(join(shared,'SKILL.md'),item.files[0].content);
  await writeFile(join(shared,'.generated','cache.bin'),Buffer.from([0,255,1]));
  await writeFile(join(canonical,'SKILL.md'),item.files[0].content);
  await writeFile(join(home,'ledger.json'),JSON.stringify({installs:{managed:{skillId:item.id,path:shared,canonicalPath:canonical,revision:item.revision,files:{}}}}));
  let archived:SkillFile[]=[];
  const result=await consolidate(home,agentHome,desired(item),async payload=>{archived=payload.files;});
  assert.equal(result.linked,1);assert.equal((await lstat(shared)).isSymbolicLink(),true);
  assert.equal(await realpath(shared),await realpath(canonical));
  assert.deepEqual((await readdir(join(agentHome,'.agents','skills'))),[item.name]);
  const generated=archived.find(file=>file.path==='.generated/cache.bin');
  assert.equal(generated?.encoding,'base64');assert.equal(generated?.content,Buffer.from([0,255,1]).toString('base64'));
  assert.equal((await readdir(agentHome,{recursive:true})).some(name=>String(name).includes('.equip-old-')),false);
});

async function legacyManagedRoot(t:any,withStore=true) {
  const {home,agentHome}=await fixture(t);const item=skill();
  const shared=join(agentHome,'.agents','skills',item.name),canonical=join(home,'skills',item.name);
  await mkdir(shared,{recursive:true});await writeFile(join(shared,'SKILL.md'),item.files[0].content);
  if (withStore) {await mkdir(canonical,{recursive:true});await writeFile(join(canonical,'SKILL.md'),item.files[0].content);}
  await writeFile(join(home,'ledger.json'),JSON.stringify({installs:{managed:{skillId:item.id,path:shared,canonicalPath:canonical,revision:item.revision,files:{}}}}));
  return {home,agentHome,item,shared};
}

for (const journal of ['transaction.json','instructions-transaction.json'])
test(`consolidation waits while ${journal} records an unresolved replacement`,async t=>{
  const {home,agentHome,item,shared}=await legacyManagedRoot(t);await writeFile(join(home,journal),'{}');
  const result=await consolidate(home,agentHome,desired(item),async()=>{});
  assert.equal(result.linked,0);assert.match(result.errors[0]??'',new RegExp(`waiting until the interrupted replacement recorded in .*${journal.replace('.','\\.')} is recovered`));
  assert.equal((await lstat(shared)).isDirectory(),true);assert.equal(await readFile(join(shared,'SKILL.md'),'utf8'),item.files[0].content);
});

test('consolidation keeps a legacy directory when the Equip store is missing',async t=>{
  const {home,agentHome,item,shared}=await legacyManagedRoot(t,false);
  const result=await consolidate(home,agentHome,desired(item),async()=>{});
  assert.equal(result.linked,0);assert.match(result.errors[0]??'',/Equip skill store is unavailable/);
  assert.equal((await lstat(shared)).isDirectory(),true);assert.equal(await readFile(join(shared,'SKILL.md'),'utf8'),item.files[0].content);
});

test('unmanaged directories and redirected standard roots remain untouched',async t=>{
  const unmanaged=await fixture(t);const item=skill();
  const local=join(unmanaged.agentHome,'.agents','skills',item.name);
  await mkdir(local,{recursive:true});await writeFile(join(local,'SKILL.md'),'unmanaged\n');
  const first=await consolidate(unmanaged.home,unmanaged.agentHome,desired(item),async()=>{throw new Error('must not archive');});
  assert.equal(first.linked,0);assert.equal(await readFile(join(local,'SKILL.md'),'utf8'),'unmanaged\n');assert.equal((await lstat(local)).isDirectory(),true);

  const redirected=await fixture(t);const repository=join(redirected.root,'repository');
  await mkdir(join(repository,item.name),{recursive:true});await writeFile(join(repository,item.name,'SKILL.md'),'repository\n');
  await mkdir(join(redirected.agentHome,'.agents'),{recursive:true});await symlink(repository,join(redirected.agentHome,'.agents','skills'),'dir');
  await writeFile(join(redirected.home,'ledger.json'),JSON.stringify({installs:{managed:{skillId:item.id,path:join(repository,item.name),canonicalPath:join(redirected.home,'skills',item.name)}}}));
  const second=await consolidate(redirected.home,redirected.agentHome,desired(item),async()=>{throw new Error('must not archive');});
  assert.equal(second.linked,0);assert.equal(await readFile(join(repository,item.name,'SKILL.md'),'utf8'),'repository\n');assert.equal((await lstat(join(redirected.agentHome,'.agents','skills'))).isSymbolicLink(),true);
});

test('a local change during archival keeps the original directory in place',async t=>{
  const {home,agentHome}=await fixture(t);const item=skill();
  const local=join(agentHome,'.agents','skills',item.name);const canonical=join(home,'skills',item.name);
  await mkdir(local,{recursive:true});await mkdir(canonical,{recursive:true});
  await writeFile(join(local,'SKILL.md'),item.files[0].content);await writeFile(join(canonical,'SKILL.md'),item.files[0].content);
  await writeFile(join(home,'ledger.json'),JSON.stringify({installs:{managed:{skillId:item.id,path:local,canonicalPath:canonical}}}));
  const result=await consolidate(home,agentHome,desired(item),async()=>{await writeFile(join(local,'generated.txt'),'raced\n');});
  assert.equal(result.linked,0);assert.match(result.errors[0],/changed during archival/);
  assert.equal((await lstat(local)).isDirectory(),true);assert.equal(await readFile(join(local,'generated.txt'),'utf8'),'raced\n');
  assert.equal(await lstat(local+'.equip-old').catch(()=>null),null);
});

test('interrupted consolidation finishes only after saving the renamed original',async t=>{
  const {home,agentHome}=await fixture(t);const item=skill();
  const path=join(agentHome,'.agents','skills',item.name),canonical=join(home,'skills',item.name),old=path+'.equip-old-crash',stage=path+'.equip-stage-crash';
  await mkdir(old,{recursive:true});await mkdir(canonical,{recursive:true});
  await writeFile(join(old,'SKILL.md'),'Recovered interrupted original\n');
  await writeFile(join(canonical,'SKILL.md'),item.files[0].content);await symlink(canonical,path,'dir');
  await writeFile(join(home,'consolidation-transaction.json'),JSON.stringify({path,canonical,old,stage,skillId:item.id}));
  let recovered='';
  await consolidate(home,agentHome,desired(item),async payload=>{recovered=payload.files[0].content;assert.ok(await lstat(old));});
  assert.equal(recovered,'Recovered interrupted original\n');assert.equal(await lstat(old).catch(()=>null),null);
  assert.equal(await realpath(path),await realpath(canonical));assert.equal(await lstat(join(home,'consolidation-transaction.json')).catch(()=>null),null);
});

test('interrupted consolidation preserves its original and journal when history is unavailable',async t=>{
  const {home,agentHome}=await fixture(t);const item=skill();
  const path=join(agentHome,'.agents','skills',item.name),canonical=join(home,'skills',item.name),old=path+'.equip-old-crash',stage=path+'.equip-stage-crash';
  await mkdir(old,{recursive:true});await mkdir(canonical,{recursive:true});
  await writeFile(join(old,'SKILL.md'),'Only original\n');await writeFile(join(canonical,'SKILL.md'),item.files[0].content);await symlink(canonical,path,'dir');
  await writeFile(join(home,'consolidation-transaction.json'),JSON.stringify({path,canonical,old,stage,skillId:item.id}));
  await assert.rejects(consolidate(home,agentHome,desired(item),async()=>{throw new Error('offline');}),/offline/);
  assert.equal(await readFile(join(old,'SKILL.md'),'utf8'),'Only original\n');assert.ok(await lstat(join(home,'consolidation-transaction.json')));
});

import assert from 'node:assert/strict';
import fsPromises, { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, lstat, readlink, realpath } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { discoverInstructionLocations, supportedInstructionLocations, syncLocalInstructions, synchronizeInstructions } from '../cli/instructions.ts';
import { skillRevision } from '../shared/library.ts';
import { instructionKey } from '../shared/instructions.ts';
import type { DesiredState, Instructions, InstructionLocation } from '../shared/types.ts';

function doc(content='Original\n',filename:'AGENTS.md'|'CLAUDE.md'='AGENTS.md',mode=0o644):Instructions {
  const files=[{path:filename,content,mode}];
  return {id:'instruction_test',title:'Instructions',filename,scope:'global',selected:true,enabled:true,revision:skillRevision(files),files,versions:[],targets:[],updatedAt:new Date().toISOString()};
}
const desired=(document:Instructions, resolutions:Record<string,'replace'|'preserve'|'import'>={}):DesiredState=>({generation:1,skills:[],resolutions:{},instructions:[document],instructionResolutions:resolutions});
async function fixture(t:any) {const root=await mkdtemp(join(tmpdir(),'equip-instructions-'));t.after(()=>rm(root,{recursive:true,force:true}));const state=join(root,'state');const a:InstructionLocation={agent:'codex',filename:'AGENTS.md',path:join(root,'config/AGENTS.md')};await mkdir(join(root,'config'));return {root,state,a};}

test('instruction discovery keeps profile files distinct when skill roots are linked', async t=>{
 const {root}=await fixture(t); await mkdir(join(root,'.codex/skills'),{recursive:true}); await mkdir(join(root,'.codex_second')); await symlink(join(root,'.codex/skills'),join(root,'.codex_second/skills')); await mkdir(join(root,'.claude_custom'));
 await writeFile(join(root,'.codex/AGENTS.override.md'),'override');
 const project=join(root,'project');await mkdir(project);
 const locations=await discoverInstructionLocations([{id:'codex',path:join(project,'.agents/skills'),project}],{home:root,environment:{}});
 assert.equal(locations.filter(l=>l.agent==='codex'&&!l.project).length,2);
 assert.ok(locations.some(l=>l.profile==='second'&&l.path===join(root,'.codex_second/AGENTS.md')));
 assert.ok(!locations.some(l=>l.project));
 assert.equal(await lstat(join(project,'AGENTS.md')).catch(()=>null),null);
 assert.ok(locations.find(l=>l.path===join(root,'.codex/AGENTS.md'))?.warning?.includes('takes precedence'));
});

test('two computers install identical instruction revisions, update, rollback, and remove managed files',async t=>{
 const {root,state,a}=await fixture(t);const peer=join(root,'peer');await mkdir(peer);const b={...a,path:join(peer,'AGENTS.md')};const v1=doc();
 for(const [home,location] of [[state,a],[join(root,'peer-state'),b]] as const) assert.equal((await synchronizeInstructions(desired(v1),[location],home))[0].status,'synchronized');
 assert.equal(await readFile(a.path,'utf8'),await readFile(b.path,'utf8'));
 const v2=doc('New\n'); await synchronizeInstructions(desired(v2),[a],state);
 assert.equal(await readFile(b.path,'utf8'),'Original\n');
 await synchronizeInstructions(desired(v2),[b],join(root,'peer-state'));assert.equal(await readFile(b.path,'utf8'),'New\n');
 await synchronizeInstructions(desired(v1),[a],state);assert.equal(await readFile(a.path,'utf8'),'Original\n');
 const removed=await synchronizeInstructions({...desired(v1),instructions:[]},[a],state);assert.equal(removed[0].status,'synchronized');assert.equal(await lstat(a.path).catch(()=>null),null);
});

test('matching preexisting instructions become owned managed links and are removed without backups',async t=>{
 const {state,a}=await fixture(t);const policy=doc('Original\n','AGENTS.md',0o640);await writeFile(a.path,'Original\n',{mode:0o640});
 let result=await synchronizeInstructions(desired(policy),[a],state);assert.equal(result[0].status,'synchronized');assert.ok((await lstat(a.path)).isSymbolicLink());
 const canonical=join(state,'instructions',policy.id,'AGENTS.md');assert.equal(await realpath(a.path),await realpath(canonical));const pointer=await readlink(a.path);
 result=await synchronizeInstructions(desired(policy),[a],state);assert.equal(result[0].status,'synchronized');assert.ok((await lstat(a.path)).isSymbolicLink());assert.equal(await readlink(a.path),pointer);
 await synchronizeInstructions({...desired(policy),instructions:[]},[a],state);assert.equal(await lstat(a.path).catch(()=>null),null);assert.equal(await lstat(join(state,'backups')).catch(()=>null),null);
});

test('an old observed instruction record is migrated to a managed link',async t=>{
 const {state,a}=await fixture(t);const policy=doc();await writeFile(a.path,'Original\n');await mkdir(state,{recursive:true});const key=instructionKey(policy.id,a);
 await writeFile(join(state,'instructions-ledger.json'),JSON.stringify({installs:{[key]:{skillId:policy.id,agent:a.agent,path:a.path,filename:a.filename,revision:policy.revision,hash:policy.revision,observed:true}},canonicals:{}}));
 const result=await synchronizeInstructions(desired(policy),[a],state);assert.equal(result[0].status,'synchronized');assert.equal(result[0].managed,true);assert.ok((await lstat(a.path)).isSymbolicLink());
 assert.equal(await realpath(a.path),await realpath(join(state,'instructions',policy.id,'AGENTS.md')));
 await synchronizeInstructions({...desired(policy),instructions:[]},[a],state);assert.equal(await lstat(a.path).catch(()=>null),null);
});

test('matching external instruction links become managed links while their source remains independent',async t=>{
 const {state,a,root}=await fixture(t);const external=join(root,'external.md');await writeFile(external,'Original\n',{mode:0o640});await symlink(external,a.path);const policy=doc('Original\n','AGENTS.md',0o640);
 let result=await synchronizeInstructions(desired(policy),[a],state);assert.equal(result[0].status,'synchronized');assert.ok((await lstat(a.path)).isSymbolicLink());assert.notEqual(await readlink(a.path),external);
 assert.equal(await realpath(a.path),await realpath(join(state,'instructions',policy.id,'AGENTS.md')));assert.equal(await readFile(external,'utf8'),'Original\n');assert.equal((await stat(external)).mode&0o777,0o640);
 result=await synchronizeInstructions(desired(policy),[a],state);assert.equal(result[0].status,'synchronized');assert.notEqual(await readlink(a.path),external);
 await synchronizeInstructions({...desired(policy),instructions:[]},[a],state);assert.equal(await lstat(a.path).catch(()=>null),null);assert.equal(await readFile(external,'utf8'),'Original\n');assert.equal((await stat(external)).mode&0o777,0o640);
});

test('reviewed replacement requires durable recovery and removal does not resurrect local files',async t=>{
 const {state,a}=await fixture(t);await writeFile(a.path,'My work\n',{mode:0o664});const v1=doc();
 let result=await synchronizeInstructions(desired(v1),[a],state);assert.equal(result[0].status,'conflicted');assert.equal(result[0].revision,'');assert.equal(await readFile(a.path,'utf8'),'My work\n');
 const key=instructionKey(v1.id,a);const stale={...desired(v1,{[key]:'replace'}),instructionResolutionChecks:{[key]:'stale'}};
 result=await synchronizeInstructions(stale,[a],state);assert.equal(result[0].status,'conflicted');
 const checked=skillRevision((await synchronizeInstructions(desired(v1),[a],state))[0].localFiles!);
 a.localFiles=result[0].localFiles;
 result=await synchronizeInstructions({...desired(v1,{[key]:'replace'}),instructionResolutionChecks:{[key]:checked}},[a],state,undefined,async()=>{throw new Error('recovery offline');});
 assert.equal(result[0].status,'failed');assert.match(result[0].message!,/recovery offline/);assert.equal(await readFile(a.path,'utf8'),'My work\n');
 const archived:any[]=[];
 result=await synchronizeInstructions({...desired(v1,{[key]:'replace'}),instructionResolutionChecks:{[key]:checked}},[a],state,undefined,async payload=>{archived.push(payload);});
 assert.equal(result[0].status,'synchronized');assert.equal(await readFile(a.path,'utf8'),'Original\n');
 assert.equal(archived.length,1);assert.equal(archived[0].skillId,v1.id);assert.equal(archived[0].kind,'instructions');assert.equal(archived[0].files[0].content,'My work\n');
 assert.equal(await lstat(join(state,'backups')).catch(()=>null),null);
 await synchronizeInstructions({...desired(v1),instructions:[]},[a],state);assert.equal(await lstat(a.path).catch(()=>null),null);
});

test('external linked instructions are imported or replaced without changing external work',async t=>{
 const {state,a,root}=await fixture(t);const external=join(root,'source.md');await writeFile(external,'External\n');await symlink(external,a.path);const v1=doc();let r=await synchronizeInstructions(desired(v1),[a],state);assert.equal(r[0].localFiles?.[0].content,'External\n');
 const key=instructionKey(v1.id,a);r=await synchronizeInstructions(desired(v1,{[key]:'import'}),[a],state);assert.equal(r[0].status,'conflicted');assert.equal(await readlink(a.path),external);
 const archived:any[]=[];r=await synchronizeInstructions(desired(v1,{[key]:'replace'}),[a],state,undefined,async payload=>{archived.push(payload);});assert.equal(r[0].status,'synchronized');assert.equal(await readFile(external,'utf8'),'External\n');assert.equal(archived[0].files[0].content,'External\n');
 await synchronizeInstructions({...desired(v1),instructions:[]},[a],state);assert.equal(await lstat(a.path).catch(()=>null),null);assert.equal(await readFile(external,'utf8'),'External\n');
});

test('managed local modifications are preserved and can become the central revision',async t=>{
 const {state,a}=await fixture(t);const v1=doc();await synchronizeInstructions(desired(v1),[a],state);await writeFile(a.path,'Local\n');let r=await synchronizeInstructions(desired(v1),[a],state);assert.equal(r[0].status,'conflicted');assert.equal(await readFile(a.path,'utf8'),'Local\n');
 const imported=doc('Local\n');r=await synchronizeInstructions(desired(imported),[a],state);assert.equal(r[0].status,'synchronized');assert.equal(r[0].revision,imported.revision);
});

test('optional local publishing requires known base and refuses divergent copies',async t=>{
 const {root,state,a}=await fixture(t);const b={...a,profile:'other',path:join(root,'other/AGENTS.md')};await mkdir(join(root,'other'));const v1=doc();await synchronizeInstructions(desired(v1),[a,b],state);await rm(b.path);await writeFile(b.path,'Other\n');await writeFile(a.path,'Local\n');let calls=0;
 let result=await syncLocalInstructions(state,[a,b],{...desired(v1),localSync:true},async()=>{calls++;});assert.equal(calls,0);assert.equal(result.changed,false);assert.ok(result.errors.length);
 await rm(b.path);await symlink(await readlink(a.path),b.path);
 result=await syncLocalInstructions(state,[a],{...desired(v1),localSync:true},async p=>{calls++;assert.equal(p.baseRevision,v1.revision);assert.equal(p.files[0].content,'Local\n');});assert.equal(calls,1);assert.equal(result.changed,true);
});

test('local publishing accepts managed profile links rewired through another managed profile',async t=>{
 const {root,state,a}=await fixture(t);const b={...a,profile:'other',path:join(root,'other/AGENTS.md')};await mkdir(join(root,'other'));const policy=doc();await synchronizeInstructions(desired(policy),[a,b],state);
 await rm(b.path);await symlink(a.path,b.path);await writeFile(a.path,'Local\n');let calls=0;
 const result=await syncLocalInstructions(state,[a,b],{...desired(policy),localSync:true},async payload=>{calls++;assert.equal(payload.baseRevision,policy.revision);assert.equal(payload.files[0].content,'Local\n');});
 assert.equal(calls,1);assert.deepEqual(result,{changed:true,errors:[]});
 const published=doc('Local\n');const receipts=await synchronizeInstructions(desired(published),[a,b],state);
 assert.ok(receipts.every(receipt=>receipt.status==='synchronized'&&receipt.revision===published.revision));assert.equal(await readlink(b.path),a.path);
});

test('removal deletes managed alias chains before their targets and preserves foreign aliases',async t=>{
 const {root,state,a}=await fixture(t);const b={...a,profile:'alias',path:join(root,'alias/AGENTS.md')};const c={...a,profile:'foreign',path:join(root,'foreign-profile/AGENTS.md')};await mkdir(join(root,'alias'));await mkdir(join(root,'foreign-profile'));const policy=doc();await synchronizeInstructions(desired(policy),[a,b,c],state);
 await rm(b.path);await symlink(a.path,b.path);const foreign=join(root,'foreign.md');await writeFile(foreign,'Original\n');await rm(c.path);await symlink(foreign,c.path);
 const receipts=await synchronizeInstructions({...desired(policy),instructions:[]},[a,b,c],state);
 assert.equal(receipts.find(receipt=>receipt.profile==='alias')?.status,'synchronized');assert.equal(receipts.find(receipt=>receipt.profile==='foreign')?.status,'conflicted');
 assert.equal(await lstat(b.path).catch(()=>null),null);assert.equal(await lstat(a.path).catch(()=>null),null);assert.equal(await readlink(c.path),foreign);assert.equal(await readFile(foreign,'utf8'),'Original\n');
});

test('disabling one managed location re-points enabled aliases that link through it',async t=>{
 const {root,state,a}=await fixture(t);const b={...a,profile:'other',path:join(root,'other/AGENTS.md')};const c={...a,profile:'third',path:join(root,'third/AGENTS.md')};
 await mkdir(join(root,'other'));await mkdir(join(root,'third'));const policy=doc();await synchronizeInstructions(desired(policy),[a,b,c],state);
 await symlink(join(root,'config'),join(root,'alias-root'));await rm(b.path);await symlink(a.path,b.path);await rm(c.path);await symlink(join(root,'alias-root/AGENTS.md'),c.path);
 assert.ok((await synchronizeInstructions(desired(policy),[a,b,c],state)).every(receipt=>receipt.status==='synchronized'));
 policy.targets=[{deviceId:'device',agent:a.agent,enabled:false},{deviceId:'device',agent:a.agent,profile:'other',enabled:true},{deviceId:'device',agent:a.agent,profile:'third',enabled:true}];
 let receipts=await synchronizeInstructions(desired(policy),[a,b,c],state,'device');
 assert.equal(receipts.length,3);assert.ok(receipts.every(receipt=>receipt.status==='synchronized'),JSON.stringify(receipts));
 assert.equal(await lstat(a.path).catch(()=>null),null);
 const canonical=await realpath(join(state,'instructions',policy.id,'AGENTS.md'));
 for(const path of [b.path,c.path]){assert.equal(await readFile(path,'utf8'),policy.files[0].content);assert.equal(await realpath(path),canonical);}
 receipts=await synchronizeInstructions(desired(policy),[a,b,c],state,'device');
 assert.deepEqual(receipts.map(receipt=>[receipt.profile,receipt.status,receipt.revision]),[['other','synchronized',policy.revision],['third','synchronized',policy.revision]]);
});

test('a preserved alias keeps readable instructions when the location it links through is removed',async t=>{
 const {root,state,a}=await fixture(t);const b={...a,profile:'other',path:join(root,'other/AGENTS.md')};await mkdir(join(root,'other'));const policy=doc();
 await synchronizeInstructions(desired(policy),[a,b],state);await rm(b.path);await symlink(a.path,b.path);await synchronizeInstructions(desired(policy),[a,b],state);
 const receipts=await synchronizeInstructions({...desired(policy,{[instructionKey(policy.id,b)]:'preserve'}),instructions:[]},[a,b],state);
 assert.equal(receipts.find(receipt=>receipt.profile==='other')?.instructionResolution,'preserve');assert.equal(receipts.find(receipt=>!receipt.profile)?.status,'synchronized');
 assert.equal(await lstat(a.path).catch(()=>null),null);assert.equal(await readFile(b.path,'utf8'),policy.files[0].content);
 assert.deepEqual(JSON.parse(await readFile(join(state,'instructions-ledger.json'),'utf8')).installs,{});
});

test('removal deletes aliases that link through a directory alias before their targets',async t=>{
 const {root,state,a}=await fixture(t);const b={...a,profile:'other',path:join(root,'other/AGENTS.md')};await mkdir(join(root,'other'));const policy=doc();
 await synchronizeInstructions(desired(policy),[a,b],state);await symlink(join(root,'config'),join(root,'alias-root'));await rm(b.path);await symlink(join(root,'alias-root/AGENTS.md'),b.path);
 assert.ok((await synchronizeInstructions(desired(policy),[a,b],state)).every(receipt=>receipt.status==='synchronized'));
 const receipts=await synchronizeInstructions({...desired(policy),instructions:[]},[a,b],state);
 assert.equal(receipts.length,2);assert.ok(receipts.every(receipt=>receipt.status==='synchronized'),JSON.stringify(receipts));
 assert.equal(await lstat(a.path).catch(()=>null),null);assert.equal(await lstat(b.path).catch(()=>null),null);
 assert.deepEqual(JSON.parse(await readFile(join(state,'instructions-ledger.json'),'utf8')).installs,{});
});

test('disabling a location keeps the file an enabled location reaches through a directory alias',async t=>{
 const {root,state,a}=await fixture(t);await symlink(join(root,'config'),join(root,'config-alias'));const b={...a,profile:'alias',path:join(root,'config-alias/AGENTS.md')};const policy=doc();
 await synchronizeInstructions(desired(policy),[a,b],state);
 policy.targets=[{deviceId:'device',agent:a.agent,enabled:false},{deviceId:'device',agent:a.agent,profile:'alias',enabled:true}];
 let receipts=await synchronizeInstructions(desired(policy),[a,b],state,'device');
 assert.ok(receipts.every(receipt=>receipt.status==='synchronized'),JSON.stringify(receipts));assert.equal(await readFile(b.path,'utf8'),policy.files[0].content);
 receipts=await synchronizeInstructions(desired(policy),[a,b],state,'device');
 assert.deepEqual(receipts.map(receipt=>[receipt.profile,receipt.status]),[['alias','synchronized']]);
});

for (const preservedFirst of [false,true])
test(`removing a location keeps the file a preserved directory alias shares${preservedFirst ? ' when the alias is processed first' : ''}`,async t=>{
 const {root,state,a}=await fixture(t);await symlink(join(root,'config'),join(root,'config-alias'));const b={...a,profile:'alias',path:join(root,'config-alias/AGENTS.md')};const policy=doc();
 await synchronizeInstructions(desired(policy),preservedFirst ? [b,a] : [a,b],state);
 const receipts=await synchronizeInstructions({...desired(policy,{[instructionKey(policy.id,b)]:'preserve'}),instructions:[]},[a,b],state);
 assert.equal(receipts.find(receipt=>receipt.profile==='alias')?.instructionResolution,'preserve',JSON.stringify(receipts));
 assert.equal(await readFile(b.path,'utf8'),policy.files[0].content);
 assert.deepEqual(JSON.parse(await readFile(join(state,'instructions-ledger.json'),'utf8')).installs,{});
});

async function linkedThroughA(t:any) {
 const {root,state,a}=await fixture(t);const b={...a,profile:'other',path:join(root,'other/AGENTS.md')};await mkdir(join(root,'other'));const policy=doc();
 await synchronizeInstructions(desired(policy),[a,b],state);await rm(b.path);await symlink(a.path,b.path);await synchronizeInstructions(desired(policy),[a,b],state);
 policy.targets=[{deviceId:'device',agent:a.agent,enabled:false},{deviceId:'device',agent:a.agent,profile:'other',enabled:true}];
 return {root,state,a,b,policy,removeA:{...desired(policy,{[instructionKey(policy.id,a)]:'replace'})},canonical:join(state,'instructions',policy.id,'AGENTS.md')};
}

test('a survivor materialized during removal publishes its local edit',async t=>{
 const {state,a,b,policy,removeA}=await linkedThroughA(t);await rm(a.path);await writeFile(a.path,'Local\n');
 await synchronizeInstructions(removeA,[a,b],state,'device',async()=>{});
 assert.equal(await lstat(a.path).catch(()=>null),null);assert.ok(!(await lstat(b.path)).isSymbolicLink());assert.equal(await readFile(b.path,'utf8'),'Local\n');
 let calls=0;
 const result=await syncLocalInstructions(state,[a,b],{...desired(policy),localSync:true},async payload=>{calls++;assert.equal(payload.baseRevision,policy.revision);assert.equal(payload.files[0].content,'Local\n');},'device');
 assert.deepEqual(result,{changed:true,errors:[]});assert.equal(calls,1);
});

test('a materialized survivor publishes through every directory alias of its file',async t=>{
 const {root,state,a}=await fixture(t);await mkdir(join(root,'other'));await symlink(join(root,'other'),join(root,'other-alias'));const policy=doc();
 const b={...a,profile:'other',path:join(root,'other/AGENTS.md')},c={...a,profile:'third',path:join(root,'other-alias/AGENTS.md')};
 await synchronizeInstructions(desired(policy),[a,b,c],state);await rm(b.path);await symlink(a.path,b.path);await synchronizeInstructions(desired(policy),[a,b,c],state);
 await rm(a.path);await writeFile(a.path,'Local\n');
 policy.targets=[{deviceId:'device',agent:a.agent,enabled:false},...['other','third'].map(profile=>({deviceId:'device',agent:a.agent,profile,enabled:true}))];
 await synchronizeInstructions(desired(policy,{[instructionKey(policy.id,a)]:'replace'}),[a,b,c],state,'device',async()=>{});
 assert.equal(await lstat(a.path).catch(()=>null),null);assert.equal(await readFile(c.path,'utf8'),'Local\n');
 let calls=0;
 const result=await syncLocalInstructions(state,[a,b,c],{...desired(policy),localSync:true},async payload=>{calls++;assert.equal(payload.files[0].content,'Local\n');},'device');
 assert.deepEqual(result,{changed:true,errors:[]});assert.equal(calls,1);
});

test('removal keeps a survivor\'s content when the instruction store has a local edit',async t=>{
 const {state,a,b,removeA,canonical}=await linkedThroughA(t);await rm(a.path);await writeFile(a.path,'Original\n');await writeFile(canonical,'Edited store\n');
 await synchronizeInstructions(removeA,[a,b],state,'device',async()=>{});
 assert.equal(await lstat(a.path).catch(()=>null),null);assert.equal(await readFile(b.path,'utf8'),'Original\n');assert.equal(await readFile(canonical,'utf8'),'Edited store\n');
});

for (const recoveryFails of [false,true])
test(`a failed survivor replacement is recovered before another removal${recoveryFails ? ', and halts the pass when recovery fails' : ''}`,async t=>{
 const {root,state,a}=await fixture(t);const policy=doc();
 const [b,c,d]=['other','third','fourth'].map(profile=>({...a,profile,path:join(root,profile,'AGENTS.md')}));
 for (const location of [b,c,d]) await mkdir(dirname(location.path));
 await synchronizeInstructions(desired(policy),[a,b,c,d],state);
 await rm(b.path);await symlink(a.path,b.path);await rm(d.path);await symlink(c.path,d.path);
 await synchronizeInstructions(desired(policy),[a,b,c,d],state);
 policy.targets=[{deviceId:'device',agent:a.agent,enabled:false},{deviceId:'device',agent:a.agent,profile:'other',enabled:true},{deviceId:'device',agent:a.agent,profile:'fourth',enabled:true}];
 let failures=recoveryFails ? 2 : 1;const realRename=fsPromises.rename;
 t.mock.method(fsPromises,'rename',async (from:string,to:string)=>{
   if (to===b.path && failures>0 && (from.includes('.equip-stage-')||from.includes('.equip-old-'))) {failures--;throw Object.assign(new Error('EBUSY: resource busy'),{code:'EBUSY'});}
   return realRename(from,to);
 });
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const receipts=await synchronizeInstructions(desired(policy),[a,b,c,d],state,'device');
 const status=(location:InstructionLocation)=>receipts.find(receipt=>receipt.profile===location.profile)?.status;
 assert.equal(failures,0);assert.equal(status(a),'failed',JSON.stringify(receipts));assert.match(await readFile(a.path,'utf8'),/Original/);
 if (recoveryFails) {
   assert.equal(status(c),'failed');assert.equal(await readlink(d.path),c.path,'no change after an unrecovered failure');
   assert.ok(await lstat(join(state,'instructions-transaction.json')));
 } else {
   assert.equal(status(c),'synchronized');assert.equal(await readlink(b.path),a.path,'the original link is restored');
   await assert.rejects(lstat(join(state,'instructions-transaction.json')),/ENOENT/);
 }
 const retried=await synchronizeInstructions(desired(policy),[a,b,c,d],state,'device');
 assert.ok(retried.every(receipt=>receipt.status==='synchronized'),JSON.stringify(retried));
 for (const location of [b,d]) assert.equal(await readFile(location.path,'utf8'),policy.files[0].content);
 assert.deepEqual((await readdir(dirname(b.path))).filter(name=>name.includes('.equip-')),[]);
});

test('a failed ledger commit with a failed rollback halts without committing the replacement',async t=>{
 const {root,state,a}=await fixture(t);await mkdir(join(root,'other'));await symlink(join(root,'other'),join(root,'other-alias'));const policy=doc();
 const b={...a,profile:'other',path:join(root,'other/AGENTS.md')},c={...a,profile:'third',path:join(root,'other-alias/AGENTS.md')};
 await synchronizeInstructions(desired(policy),[a,b,c],state);await rm(b.path);await symlink(a.path,b.path);await synchronizeInstructions(desired(policy),[a,b,c],state);
 policy.targets=[{deviceId:'device',agent:a.agent,enabled:false},...['other','third'].map(profile=>({deviceId:'device',agent:a.agent,profile,enabled:true}))];
 const ledgerPath=join(state,'instructions-ledger.json');
 let ledgerFailures=1,blocked=true;const realRename=fsPromises.rename;
 t.mock.method(fsPromises,'rename',async (from:string,to:string)=>{
   if ((to===ledgerPath && ledgerFailures-- > 0) || (blocked && to===b.path && from.includes('.equip-old-')))
     throw Object.assign(new Error('EBUSY: resource busy'),{code:'EBUSY'});
   return realRename(from,to);
 });
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});

 const receipts=await synchronizeInstructions(desired(policy),[a,b,c],state,'device');

 assert.deepEqual(receipts.map(receipt=>[receipt.profile,receipt.status]),[['other','failed'],['third','failed'],[undefined,'failed']],JSON.stringify(receipts));
 assert.ok(await lstat(join(state,'instructions-transaction.json')),'the journal is kept');
 assert.equal((await readdir(join(root,'other'))).filter(name=>name.includes('.equip-old-')).length,1,'the original link is kept for recovery');
 const persisted=JSON.parse(await readFile(ledgerPath,'utf8')).installs;
 for (const location of [b,c]) assert.equal(persisted[instructionKey(policy.id,location)].pointer,a.path,'the replacement is not committed');

 blocked=false;
 const retried=await synchronizeInstructions(desired(policy),[a,b,c],state,'device');

 assert.ok(retried.every(receipt=>receipt.status==='synchronized'),JSON.stringify(retried));
 for (const location of [b,c]) assert.equal(await readFile(location.path,'utf8'),policy.files[0].content);
 assert.equal(await lstat(a.path).catch(()=>null),null);
 await assert.rejects(lstat(join(state,'instructions-transaction.json')),/ENOENT/);
 assert.deepEqual((await readdir(join(root,'other'))).filter(name=>name.includes('.equip-')),[]);
});

test('a new directory alias whose commit and rollback fail invalidates the existing location receipt',async t=>{
 const {root,state,a}=await fixture(t);const policy=doc();await synchronizeInstructions(desired(policy),[a],state);
 await symlink(join(root,'config'),join(root,'config-alias'));const b={...a,profile:'alias',path:join(root,'config-alias/AGENTS.md')};
 const ledgerPath=join(state,'instructions-ledger.json');
 let ledgerFailures=1,blocked=true;const realRename=fsPromises.rename;
 t.mock.method(fsPromises,'rename',async (from:string,to:string)=>{
   if ((to===ledgerPath && ledgerFailures-- > 0) || (blocked && to===b.path && from.includes('.equip-old-')))
     throw Object.assign(new Error('EBUSY: resource busy'),{code:'EBUSY'});
   return realRename(from,to);
 });
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});

 const receipts=await synchronizeInstructions(desired(policy),[a,b],state);

 assert.deepEqual(receipts.map(receipt=>[receipt.profile,receipt.status]),[[undefined,'failed'],['alias','failed']],JSON.stringify(receipts));
 assert.equal(await lstat(a.path).catch(()=>null),null);assert.ok(await lstat(join(state,'instructions-transaction.json')));

 blocked=false;
 const retried=await synchronizeInstructions(desired(policy),[a,b],state);

 assert.ok(retried.every(receipt=>receipt.status==='synchronized'),JSON.stringify(retried));
 assert.equal(await readFile(a.path,'utf8'),policy.files[0].content);
 await assert.rejects(lstat(join(state,'instructions-transaction.json')),/ENOENT/);
});

test('an instruction journal whose recovery keeps failing fails every location without changes until it recovers',async t=>{
 const {root,state,a}=await fixture(t);const b={...a,profile:'other',path:join(root,'other/AGENTS.md')};await mkdir(join(root,'other'));
 const v1=doc();await synchronizeInstructions(desired(v1),[a,b],state);
 const old=a.path+'.equip-old-stuck';await fsPromises.rename(a.path,old);
 await writeFile(join(state,'instructions-transaction.json'),JSON.stringify({path:a.path,stage:a.path+'.equip-stage-stuck',old,hadOld:true,id:'stuck',key:instructionKey(v1.id,a),skillId:v1.id,filename:v1.filename,expectedHash:v1.revision}));
 let blocked=true;const realRename=fsPromises.rename;
 t.mock.method(fsPromises,'rename',async (from:string,to:string)=>{
   if (blocked && from===old) throw Object.assign(new Error('EBUSY: resource busy'),{code:'EBUSY'});
   return realRename(from,to);
 });
 syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const [ledgerBefore,journalBefore]=await Promise.all(['instructions-ledger.json','instructions-transaction.json'].map(name=>readFile(join(state,name),'utf8')));
 const v2=doc('New\n');
 for (let pass=0;pass<2;pass++) {
   const receipts=await synchronizeInstructions(desired(v2),[a,b],state);
   assert.deepEqual(receipts.map(receipt=>[receipt.profile,receipt.status]),[[undefined,'failed'],['other','failed']]);
   for (const receipt of receipts) assert.equal(receipt.message,`A previous replacement at ${a.path} could not be recovered: EBUSY: resource busy; Equip will retry on the next sync.`);
   assert.equal(await readFile(join(state,'instructions-ledger.json'),'utf8'),ledgerBefore);
   assert.equal(await readFile(join(state,'instructions-transaction.json'),'utf8'),journalBefore);
   assert.equal(await readFile(b.path,'utf8'),'Original\n');
 }
 blocked=false;
 const receipts=await synchronizeInstructions(desired(v2),[a,b],state);
 assert.ok(receipts.every(receipt=>receipt.status==='synchronized'),JSON.stringify(receipts));
 for (const path of [a.path,b.path]) assert.equal(await readFile(path,'utf8'),'New\n');
 await assert.rejects(lstat(join(state,'instructions-transaction.json')),/ENOENT/);
});

test('local publishing rejects a foreign link even when its content matches a managed edit',async t=>{
 const {root,state,a}=await fixture(t);const b={...a,profile:'other',path:join(root,'other/AGENTS.md')};await mkdir(join(root,'other'));const policy=doc();await synchronizeInstructions(desired(policy),[a,b],state);
 await writeFile(a.path,'Local\n');const foreign=join(root,'foreign.md');await writeFile(foreign,'Local\n');await rm(b.path);await symlink(foreign,b.path);let calls=0;
 const result=await syncLocalInstructions(state,[a,b],{...desired(policy),localSync:true},async()=>{calls++;});
 assert.equal(calls,0);assert.equal(result.changed,false);assert.match(result.errors[0]??'',/different local versions need review/);
});

test('local publishing rejects a managed alias chain with a stale ledger revision',async t=>{
 const {root,state,a}=await fixture(t);const b={...a,profile:'other',path:join(root,'other/AGENTS.md')};await mkdir(join(root,'other'));const policy=doc();await synchronizeInstructions(desired(policy),[a,b],state);
 await rm(b.path);await symlink(a.path,b.path);await writeFile(a.path,'Local\n');const ledgerPath=join(state,'instructions-ledger.json');const ledger=JSON.parse(await readFile(ledgerPath,'utf8'));ledger.installs[instructionKey(policy.id,b)].revision='stale';await writeFile(ledgerPath,JSON.stringify(ledger));let calls=0;
 const result=await syncLocalInstructions(state,[a,b],{...desired(policy),localSync:true},async()=>{calls++;});
 assert.equal(calls,0);assert.equal(result.changed,false);assert.match(result.errors[0]??'',/different local versions need review/);
});

test('local publishing accepts matching edits from managed copies with different read and write permissions',async t=>{
 const {root,state,a}=await fixture(t);const b={...a,profile:'other',path:join(root,'other/AGENTS.md')};await mkdir(join(root,'other'));
 const policy=doc();await synchronizeInstructions(desired(policy),[a,b],state);
 await rm(a.path);await rm(b.path);await writeFile(a.path,'Shared edit\n',{mode:0o600});await writeFile(b.path,'Shared edit\n',{mode:0o664});
 const ledgerPath=join(state,'instructions-ledger.json');const ledger=JSON.parse(await readFile(ledgerPath,'utf8'));
 delete ledger.installs[instructionKey(policy.id,a)].pointer;delete ledger.installs[instructionKey(policy.id,b)].pointer;
 await writeFile(ledgerPath,JSON.stringify(ledger));let calls=0;
 const result=await syncLocalInstructions(state,[a,b],{...desired(policy),localSync:true},async payload=>{
   calls++;assert.equal(payload.files[0].content,'Shared edit\n');
 });
 assert.equal(calls,1);assert.deepEqual(result,{changed:true,errors:[]});
});

test('read and write permission changes do not conflict or publish, while executable changes do',async t=>{
 const {state,a}=await fixture(t);const policy=doc();await synchronizeInstructions(desired(policy),[a],state);
 await chmod(a.path,0o600);let calls=0;
 let result=await syncLocalInstructions(state,[a],{...desired(policy),localSync:true},async()=>{calls++;});
 assert.equal(calls,0);assert.deepEqual(result,{changed:false,errors:[]});
 let receipts=await synchronizeInstructions(desired(policy),[a],state);assert.equal(receipts[0].status,'synchronized');
 await chmod(a.path,0o700);
 result=await syncLocalInstructions(state,[a],{...desired(policy),localSync:true},async()=>{calls++;});
 assert.equal(calls,1);assert.equal(result.changed,true);
 receipts=await synchronizeInstructions(desired(policy),[a],state);assert.equal(receipts[0].status,'conflicted');
});

test('a legacy instruction baseline ignores only portable-equal permission changes',async t=>{
 const {state,a}=await fixture(t);const policy=doc();await synchronizeInstructions(desired(policy),[a],state);
 const ledgerPath=join(state,'instructions-ledger.json');const ledger=JSON.parse(await readFile(ledgerPath,'utf8'));
 delete ledger.installs[instructionKey(policy.id,a)].portableHash;delete ledger.canonicals[policy.id].portableHash;
 await writeFile(ledgerPath,JSON.stringify(ledger));await chmod(a.path,0o600);
 let receipts=await synchronizeInstructions(desired(policy),[a],state);assert.equal(receipts[0].status,'synchronized');
 await writeFile(a.path,'Real edit\n');receipts=await synchronizeInstructions(desired(policy),[a],state);
 assert.equal(receipts[0].status,'conflicted');assert.equal(await readFile(a.path,'utf8'),'Real edit\n');
});

test('shadowing is reported as failed, and unsafe destinations remain untouched',async t=>{
 const {state,a}=await fixture(t);await writeFile(join(a.path,'../AGENTS.override.md'),'Override\n');let r=await synchronizeInstructions(desired(doc()),[a],state);assert.equal(r[0].status,'failed');assert.match(r[0].message!,/takes precedence/);
 await rm(a.path);await mkdir(a.path);r=await synchronizeInstructions(desired(doc('New\n')),[a],state);assert.equal(r[0].status,'failed');assert.ok((await stat(a.path)).isDirectory());
});

test('an interrupted file replacement restores the last committed installation',async t=>{
 const {state,a}=await fixture(t);const v1=doc();await synchronizeInstructions(desired(v1),[a],state);
 const old=a.path+'.equip-old-test',stage=a.path+'.equip-stage-test';const fs=await import('node:fs/promises');await fs.rename(a.path,old);await writeFile(a.path,'Interrupted\n');
 await writeFile(join(state,'instructions-transaction.json'),JSON.stringify({path:a.path,old,stage,hadOld:true,id:'uncommitted',key:instructionKey(v1.id,a),skillId:v1.id,filename:v1.filename,expectedHash:v1.revision}));
 const archived:any[]=[];const r=await synchronizeInstructions(desired(v1),[a],state,undefined,async payload=>{archived.push(payload);});assert.equal(r[0].status,'synchronized');assert.equal(await readFile(a.path,'utf8'),'Original\n');
 assert.equal(archived.length,1);assert.equal(archived[0].files[0].content,'Interrupted\n');assert.equal(await lstat(join(state,'backups')).catch(()=>null),null);
});

test('interrupted recovery does not archive the staged desired instructions',async t=>{
 const {state,a}=await fixture(t);const policy=doc();await synchronizeInstructions(desired(policy),[a],state);
 const old=a.path+'.equip-old-test',stage=a.path+'.equip-stage-test';const fs=await import('node:fs/promises');await fs.rename(a.path,old);await writeFile(a.path,policy.files[0].content,{mode:policy.files[0].mode});
 await writeFile(join(state,'instructions-transaction.json'),JSON.stringify({path:a.path,old,stage,hadOld:true,id:'uncommitted',key:instructionKey(policy.id,a),skillId:policy.id,filename:policy.filename,expectedHash:policy.revision}));
 const receipts=await synchronizeInstructions(desired(policy),[a],state);
 assert.equal(receipts[0].status,'synchronized');assert.equal(await readFile(a.path,'utf8'),'Original\n');assert.equal(await lstat(join(state,'backups')).catch(()=>null),null);
});


test('one shared global revision is mirrored into every supported native filename without touching project instructions',async t=>{
 const {root,state}=await fixture(t);
 const project=join(root,'project');await mkdir(project);await writeFile(join(project,'AGENTS.md'),'Project-specific context\n');
 const agents=['gemini-cli','github-copilot','opencode','qwen-code','mistral-vibe','windsurf','antigravity'];
 const targets=[];
 for (const id of agents) {const path=join(root,id,'skills');await mkdir(path,{recursive:true});targets.push({id,path});}
 await mkdir(join(root,'.claude'));await mkdir(join(root,'.codex'));
 const locations=await discoverInstructionLocations(targets,{home:root,environment:{}});
 const policy=doc('One global policy\n');const receipts=await synchronizeInstructions(desired(policy),locations,state);
 assert.equal(receipts.length,9);assert.ok(receipts.every(r=>r.status==='synchronized'&&r.revision===policy.revision));
 for(const location of locations) assert.equal(await readFile(location.path,'utf8'),'One global policy\n');
 assert.equal(await readFile(join(project,'AGENTS.md'),'utf8'),'Project-specific context\n');
});

test('native instruction limits report an unavailable destination without a failed receipt', () => {
 const windsurf:InstructionLocation={agent:'windsurf',filename:'global_rules.md',path:'/windsurf/memories/global_rules.md'};
 const codex:InstructionLocation={agent:'codex',filename:'AGENTS.md',path:'/codex/AGENTS.md'};
 const oversized={...doc(),title:'Team rules',files:[{path:'AGENTS.md',content:'x'.repeat(6001)}],versions:[{revision:'r1'}]} as unknown as Instructions;
 const result=supportedInstructionLocations([windsurf,codex],[oversized]);
 assert.deepEqual(result.locations,[codex]);
 assert.equal(result.unavailable.length,1);
 assert.equal(result.unavailable[0].agent,'windsurf');
 assert.match(result.unavailable[0].reason,/6,000 characters/);
 assert.match(result.unavailable[0].reason,/Skills continue to synchronize/);
});

test('native instruction limits use published desired files when version history is stripped', () => {
 const windsurf:InstructionLocation={agent:'windsurf',filename:'global_rules.md',path:'/windsurf/memories/global_rules.md'};
 const oversized={...doc(),title:'Team rules',files:[{path:'AGENTS.md',content:'x'.repeat(6001)}],versions:[]} as Instructions;
 const result=supportedInstructionLocations([windsurf],[oversized]);
 assert.deepEqual(result.locations,[]);
 assert.equal(result.unavailable[0]?.agent,'windsurf');
 assert.match(result.unavailable[0]?.reason ?? '',/6,001 characters/);
});

test('excluded instructions retain their installed revision, catch up when re-enabled, and remove on disconnect',async t=>{
 const {state,a}=await fixture(t);const first=doc('First\n');await synchronizeInstructions(desired(first),[a],state);
 const second=doc('Second\n');const retained={...desired(second),generation:2,excludedAgents:[{agent:a.agent}]};
 assert.deepEqual(await synchronizeInstructions(retained,[a],state),[]);
 assert.equal(await readFile(a.path,'utf8'),'First\n');
 const retainedPath=await realpath(a.path);assert.match(retainedPath,/retained\/instructions\/instruction_test\//);
 const caughtUp=await synchronizeInstructions({...desired(second),generation:3},[a],state);
 assert.equal(caughtUp[0].status,'synchronized');assert.equal(await readFile(a.path,'utf8'),'Second\n');
 assert.equal(await lstat(retainedPath).catch(()=>null),null);
 await synchronizeInstructions({generation:4,skills:[],resolutions:{},instructions:[]},[a],state);
 assert.equal(await lstat(a.path).catch(()=>null),null);
});

test('excluded instructions stop following the canonical file when another agent updates',async t=>{
 const {root,state,a}=await fixture(t);const b={...a,agent:'claude-code',path:join(root,'claude/CLAUDE.md'),filename:'CLAUDE.md' as const};await mkdir(join(root,'claude'));
 const first=doc('First\n');await synchronizeInstructions(desired(first),[a,b],state);
 const second=doc('Second\n');await synchronizeInstructions({...desired(second),generation:2,excludedAgents:[{agent:a.agent}]},[a,b],state);
 assert.equal(await readFile(a.path,'utf8'),'First\n');assert.equal(await readFile(b.path,'utf8'),'Second\n');
});

test('shared native instruction locations retain the file until the last agent is removed',async t=>{
 const {state,a}=await fixture(t);const b={...a,agent:'mistral-vibe'};const policy=doc();
 await synchronizeInstructions(desired(policy),[a,b],state);
 policy.targets=[{deviceId:'device',agent:a.agent,enabled:false}];
 await synchronizeInstructions(desired(policy),[a,b],state,'device');assert.equal(await readFile(a.path,'utf8'),'Original\n');
 await synchronizeInstructions({...desired(policy),instructions:[]},[a,b],state,'device');assert.equal(await lstat(a.path).catch(()=>null),null);
});


test('a reviewed replacement cannot overwrite a canonical edit made after the heartbeat',async t=>{
 const {state,a}=await fixture(t);const policy=doc();await synchronizeInstructions(desired(policy),[a],state);
 await writeFile(a.path,'Reviewed local edit\n');const reviewed=(await synchronizeInstructions(desired(policy),[a],state))[0].localFiles!;
 a.localFiles=reviewed;await writeFile(a.path,'Newer unreviewed edit\n');const key=instructionKey(policy.id,a);
 const receipts=await synchronizeInstructions({...desired(policy,{[key]:'replace'}),instructionResolutionChecks:{[key]:skillRevision(reviewed)}},[a],state);
 assert.equal(receipts[0].status,'conflicted');assert.equal(await readFile(a.path,'utf8'),'Newer unreviewed edit\n');
});

test('review checks keep exact fingerprints when only permissions changed after review',async t=>{
 const {state,a}=await fixture(t);const policy=doc();await writeFile(a.path,'Local edit\n',{mode:0o644});
 const reviewed=(await synchronizeInstructions(desired(policy),[a],state))[0].localFiles!;
 await chmod(a.path,0o600);const key=instructionKey(policy.id,a);
 const receipts=await synchronizeInstructions({...desired(policy,{[key]:'replace'}),instructionResolutionChecks:{[key]:skillRevision(reviewed)}},[a],state);
 assert.equal(receipts[0].status,'conflicted');assert.equal(await readFile(a.path,'utf8'),'Local edit\n');
});

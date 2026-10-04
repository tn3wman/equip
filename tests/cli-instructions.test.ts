import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, lstat, readlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverInstructionLocations, syncLocalInstructions, synchronizeInstructions } from '../cli/instructions.ts';
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

test('matching preexisting instructions become a managed link and return on removal',async t=>{
 const {state,a}=await fixture(t);const policy=doc('Original\n','AGENTS.md',0o640);await writeFile(a.path,'Original\n',{mode:0o640});
 let result=await synchronizeInstructions(desired(policy),[a],state);assert.equal(result[0].status,'synchronized');assert.ok((await lstat(a.path)).isSymbolicLink());
 const canonical=join(state,'instructions',policy.id,'AGENTS.md');assert.equal(await realpath(a.path),await realpath(canonical));const pointer=await readlink(a.path);
 result=await synchronizeInstructions(desired(policy),[a],state);assert.equal(result[0].status,'synchronized');assert.ok((await lstat(a.path)).isSymbolicLink());assert.equal(await readlink(a.path),pointer);
 await synchronizeInstructions({...desired(policy),instructions:[]},[a],state);assert.ok((await lstat(a.path)).isFile());assert.equal(await readFile(a.path,'utf8'),'Original\n');assert.equal((await stat(a.path)).mode&0o777,0o640);
});

test('an old observed instruction record is migrated to a managed link',async t=>{
 const {state,a}=await fixture(t);const policy=doc();await writeFile(a.path,'Original\n');await mkdir(state,{recursive:true});const key=instructionKey(policy.id,a);
 await writeFile(join(state,'instructions-ledger.json'),JSON.stringify({installs:{[key]:{skillId:policy.id,agent:a.agent,path:a.path,filename:a.filename,revision:policy.revision,hash:policy.revision,observed:true}},canonicals:{}}));
 const result=await synchronizeInstructions(desired(policy),[a],state);assert.equal(result[0].status,'synchronized');assert.equal(result[0].managed,true);assert.ok((await lstat(a.path)).isSymbolicLink());
 assert.equal(await realpath(a.path),await realpath(join(state,'instructions',policy.id,'AGENTS.md')));
 await synchronizeInstructions({...desired(policy),instructions:[]},[a],state);assert.ok((await lstat(a.path)).isFile());assert.equal(await readFile(a.path,'utf8'),'Original\n');
});

test('matching external instruction links become managed links and return on removal',async t=>{
 const {state,a,root}=await fixture(t);const external=join(root,'external.md');await writeFile(external,'Original\n',{mode:0o640});await symlink(external,a.path);const policy=doc('Original\n','AGENTS.md',0o640);
 let result=await synchronizeInstructions(desired(policy),[a],state);assert.equal(result[0].status,'synchronized');assert.ok((await lstat(a.path)).isSymbolicLink());assert.notEqual(await readlink(a.path),external);
 assert.equal(await realpath(a.path),await realpath(join(state,'instructions',policy.id,'AGENTS.md')));assert.equal(await readFile(external,'utf8'),'Original\n');assert.equal((await stat(external)).mode&0o777,0o640);
 result=await synchronizeInstructions(desired(policy),[a],state);assert.equal(result[0].status,'synchronized');assert.notEqual(await readlink(a.path),external);
 await synchronizeInstructions({...desired(policy),instructions:[]},[a],state);assert.equal(await readlink(a.path),external);assert.equal(await readFile(external,'utf8'),'Original\n');assert.equal((await stat(external)).mode&0o777,0o640);
});

test('unknown local versions remain intact; reviewed replace saves original and restores it on removal',async t=>{
 const {state,a,root}=await fixture(t);await writeFile(a.path,'My work\n',{mode:0o664});const v1=doc();
 let result=await synchronizeInstructions(desired(v1),[a],state);assert.equal(result[0].status,'conflicted');assert.equal(result[0].revision,'');assert.equal(await readFile(a.path,'utf8'),'My work\n');
 const key=instructionKey(v1.id,a);const stale={...desired(v1,{[key]:'replace'}),instructionResolutionChecks:{[key]:'stale'}};
 result=await synchronizeInstructions(stale,[a],state);assert.equal(result[0].status,'conflicted');
 const checked=skillRevision((await synchronizeInstructions(desired(v1),[a],state))[0].localFiles!);
 a.localFiles=result[0].localFiles;
 result=await synchronizeInstructions({...desired(v1,{[key]:'replace'}),instructionResolutionChecks:{[key]:checked}},[a],state);
 assert.equal(result[0].status,'synchronized');assert.equal(await readFile(a.path,'utf8'),'Original\n');
 assert.ok((await readdir(join(state,'backups'))).length);
 await synchronizeInstructions({...desired(v1),instructions:[]},[a],state);assert.equal(await readFile(a.path,'utf8'),'My work\n');
});

test('external linked instructions are imported or replaced without changing external work',async t=>{
 const {state,a,root}=await fixture(t);const external=join(root,'source.md');await writeFile(external,'External\n');await symlink(external,a.path);const v1=doc();let r=await synchronizeInstructions(desired(v1),[a],state);assert.equal(r[0].localFiles?.[0].content,'External\n');
 const key=instructionKey(v1.id,a);r=await synchronizeInstructions(desired(v1,{[key]:'import'}),[a],state);assert.equal(r[0].status,'conflicted');assert.equal(await readlink(a.path),external);
 r=await synchronizeInstructions(desired(v1,{[key]:'replace'}),[a],state);assert.equal(r[0].status,'synchronized');assert.equal(await readFile(external,'utf8'),'External\n');
 await synchronizeInstructions({...desired(v1),instructions:[]},[a],state);assert.equal(await readlink(a.path),external);assert.equal(await readFile(external,'utf8'),'External\n');
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

test('shadowing is reported as failed, and unsafe destinations remain untouched',async t=>{
 const {state,a}=await fixture(t);await writeFile(join(a.path,'../AGENTS.override.md'),'Override\n');let r=await synchronizeInstructions(desired(doc()),[a],state);assert.equal(r[0].status,'failed');assert.match(r[0].message!,/takes precedence/);
 await rm(a.path);await mkdir(a.path);r=await synchronizeInstructions(desired(doc('New\n')),[a],state);assert.equal(r[0].status,'failed');assert.ok((await stat(a.path)).isDirectory());
});

test('an interrupted file replacement restores the last committed installation',async t=>{
 const {state,a}=await fixture(t);const v1=doc();await synchronizeInstructions(desired(v1),[a],state);
 const old=a.path+'.equip-old-test',stage=a.path+'.equip-stage-test';const fs=await import('node:fs/promises');await fs.rename(a.path,old);await writeFile(a.path,'Interrupted\n');
 await writeFile(join(state,'instructions-transaction.json'),JSON.stringify({path:a.path,old,stage,hadOld:true,id:'uncommitted',key:instructionKey(v1.id,a)}));
 const r=await synchronizeInstructions(desired(v1),[a],state);assert.equal(r[0].status,'synchronized');assert.equal(await readFile(a.path,'utf8'),'Original\n');
 const backups=await readdir(join(state,'backups'));assert.ok(backups.length);assert.equal(await readFile(join(state,'backups',backups[0],'contents'),'utf8'),'Interrupted\n');
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

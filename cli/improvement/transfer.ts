import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ImprovementStore } from './store.ts';
import { object } from './validation.ts';

const chunkLimit = 4 * 1024 * 1024;
const sha256 = (body:string) => createHash('sha256').update(body).digest('hex');

/** Portable chunks keep backup/restore independent of the single-input limits.
 * A manifest is written last; an incomplete export is never a valid backup. */
export async function exportDirectory(store:ImprovementStore, path:string) {
  const directory=resolve(path);
  await mkdir(directory,{mode:0o700}); // Refuse to overwrite an existing backup.
  const chunks:Array<{file:string;sha256:string}>=[];
  let entries:ReturnType<ImprovementStore['export']>['entries']=[], bytes=0, total=0;
  const flush=async()=>{
    if(!entries.length)return;
    const file=`chunk-${String(chunks.length).padStart(8,'0')}.json`;
    const body=JSON.stringify({schema:1,entries});
    if(Buffer.byteLength(body)>chunkLimit)throw new Error('An entry exceeds the portable chunk limit. Preserve the local ledger.');
    await writeFile(join(directory,file),body,{flag:'wx',mode:0o600});
    chunks.push({file,sha256:sha256(body)});total+=entries.length;entries=[];bytes=0;
  };
  for(const entry of store.exportEntries(true)) {
    const size=Buffer.byteLength(JSON.stringify(entry))+1;
    if(entries.length&&(bytes+size>1024*1024||entries.length>=256))await flush();
    entries.push(entry);bytes+=size;
  }
  await flush();
  await writeFile(join(directory,'manifest.json'),JSON.stringify({schema:1,format:'equip-improvement-chunks',entries:total,chunks}),{flag:'wx',mode:0o600});
  return {directory,entries:total,chunks:chunks.length};
}

/** Restore commits one bounded, validated chunk at a time. A failed restore is
 * resumable with the same immutable backup; prior successful chunks stay saved. */
export async function importDirectory(store:ImprovementStore, path:string) {
  const directory=resolve(path);
  const manifest=object(JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')),['schema','format','entries','chunks']);
  if(manifest.schema!==1||manifest.format!=='equip-improvement-chunks'||!Number.isSafeInteger(manifest.entries)||manifest.entries<0||!Array.isArray(manifest.chunks))throw new Error('Invalid improvement backup manifest.');
  const readChunk=async(raw:unknown,index:number)=>{
    const chunk=object(raw,['file','sha256']);
    if(chunk.file!==`chunk-${String(index).padStart(8,'0')}.json`||typeof chunk.sha256!=='string'||!/^[a-f0-9]{64}$/.test(chunk.sha256))throw new Error('Invalid improvement backup chunk identity.');
    const handle=await open(join(directory,chunk.file),'r');
    let body:string;
    try {if((await handle.stat()).size>chunkLimit)throw new Error('Improvement backup chunk exceeds 4 MiB.');body=await handle.readFile('utf8');}finally{await handle.close();}
    if(sha256(body)!==chunk.sha256)throw new Error('Improvement backup chunk hash mismatch.');
    return JSON.parse(body);
  };
  // Check every chunk's identity before the first write, and check it again when
  // consumed. No external commands or account state are involved.
  for(let index=0;index<manifest.chunks.length;index++)await readChunk(manifest.chunks[index],index);
  let imported=0;
  const precedingFeedback=new Set<string>();
  for(let index=0;index<manifest.chunks.length;index++) {
    const chunk=await readChunk(manifest.chunks[index],index);
    imported+=store.import(chunk,precedingFeedback).imported;
    for(const entry of chunk.entries)if(entry.kind==='feedback')precedingFeedback.add(entry.id);
  }
  if(imported!==manifest.entries)throw new Error('Improvement backup entry count mismatch; earlier validated chunks remain saved.');
  return {directory,imported,chunks:manifest.chunks.length};
}

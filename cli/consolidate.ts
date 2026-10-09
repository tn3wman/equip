import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { DesiredState, SkillFile } from '../shared/types.ts';
import { portableFilesRevision } from './file-state.ts';
import type { RecoveryArchive } from './recovery.ts';
import { renameReplacing } from './atomic.ts';

// Unlike import, recovery keeps generated files too. Never flatten nested links.
async function filesAt(root: string, filename?: string): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  async function walk(path: string, name: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Nested links need review; the original was retained.');
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await walk(join(path, entry), name ? `${name}/${entry}` : entry);
    } else if (info.isFile()) {
      const bytes = await readFile(path);
      const binary = !Buffer.from(bytes.toString('utf8')).equals(bytes);
      files.push({path: name, content: bytes.toString(binary ? 'base64' : 'utf8'), mode: info.mode & 0o777,
        ...(binary ? {encoding:'base64' as const} : {})});
    } else throw new Error('Unsupported filesystem entry; the original was retained.');
  }
  await walk(root, filename ?? '');
  return files.sort((a,b) => a.path.localeCompare(b.path));
}

/** Migrate only Equip backups and the standard local skill store, never repositories. */
export async function consolidate(home: string, agentHome: string, desired: DesiredState, archive: RecoveryArchive) {
  const result = {linked:0, archived:0, removedBackups:0, errors:[] as string[]};
  const journalPath = join(home,'consolidation-transaction.json');
  const journal = JSON.parse(await readFile(journalPath,'utf8').catch(e => {if(e.code==='ENOENT') return 'null';throw e;}));
  if (journal) {
    // The original survives a crash until its replacement and history are verified.
    if (await lstat(journal.old).catch(() => null)) {
      const canonical = await realpath(journal.canonical).catch(() => undefined);
      if (canonical && await realpath(journal.path).catch(() => undefined) === canonical) {
        const files = await filesAt(journal.old);
        await archive({skillId:journal.skillId, files, path:journal.path});
        if (portableFilesRevision(await filesAt(journal.old)) !== portableFilesRevision(files))
          throw new Error('Original changed during interrupted consolidation and was retained.');
        await rm(journal.old,{recursive:true});
      } else if (!await lstat(journal.path).catch(() => null)) await rename(journal.old,journal.path);
      else throw new Error('Interrupted consolidation has two local versions; both were preserved for review.');
    }
    await rm(journal.stage,{force:true});await rm(journalPath,{force:true});
  }
  const ledger = JSON.parse(await readFile(join(home,'ledger.json'),'utf8').catch(() => '{"installs":{}}'));
  const instructionLedgerPath = join(home,'instructions-ledger.json');
  const instructionLedger = JSON.parse(await readFile(instructionLedgerPath,'utf8').catch(() => '{"installs":{},"canonicals":{}}'));
  const backupRoot = join(home,'backups');
  // Refuse a redirected legacy root: it could point into an unrelated repository.
  if ((await lstat(backupRoot).catch(() => null))?.isSymbolicLink()) {
    result.errors.push('Backup root is a symbolic link and needs review.');
    return result;
  }
  for (const name of await readdir(backupRoot).catch(e => {if (e.code === 'ENOENT') return [];throw e;})) {
    const folder = join(backupRoot,name);
    try {
      if (!(await lstat(folder)).isDirectory() || (await lstat(folder)).isSymbolicLink()) throw new Error('Unknown backup entry was retained.');
      const pointer = JSON.parse(await readFile(join(folder,'original-link.json'),'utf8').catch(e => {if(e.code==='ENOENT') return '{}';throw e;}));
      const instructions = name.startsWith('instructions-');
      const entry = Object.values(instructionLedger.installs).find((e:any) => e.originalBackup === folder || pointer.path && e.path === pointer.path) as any;
      const item = instructions
        ? (desired.instructions ?? []).find(d => d.id === entry?.skillId) ?? ((desired.instructions?.length === 1) ? desired.instructions[0] : undefined)
        : [...desired.skills].sort((a,b) => b.name.length-a.name.length).find(s => name.match(/^\d+-/) && name.slice(name.indexOf('-')+1).startsWith(s.name+'-'));
      if (!item) throw new Error('No library item for this backup; it was retained.');
      const content = (await lstat(join(folder,'contents')).catch(() => null)) ? join(folder,'contents') : folder;
      const files = await filesAt(content,instructions ? (item as any).filename : undefined);
      const before = portableFilesRevision(files);
      await archive({skillId:item.id, ...(instructions ? {kind:'instructions' as const} : {}), files, path:folder});
      if (portableFilesRevision(await filesAt(content,instructions ? (item as any).filename : undefined)) !== before)
        throw new Error('Backup changed during archival; it was retained.');
      // Persist removal of old restore pointers before deleting their backing files.
      let changed = false;
      for (const e of Object.values(instructionLedger.installs) as any[]) if(e.originalBackup === folder) {delete e.originalBackup;changed=true;}
      if (changed) {
        const temp = instructionLedgerPath+'.'+randomUUID()+'.tmp';
        await writeFile(temp,JSON.stringify(instructionLedger),{mode:0o600});await renameReplacing(temp,instructionLedgerPath);
      }
      await rm(folder,{recursive:true});result.archived++;result.removedBackups++;
    } catch(error) {result.errors.push(`${folder}: ${(error as Error).message}`);}
  }
  if (!(await readdir(backupRoot).catch(() => ['unknown'])).length) await rm(backupRoot,{recursive:true});

  const sharedRoot = join(agentHome,'.agents','skills');
  if (!(await lstat(sharedRoot).catch(() => null))?.isDirectory() ||
      (await lstat(join(agentHome,'.agents')).catch(() => null))?.isSymbolicLink()) return result;
  for (const skill of desired.skills) {
    const path = join(sharedRoot,skill.name);
    const canonical = join(home,'skills',skill.name);
    const info = await lstat(path).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    const entries = Object.values(ledger.installs).filter((e:any) => e.skillId === skill.id) as any[];
    if (!entries.length || entries.some(e => e.observed || e.canonicalPath !== canonical)) continue;
    try {
      const files = await filesAt(path);
      const before = portableFilesRevision(files);
      // Every variant is saved, including generated files omitted by an import.
      await archive({skillId:skill.id, files, path});
      if (portableFilesRevision(await filesAt(path)) !== before) throw new Error('Local skill changed during archival; it was retained.');
      const stage = path+'.equip-stage-'+randomUUID();
      const old = path+'.equip-old-'+randomUUID();
      await symlink(process.platform === 'win32' ? canonical : relative(dirname(path),canonical),stage,process.platform === 'win32' ? 'junction':'dir');
      const tempJournal = journalPath+'.'+randomUUID()+'.tmp';
      await writeFile(tempJournal,JSON.stringify({path,old,stage,canonical,skillId:skill.id}),{mode:0o600});
      await renameReplacing(tempJournal,journalPath);
      await rename(path,old);
      try {await rename(stage,path);} catch(error) {await rename(old,path);await rm(stage,{force:true});throw error;}
      // Recheck the renamed original in case a writer raced the final swap.
      if (portableFilesRevision(await filesAt(old)) !== before) {
        await rm(path,{force:true});await rename(old,path);throw new Error('Local skill changed during consolidation; it was retained.');
      }
      await rm(old,{recursive:true});await rm(journalPath,{force:true});result.linked++;
    } catch(error) {
      result.errors.push(`${path}: ${(error as Error).message}`);
      if (await lstat(journalPath).catch(() => null)) break;
    }
  }
  return result;
}

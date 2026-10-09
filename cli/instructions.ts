import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { DesiredState, InstructionFilename, InstructionLocation, Instructions, Receipt, SkillFile } from '../shared/types.ts';
import { skillRevision } from '../shared/library.ts';
import { instructionEnabled, instructionKey } from '../shared/instructions.ts';
import { portableFilesRevision } from './file-state.ts';
import { discoverConfigurationRoots, type ProfileDiscoveryOptions } from './profiles.ts';
import type { RecoveryArchive } from './recovery.ts';
import type { AgentTarget } from './sync.ts';

const limit = 256 * 1024;
interface Entry { skillId: string; agent: string; profile?: string; project?: string; path: string; filename: InstructionFilename; revision: string; hash: string; portableHash?: string; pointer?: string; observed?: boolean; originalBackup?: string; transaction?: string }
interface Canonical { path: string; hash: string; portableHash?: string; revision: string; transaction?: string }
interface Ledger { installs: Record<string, Entry>; canonicals: Record<string, Canonical> }
interface Transaction { path: string; stage: string; old: string; hadOld: boolean; id: string; key: string; skillId: string; filename: InstructionFilename; expectedHash: string; canonical?: boolean }
function excludedDestination(
  desired: DesiredState,
  destination: { agent: string; profile?: string; project?: string },
) {
  return (desired.excludedAgents ?? []).some(excluded =>
    excluded.agent === destination.agent && excluded.profile === destination.profile &&
    excluded.project === destination.project);
}
const ledgerPath = (home: string) => join(home, 'instructions-ledger.json');
async function json<T>(path: string, fallback: T): Promise<T> {
  return readFile(path, 'utf8').then(s => JSON.parse(s) as T).catch(e => { if (e.code === 'ENOENT') return fallback; throw e; });
}
async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2), {mode:0o600});
  await rename(temp,path);
}
async function snapshot(path: string, filename: InstructionFilename) {
  const info = await lstat(path).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
  if (!info) return {exists:false, files:[] as SkillFile[], hash:'', pointer:undefined as string|undefined};
  const resolved = await stat(path); // A dangling link is a failure, never an empty file.
  if (!resolved.isFile()) throw new Error('Instruction destination is not a regular file; it was preserved.');
  if (resolved.size > limit) throw new Error('Instruction file exceeds 256 KiB and was preserved.');
  const data = await readFile(path);
  if (data.length > limit || data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data))
    throw new Error('Instructions must be UTF-8 text without NUL bytes; this file was preserved.');
  const files: SkillFile[] = [{path:filename, content:data.toString('utf8'), mode:resolved.mode & 0o777}];
  return {exists:true, files, hash:skillRevision(files), portableHash:portableFilesRevision(files), pointer:info.isSymbolicLink() ? await readlink(path) : undefined};
}

async function sameManagedInstruction(
  home: string,
  entry: Entry | undefined,
  current: { pointer?: string },
  path: string,
) {
  if (!entry || entry.observed || entry.path !== path || !entry.pointer || !current.pointer) return false;
  const canonicalPath = join(home, 'instructions', entry.skillId, entry.filename);
  const canonical = await lstat(canonicalPath).catch(() => undefined);
  if (!canonical?.isFile() || canonical.isSymbolicLink()) return false;
  const destination = await lstat(path).catch(() => undefined);
  if (!destination?.isSymbolicLink()) return false;
  const [destinationPath, managedPath] = await Promise.all([
    realpath(path).catch(() => undefined),
    realpath(canonicalPath).catch(() => undefined),
  ]);
  return destinationPath !== undefined && managedPath !== undefined && destinationPath === managedPath;
}

async function instructionRemovalOrder(installs: Record<string, Entry>) {
  const entries = Object.entries(installs);
  const keysByPath = new Map<string,string[]>();
  for (const [key,entry] of entries) {
    const path = resolve(entry.path);
    keysByPath.set(path,[...(keysByPath.get(path) ?? []),key]);
  }
  const targets = new Map<string,string[]>();
  const incoming = new Map(entries.map(([key]) => [key,0]));
  for (const [key,entry] of entries) {
    const info = await lstat(entry.path).catch(() => undefined);
    if (!info?.isSymbolicLink()) continue;
    const pointer = await readlink(entry.path).catch(() => undefined);
    if (!pointer) continue;
    const targetPath = resolve(dirname(entry.path),pointer);
    const targetKeys = (keysByPath.get(targetPath) ?? []).filter(targetKey => targetKey !== key);
    if (!targetKeys.length) continue;
    targets.set(key,targetKeys);
    for (const targetKey of targetKeys) incoming.set(targetKey,(incoming.get(targetKey) ?? 0)+1);
  }
  const pending = entries.filter(([key]) => incoming.get(key) === 0);
  const ordered: Array<[string,Entry]> = [];
  const added = new Set<string>();
  while (pending.length) {
    const item = pending.shift()!;
    const [key] = item;
    if (added.has(key)) continue;
    added.add(key);ordered.push(item);
    for (const targetKey of targets.get(key) ?? []) {
      const remaining = (incoming.get(targetKey) ?? 0)-1;incoming.set(targetKey,remaining);
      if (remaining === 0) pending.push(entries.find(([candidate]) => candidate === targetKey)!);
    }
  }
  return [...ordered,...entries.filter(([key]) => !added.has(key))];
}

export async function discoverInstructionLocations(targets: AgentTarget[], options: ProfileDiscoveryOptions & { autoDetect?: boolean } = {}): Promise<InstructionLocation[]> {
  const roots = await discoverConfigurationRoots(options);
  const locations: InstructionLocation[] = [];
  if (options.autoDetect !== false) {
    for (const root of roots) locations.push({agent:root.id, profile:root.profile,
      filename:root.id === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md',
      path:join(root.root, root.id === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md')});
  }
  // Upstream defines detected agent roots. These adapters describe native global
  // instruction loaders, not another copy of the upstream agent compatibility list.
  const nativeFiles: Record<string,string> = {
    'gemini-cli':'GEMINI.md', 'antigravity':'GEMINI.md', 'github-copilot':'copilot-instructions.md',
    'opencode':'AGENTS.md', 'qwen-code':'QWEN.md', 'mistral-vibe':'AGENTS.md', 'windsurf':'global_rules.md',
  };
  for (const target of targets) {
    if (target.project) continue; // Project instructions are local, additive repository files.
    if (['claude-code','codex'].includes(target.id)) {
      if (options.autoDetect === false) {
        const filename = target.id === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md';
        const candidates = roots.filter(r => r.id === target.id && r.profile === target.profile);
        for (const root of candidates.length ? candidates : [{root:dirname(target.path),profile:target.profile}])
          locations.push({agent:target.id, profile:root.profile, filename, path:join(root.root,filename)});
      }
      continue;
    }
    let filename = nativeFiles[target.id];
    if (!filename) continue;
    let root = dirname(target.path);
    if (target.id === 'antigravity') root = dirname(root);
    if (target.id === 'windsurf') root = join(root,'memories');
    let warning: string|undefined;
    if (target.id === 'gemini-cli' || target.id === 'qwen-code') {
      const settings = await json<{context?:{fileName?:unknown}}>(join(root,'settings.json'),{});
      const configured = settings.context?.fileName;
      const names = Array.isArray(configured) ? configured : configured ? [configured] : [];
      if (names.length && !names.includes(filename)) {
        const candidate = names.find(n => typeof n === 'string' && /^[A-Za-z0-9_.-]+\.md$/.test(n));
        if (candidate) filename = candidate as string;
        else warning = 'The configured context filenames do not include a supported Markdown file.';
      }
    }
    locations.push({agent:target.id,profile:target.profile,filename,path:join(root,filename),warning});
  }
  const unique = [...new Map(locations.map(l => [instructionKey(l.path,l), l])).values()];
  for (const location of unique) {
    const warnings: string[] = location.warning ? [location.warning] : [];
    if (location.filename === 'AGENTS.md' && await lstat(join(dirname(location.path),'AGENTS.override.md')).catch(() => null))
      warnings.push('AGENTS.override.md takes precedence over this file. Move or edit the override to use Equip instructions.');
    if (location.filename === 'CLAUDE.md' && location.project) {
      for (const name of ['CLAUDE.local.md','.claude/CLAUDE.md'])
        if (await lstat(join(location.project,name)).catch(() => null)) warnings.push(`${name} also supplies instructions for this project.`);
    }
    try {const current = await snapshot(location.path, "AGENTS.md"); if (current.exists) location.localFiles = current.files;}
    catch (error) {warnings.push((error as Error).message);}
    if (warnings.length) location.warning = warnings.join(' ');
  }
  return unique;
}

export interface InstructionUnavailable {
  agent: string;
  profile?: string;
  project?: string;
  reason: string;
}

/** Removes native destinations that cannot represent the current published instructions. */
export function supportedInstructionLocations(
  locations: InstructionLocation[],
  documents: Instructions[] = [],
  deviceId?: string,
): { locations: InstructionLocation[]; unavailable: InstructionUnavailable[] } {
  const active = documents.filter(document =>
    document.selected && document.enabled && Boolean(document.revision) &&
    document.files.length > 0 && document.scope === 'global');
  const unavailable: InstructionUnavailable[] = [];
  const supported = locations.filter(location => {
    if (location.agent !== 'windsurf') return true;
    const oversized = active.find(document =>
      instructionEnabled(document, location, deviceId) && document.files[0]?.content.length > 6000);
    if (!oversized) return true;
    unavailable.push({
      agent: location.agent,
      profile: location.profile,
      project: location.project,
      reason: `Windsurf global rules support up to 6,000 characters. "${oversized.title}" has ${oversized.files[0].content.length.toLocaleString()} characters. Skills continue to synchronize.`,
    });
    return false;
  });
  return { locations: supported, unavailable };
}

async function archiveFiles(archive:RecoveryArchive|undefined, skillId:string, files:SkillFile[], path:string) {
  if (!archive) throw new Error('Local instructions differ and recovery is unavailable. The local file was preserved.');
  await archive({skillId,kind:'instructions',files,path});
  if ((await snapshot(path,files[0].path as InstructionFilename)).portableHash !== portableFilesRevision(files))
    throw new Error('Local instructions changed during archival. The local file was preserved.');
}

async function recover(home: string, ledger: Ledger, archive?:RecoveryArchive) {
  const p = join(home,'instructions-transaction.json');
  const journal = await json<Transaction|undefined>(p,undefined);
  if (!journal) return;
  const entry = journal.canonical ? ledger.canonicals[journal.key] : ledger.installs[journal.key];
  const committed = entry?.transaction === journal.id;
  const old = await lstat(journal.old).catch(() => null);
  if (!committed && old) {
    const current = await snapshot(journal.path,journal.filename);
    if (current.exists && current.hash !== journal.expectedHash)
      await archiveFiles(archive,journal.skillId,current.files,journal.path);
    await rm(journal.path,{force:true});
    await rename(journal.old,journal.path);
  } else if (!committed && !journal.hadOld && !await lstat(journal.stage).catch(() => null)) {
    const current = await snapshot(journal.path,journal.filename);
    if (current.exists && current.hash !== journal.expectedHash)
      await archiveFiles(archive,journal.skillId,current.files,journal.path);
    await rm(journal.path,{force:true});
  }
  await rm(journal.stage,{force:true});
  if (committed) await rm(journal.old,{force:true});
  await rm(p,{force:true});
}

async function replaceFile(home: string, ledger: Ledger, key: string, destination: string, stage: string, entry: Entry|Canonical, filename:InstructionFilename, skillId:string, archive:RecoveryArchive|undefined, canonical = false) {
  const transaction = randomUUID();
  const old = destination + '.equip-old-' + transaction;
  const hadOld = Boolean(await lstat(destination).catch(() => null));
  const journal: Transaction = {path:destination,stage,old,hadOld,id:transaction,key,skillId,filename,expectedHash:entry.hash,canonical};
  await atomicJson(join(home,'instructions-transaction.json'),journal);
  if (hadOld) await rename(destination,old);
  await rename(stage,destination);
  entry.transaction = transaction;
  if (canonical) ledger.canonicals[key] = entry as Canonical;
  else ledger.installs[key] = entry as Entry;
  try {await atomicJson(ledgerPath(home),ledger);}
  catch (error) {
    const persisted = await json<Ledger>(ledgerPath(home),{installs:{},canonicals:{}});
    await recover(home,persisted,archive);
    ledger.installs = persisted.installs;ledger.canonicals = persisted.canonicals;
    throw error;
  }
  await recover(home,ledger,archive);
}

export async function syncLocalInstructions(home: string, locations: InstructionLocation[], desired: DesiredState,
  publish: (payload:{instructionId:string; baseRevision:string; files:SkillFile[]}) => Promise<unknown>, deviceId?:string) {
  const errors: string[] = [];
  let changed = false;
  if (!desired.localSync || desired.disconnect || await lstat(join(home,'instructions-transaction.json')).catch(() => null)) return {changed,errors};
  const ledger = await json<Ledger>(ledgerPath(home),{installs:{},canonicals:{}});
  for (const doc of desired.instructions ?? []) {
    const candidates: SkillFile[][] = [];
    let unknown = false;
    for (const location of locations.filter(l => instructionEnabled(doc,l,deviceId))) {
      const entry = ledger.installs[instructionKey(doc.id,location)];
      try {
        const current = await snapshot(location.path,doc.filename);
        const desiredPortableHash = portableFilesRevision(doc.files);
        if (!current.exists || current.portableHash === desiredPortableHash) continue;
        const samePointer = entry?.pointer === current.pointer || await sameManagedInstruction(home,entry,current,location.path);
        if (!entry || entry.revision !== doc.revision || !samePointer) unknown = true;
        else if (entry.portableHash ? current.portableHash !== entry.portableHash : current.hash !== entry.hash)
          candidates.push(current.files);
      } catch (error) {errors.push((error as Error).message);unknown = true;}
    }
    if (!candidates.length) continue;
    const hashes = new Set(candidates.map(portableFilesRevision));
    if (unknown || hashes.size > 1) {errors.push(`${doc.title}: different local versions need review.`);continue;}
    try {await publish({instructionId:doc.id,baseRevision:doc.revision,files:candidates[0]});changed = true;}
    catch (error) {errors.push(`${doc.title}: ${(error as Error).message}`);}
  }
  return {changed,errors};
}

export async function synchronizeInstructions(desired: DesiredState, locations: InstructionLocation[], home: string, deviceId?: string, archive?:RecoveryArchive): Promise<Receipt[]> {
  await mkdir(home,{recursive:true});
  const lockPath = join(home,'instructions-sync.lock');
  let lock;
  try {lock = await open(lockPath,'wx',0o600);}
  catch {
    const owner = await json<{pid?:number}>(lockPath,{});
    if (owner.pid) {try {process.kill(owner.pid,0);throw new Error('Instruction synchronization is already running');} catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;}}
    await rm(lockPath,{force:true});lock = await open(lockPath,'wx',0o600);
  }
  try {
    await lock.writeFile(JSON.stringify({pid:process.pid}));
    const ledger = await json<Ledger>(ledgerPath(home),{installs:{},canonicals:{}});
    await recover(home,ledger,archive);
    // Retained destinations share one immutable snapshot for each old revision.
    for (const [key,entry] of Object.entries(ledger.installs)) {
      if (!excludedDestination(desired,entry) || !entry.pointer) continue;
      const current = await snapshot(entry.path,entry.filename);
      if (!current.exists) continue;
      const retained = join(home,'retained','instructions',entry.skillId,portableFilesRevision(current.files),entry.filename);
      if (!await lstat(retained).catch(()=>null)) {
        const retainedStage = retained+'.equip-stage-'+randomUUID();await mkdir(dirname(retained),{recursive:true});
        await writeFile(retainedStage,current.files[0].content,{mode:current.files[0].mode ?? 0o644});
        await rename(retainedStage,retained).catch(async error=>{await rm(retainedStage,{force:true});if(!await lstat(retained).catch(()=>null))throw error;});
      }
      const stage = entry.path+'.equip-retained-'+randomUUID();
      try {await symlink(process.platform==='win32'?retained:relative(await realpath(dirname(entry.path)),await realpath(retained)),stage,'file');}
      catch (error) {
        if (!['EPERM','EACCES','ENOTSUP','EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await cp(retained,stage);
      }
      const stagedPointer=(await lstat(stage)).isSymbolicLink()?await readlink(stage):undefined;
      const retainedEntry={...entry,pointer:stagedPointer,hash:current.hash,portableHash:current.portableHash};
      if (process.platform==='win32' || !stagedPointer)
        await replaceFile(home,ledger,key,entry.path,stage,retainedEntry,entry.filename,entry.skillId,archive);
      else {await rename(stage,entry.path);ledger.installs[key]=retainedEntry;await atomicJson(ledgerPath(home),ledger);}
    }
    const receipts: Receipt[] = [];
    const wanted = new Set<string>();
    const selectedPaths = new Map<string,string>();
    const canonicalConflicts = new Map<string,SkillFile[]>();
    const docs = desired.instructions ?? [];
    for (const doc of docs) {
      if (!/^[A-Za-z0-9_-]+$/.test(doc.id) || !['CLAUDE.md','AGENTS.md'].includes(doc.filename) ||
          doc.files.length !== 1 || doc.files[0].path !== doc.filename || doc.files[0].encoding ||
          Buffer.byteLength(doc.files[0].content) > limit || doc.files[0].content.includes('\0'))
        throw new Error('Invalid instruction document in desired state');
      const targets = locations.filter(l =>
        !excludedDestination(desired, l) && instructionEnabled(doc,l,deviceId) &&
        !Object.values(ledger.installs).some(entry => entry.skillId === doc.id &&
          entry.path === l.path && excludedDestination(desired,entry)));
      if (!targets.length) continue;
      const canonicalPath = join(home,'instructions',doc.id,doc.filename);
      const desiredHash = skillRevision(doc.files);
      const desiredPortableHash = portableFilesRevision(doc.files);
      let currentCanonical;
      try {currentCanonical = await snapshot(canonicalPath,doc.filename);}
      catch (error) {
        for (const location of targets) {
          const key = instructionKey(doc.id,location);wanted.add(key);
          receipts.push({kind:'instructions',skillId:doc.id,agent:location.agent,profile:location.profile,project:location.project,
            path:location.path,revision:ledger.installs[key]?.revision ?? '',status:'failed',message:(error as Error).message,timestamp:new Date().toISOString()});
        }
        continue;
      }
      const previousCanonical = ledger.canonicals[doc.id];
      const replaceRequested = (await Promise.all(targets.map(async location => {
        const key = instructionKey(doc.id,location);
        if (desired.instructionResolutions?.[key] !== 'replace') return false;
        const checked = desired.instructionResolutionChecks?.[key];
        if (!checked) return true;
        // Heartbeat snapshots can be stale: re-read before changing the shared
        // store, which would otherwise change every linked destination at once.
        try {return (await snapshot(location.path,doc.filename)).hash === checked;}
        catch {return false;}
      }))).some(Boolean);
      if (currentCanonical.exists && currentCanonical.pointer) {
        canonicalConflicts.set(doc.id,currentCanonical.files);
      } else if (currentCanonical.exists && currentCanonical.portableHash !== desiredPortableHash &&
          (!previousCanonical || (previousCanonical.portableHash
            ? currentCanonical.portableHash !== previousCanonical.portableHash
            : currentCanonical.hash !== previousCanonical.hash)) && !replaceRequested) {
        canonicalConflicts.set(doc.id,currentCanonical.files);
      } else if (currentCanonical.portableHash !== desiredPortableHash) {
        await mkdir(dirname(canonicalPath),{recursive:true});
        if (currentCanonical.exists && (!previousCanonical ||
            (previousCanonical.portableHash
              ? currentCanonical.portableHash !== previousCanonical.portableHash
              : currentCanonical.hash !== previousCanonical.hash)))
          await archiveFiles(archive,doc.id,currentCanonical.files,canonicalPath);
        const stage = canonicalPath + '.equip-stage-' + randomUUID();
        await writeFile(stage,doc.files[0].content,{mode:doc.files[0].mode ?? 0o644});
        await chmod(stage,doc.files[0].mode ?? 0o644);
        await replaceFile(home,ledger,doc.id,canonicalPath,stage,{path:canonicalPath,hash:desiredHash,portableHash:desiredPortableHash,revision:doc.revision},doc.filename,doc.id,archive,true);
      } else {
        ledger.canonicals[doc.id] = {...previousCanonical,path:canonicalPath,hash:currentCanonical.hash,portableHash:desiredPortableHash,revision:doc.revision};
      }
      for (const location of targets) {
        const key = instructionKey(doc.id,location);
        wanted.add(key);
        const previous = ledger.installs[key] ?? Object.values(ledger.installs).find(e => e.skillId === doc.id && e.path === location.path && !e.observed);
        const base = {kind:'instructions' as const,skillId:doc.id,agent:location.agent,profile:location.profile,project:location.project,path:location.path,timestamp:new Date().toISOString()};
        try {
          if (selectedPaths.has(location.path) && selectedPaths.get(location.path) !== doc.id) throw new Error('Two instruction documents select the same file. Disable one or change its destinations.');
          selectedPaths.set(location.path,doc.id);
          const current = await snapshot(location.path,doc.filename);
          let action = desired.instructionResolutions?.[key];
          const checked = desired.instructionResolutionChecks?.[key];
          if (action && checked && current.hash !== checked) {
            receipts.push({...base,revision:previous?.revision ?? '',status:'conflicted',message:'Local instructions changed after review. Review the new version.',localFiles:current.files});continue;
          }
          const canonicalConflict = canonicalConflicts.get(doc.id);
          if (action === 'preserve' || action === 'import') {
            delete ledger.installs[key];
            receipts.push({...base,instructionResolution:action,revision:previous?.revision ?? '',status:'conflicted',message:action === 'import' ? 'Imported local instructions and released management' : 'Preserved local instructions and released management',localFiles:current.files});continue;
          }
          if (canonicalConflict) {
            receipts.push({...base,revision:previous?.revision ?? '',status:'conflicted',message:'Equip instruction store changed locally and was preserved.',localFiles:canonicalConflict});continue;
          }
          const currentDesired = current.portableHash === desiredPortableHash;
          const samePointer = !previous || previous.path === location.path &&
            (previous.pointer === current.pointer || await sameManagedInstruction(home,previous,current,location.path));
          const clean = previous && samePointer && (previous.portableHash
            ? current.portableHash === previous.portableHash
            : current.hash === previous.hash || currentDesired);
          if (current.exists && !currentDesired && (!clean || !samePointer) && action !== 'replace') {
            receipts.push({...base,revision:previous?.revision ?? '',status:'conflicted',managed:Boolean(previous && !previous.observed),message:previous ? 'Local instructions changed and were preserved.' : 'Preexisting instructions have no Equip baseline. Review which version to keep.',localFiles:current.files});continue;
          }
          const alreadyManaged = previous && !previous.observed && samePointer && currentDesired;
          const entry: Entry = {...base,filename:doc.filename,revision:doc.revision,hash:current.hash,portableHash:desiredPortableHash,pointer:current.pointer};
          // Matching preexisting files can be adopted without choosing between
          // versions. Also migrate older workers' observed entries to managed links.
          if (!alreadyManaged) {
            await mkdir(dirname(location.path),{recursive:true});
            if (current.exists && !currentDesired && !clean)
              await archiveFiles(archive,doc.id,current.files,location.path);
            const stage = location.path + '.equip-stage-' + randomUUID();
            try {await symlink(process.platform === 'win32' ? canonicalPath : relative(await realpath(dirname(location.path)),await realpath(canonicalPath)),stage,'file');}
            catch (error) {
              if (!['EPERM','EACCES','ENOTSUP','EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
              await cp(canonicalPath,stage);
            }
            entry.pointer = (await lstat(stage)).isSymbolicLink() ? await readlink(stage) : undefined;
            entry.hash = desiredHash;
            await replaceFile(home,ledger,key,location.path,stage,entry,doc.filename,doc.id,archive);
          }
          ledger.installs[key] = entry;
          const shadowed = location.filename === 'AGENTS.md' && await lstat(join(dirname(location.path),'AGENTS.override.md')).catch(() => null);
          receipts.push({...base,revision:doc.revision,status:shadowed ? 'failed' : 'synchronized',managed:!entry.observed,
            ...(action === 'replace' ? {instructionResolution:action} : {}),
            ...(shadowed ? {message:'Installed, but AGENTS.override.md takes precedence. Move or edit the override to use Equip instructions.'} : location.warning ? {message:location.warning} : {})});
        } catch (error) {await recover(home,ledger,archive);receipts.push({...base,revision:previous?.revision ?? '',status:'failed',message:(error as Error).message});}
      }
    }
    for (const [key,entry] of await instructionRemovalOrder(ledger.installs)) {
      if (wanted.has(key)) continue;
      if (excludedDestination(desired, entry)) continue;
      const base = {kind:'instructions' as const,skillId:entry.skillId,agent:entry.agent,profile:entry.profile,project:entry.project,path:entry.path,revision:entry.revision,timestamp:new Date().toISOString()};
      try {
        if (Object.entries(ledger.installs).some(([k,e]) => k !== key && wanted.has(k) && e.path === entry.path)) {delete ledger.installs[key];continue;}
        const current = await snapshot(entry.path,entry.filename);
        const action = desired.instructionResolutions?.[key];
        const checked = desired.instructionResolutionChecks?.[key];
        const samePointer = current.pointer === entry.pointer || await sameManagedInstruction(home,entry,current,entry.path);
        if (checked && action && current.hash !== checked) {
          receipts.push({...base,status:'conflicted',localFiles:current.files,message:'Local instructions changed after review. Review the new version.'});continue;
        }
        if (!current.exists || entry.observed || action === 'preserve' || action === 'import') {
          delete ledger.installs[key];
          receipts.push({...base,status:action === 'preserve' || action === 'import' ? 'conflicted' : 'synchronized',...(action ? {instructionResolution:action} : {}),localFiles:action ? current.files : undefined,message:'Released instructions; preexisting or preserved files retained.'});
        } else if ((entry.portableHash ? current.portableHash === entry.portableHash : current.hash === entry.hash) && samePointer || action === 'replace') {
          if ((entry.portableHash ? current.portableHash !== entry.portableHash : current.hash !== entry.hash) ||
              !samePointer)
            await archiveFiles(archive,entry.skillId,current.files,entry.path);
          await rm(entry.path,{force:true});
          delete ledger.installs[key];
          receipts.push({...base,status:'synchronized',...(action ? {instructionResolution:action} : {}),message:'Removed managed instructions.'});
        } else receipts.push({...base,status:'conflicted',message:'Managed instructions were not removed because local files changed.',localFiles:current.files});
      } catch (error) {receipts.push({...base,status:'failed',message:(error as Error).message});}
    }
    await atomicJson(ledgerPath(home),ledger);
    const retainedRoot=join(home,'retained','instructions');
    const referenced=new Set(await Promise.all(Object.values(ledger.installs).map(entry=>realpath(entry.path).catch(()=>''))));
    for(const documentDir of await readdir(retainedRoot,{withFileTypes:true}).catch(()=>[])) if(documentDir.isDirectory())
      for(const snapshotDir of await readdir(join(retainedRoot,documentDir.name),{withFileTypes:true}).catch(()=>[])) if(snapshotDir.isDirectory()) {
        const path=join(retainedRoot,documentDir.name,snapshotDir.name);
        const files=await readdir(path).catch(()=>[]);
        const used=(await Promise.all(files.map(file=>realpath(join(path,file)).catch(()=>'')))).some(file=>referenced.has(file));
        if(!used)await rm(path,{recursive:true,force:true});
      }
    return receipts;
  } finally {await lock.close();await rm(lockPath,{force:true});}
}

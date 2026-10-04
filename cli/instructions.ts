import { randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { DesiredState, InstructionFilename, InstructionLocation, Instructions, Receipt, SkillFile } from '../shared/types.ts';
import { skillRevision } from '../shared/library.ts';
import { instructionEnabled, instructionKey } from '../shared/instructions.ts';
import { discoverConfigurationRoots, type ProfileDiscoveryOptions } from './profiles.ts';
import type { AgentTarget } from './sync.ts';

const limit = 256 * 1024;
interface Entry { skillId: string; agent: string; profile?: string; project?: string; path: string; filename: InstructionFilename; revision: string; hash: string; pointer?: string; observed?: boolean; originalBackup?: string; transaction?: string }
interface Canonical { path: string; hash: string; revision: string; transaction?: string }
interface Ledger { installs: Record<string, Entry>; canonicals: Record<string, Canonical> }
interface Transaction { path: string; stage: string; old: string; hadOld: boolean; id: string; key: string; canonical?: boolean }
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
  return {exists:true, files, hash:skillRevision(files), pointer:info.isSymbolicLink() ? await readlink(path) : undefined};
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

async function backup(path: string, home: string) {
  const folder = join(home,'backups',`instructions-${Date.now()}-${randomUUID()}`);
  await mkdir(folder,{recursive:true});
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    await writeFile(join(folder,'original-link.json'),JSON.stringify({path,target:await readlink(path)}),{mode:0o600});
    await cp(await realpath(path),join(folder,'contents'),{preserveTimestamps:true});
  } else await cp(path,join(folder,'contents'),{preserveTimestamps:true});
  return folder;
}

async function recover(home: string, ledger: Ledger) {
  const p = join(home,'instructions-transaction.json');
  const journal = await json<Transaction|undefined>(p,undefined);
  if (!journal) return;
  const entry = journal.canonical ? ledger.canonicals[journal.key] : ledger.installs[journal.key];
  const committed = entry?.transaction === journal.id;
  const old = await lstat(journal.old).catch(() => null);
  if (!committed && old) {
    // Preserve any edits made during the interruption before restoring the
    // last committed file. Recovery must not silently discard local work.
    if (await lstat(journal.path).catch(() => null)) await backup(journal.path,home);
    await rm(journal.path,{force:true});
    await rename(journal.old,journal.path);
  } else if (!committed && !journal.hadOld && !await lstat(journal.stage).catch(() => null)) {
    if (await lstat(journal.path).catch(() => null)) await backup(journal.path,home);
    await rm(journal.path,{force:true});
  }
  await rm(journal.stage,{force:true});
  if (committed) await rm(journal.old,{force:true});
  await rm(p,{force:true});
}

async function replaceFile(home: string, ledger: Ledger, key: string, destination: string, stage: string, entry: Entry|Canonical, canonical = false) {
  const transaction = randomUUID();
  const old = destination + '.equip-old-' + transaction;
  const hadOld = Boolean(await lstat(destination).catch(() => null));
  const journal: Transaction = {path:destination,stage,old,hadOld,id:transaction,key,canonical};
  await atomicJson(join(home,'instructions-transaction.json'),journal);
  if (hadOld) await rename(destination,old);
  await rename(stage,destination);
  entry.transaction = transaction;
  if (canonical) ledger.canonicals[key] = entry as Canonical;
  else ledger.installs[key] = entry as Entry;
  try {await atomicJson(ledgerPath(home),ledger);}
  catch (error) {
    const persisted = await json<Ledger>(ledgerPath(home),{installs:{},canonicals:{}});
    await recover(home,persisted);
    ledger.installs = persisted.installs;ledger.canonicals = persisted.canonicals;
    throw error;
  }
  await recover(home,ledger);
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
        if (!current.exists || current.hash === skillRevision(doc.files)) continue;
        if (!entry || entry.revision !== doc.revision || current.pointer !== entry.pointer) unknown = true;
        else if (current.hash !== entry.hash) candidates.push(current.files);
      } catch (error) {errors.push((error as Error).message);unknown = true;}
    }
    if (!candidates.length) continue;
    const hashes = new Set(candidates.map(skillRevision));
    if (unknown || hashes.size > 1) {errors.push(`${doc.title}: different local versions need review.`);continue;}
    try {await publish({instructionId:doc.id,baseRevision:doc.revision,files:candidates[0]});changed = true;}
    catch (error) {errors.push(`${doc.title}: ${(error as Error).message}`);}
  }
  return {changed,errors};
}

export async function synchronizeInstructions(desired: DesiredState, locations: InstructionLocation[], home: string, deviceId?: string): Promise<Receipt[]> {
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
    await recover(home,ledger);
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
      const targets = locations.filter(l => instructionEnabled(doc,l,deviceId));
      if (!targets.length) continue;
      const canonicalPath = join(home,'instructions',doc.id,doc.filename);
      const desiredHash = skillRevision(doc.files);
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
      } else if (currentCanonical.exists && currentCanonical.hash !== desiredHash &&
          (!previousCanonical || currentCanonical.hash !== previousCanonical.hash) && !replaceRequested) {
        canonicalConflicts.set(doc.id,currentCanonical.files);
      } else if (currentCanonical.hash !== desiredHash) {
        await mkdir(dirname(canonicalPath),{recursive:true});
        if (currentCanonical.exists) await backup(canonicalPath,home);
        const stage = canonicalPath + '.equip-stage-' + randomUUID();
        await writeFile(stage,doc.files[0].content,{mode:doc.files[0].mode ?? 0o644});
        await chmod(stage,doc.files[0].mode ?? 0o644);
        await replaceFile(home,ledger,doc.id,canonicalPath,stage,{path:canonicalPath,hash:desiredHash,revision:doc.revision},true);
      } else {
        ledger.canonicals[doc.id] = {...previousCanonical,path:canonicalPath,hash:desiredHash,revision:doc.revision};
      }
      for (const location of targets) {
        const key = instructionKey(doc.id,location);
        wanted.add(key);
        const previous = ledger.installs[key] ?? Object.values(ledger.installs).find(e => e.skillId === doc.id && e.path === location.path && !e.observed);
        const base = {kind:'instructions' as const,skillId:doc.id,agent:location.agent,profile:location.profile,project:location.project,path:location.path,timestamp:new Date().toISOString()};
        try {
          if (selectedPaths.has(location.path) && selectedPaths.get(location.path) !== doc.id) throw new Error('Two instruction documents select the same file. Disable one or change its destinations.');
          selectedPaths.set(location.path,doc.id);
          if (location.agent === 'windsurf' && doc.files[0].content.length > 6000) throw new Error('Windsurf global rules are limited to 6,000 characters. The previous file was preserved.');
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
          const currentDesired = current.hash === desiredHash;
          const samePointer = !previous || previous.path === location.path && previous.pointer === current.pointer;
          const clean = previous && samePointer && current.hash === previous.hash;
          if (current.exists && !currentDesired && (!clean || !samePointer) && action !== 'replace') {
            receipts.push({...base,revision:previous?.revision ?? '',status:'conflicted',managed:Boolean(previous && !previous.observed),message:previous ? 'Local instructions changed and were preserved.' : 'Preexisting instructions have no Equip baseline. Review which version to keep.',localFiles:current.files});continue;
          }
          const alreadyManaged = previous && !previous.observed && samePointer && currentDesired;
          const entry: Entry = {...base,filename:doc.filename,revision:doc.revision,hash:desiredHash,pointer:current.pointer,originalBackup:previous?.originalBackup};
          // Matching preexisting files can be adopted without choosing between
          // versions. Back up their original file/link and converge on one store.
          // Also migrate older workers' observed entries to managed links.
          if (!alreadyManaged) {
            await mkdir(dirname(location.path),{recursive:true});
            if (current.exists) {
              const saved = await backup(location.path,home);
              if (!previous || previous.observed) entry.originalBackup = saved;
            }
            const stage = location.path + '.equip-stage-' + randomUUID();
            try {await symlink(process.platform === 'win32' ? canonicalPath : relative(await realpath(dirname(location.path)),await realpath(canonicalPath)),stage,'file');}
            catch (error) {
              if (!['EPERM','EACCES','ENOTSUP','EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
              await cp(canonicalPath,stage);
            }
            entry.pointer = (await lstat(stage)).isSymbolicLink() ? await readlink(stage) : undefined;
            await replaceFile(home,ledger,key,location.path,stage,entry);
          }
          ledger.installs[key] = entry;
          const shadowed = location.filename === 'AGENTS.md' && await lstat(join(dirname(location.path),'AGENTS.override.md')).catch(() => null);
          receipts.push({...base,revision:doc.revision,status:shadowed ? 'failed' : 'synchronized',managed:!entry.observed,
            ...(action === 'replace' ? {instructionResolution:action} : {}),
            ...(shadowed ? {message:'Installed, but AGENTS.override.md takes precedence. Move or edit the override to use Equip instructions.'} : location.warning ? {message:location.warning} : {})});
        } catch (error) {await recover(home,ledger);receipts.push({...base,revision:previous?.revision ?? '',status:'failed',message:(error as Error).message});}
      }
    }
    for (const [key,entry] of Object.entries(ledger.installs)) {
      if (wanted.has(key)) continue;
      const base = {kind:'instructions' as const,skillId:entry.skillId,agent:entry.agent,profile:entry.profile,project:entry.project,path:entry.path,revision:entry.revision,timestamp:new Date().toISOString()};
      try {
        if (Object.entries(ledger.installs).some(([k,e]) => k !== key && wanted.has(k) && e.path === entry.path)) {delete ledger.installs[key];continue;}
        const current = await snapshot(entry.path,entry.filename);
        const action = desired.instructionResolutions?.[key];
        const checked = desired.instructionResolutionChecks?.[key];
        if (checked && action && current.hash !== checked) {
          receipts.push({...base,status:'conflicted',localFiles:current.files,message:'Local instructions changed after review. Review the new version.'});continue;
        }
        if (!current.exists || entry.observed || action === 'preserve' || action === 'import') {
          delete ledger.installs[key];
          receipts.push({...base,status:action === 'preserve' || action === 'import' ? 'conflicted' : 'synchronized',...(action ? {instructionResolution:action} : {}),localFiles:action ? current.files : undefined,message:'Released instructions; preexisting or preserved files retained.'});
        } else if (current.hash === entry.hash && current.pointer === entry.pointer || action === 'replace') {
          if (current.hash !== entry.hash || current.pointer !== entry.pointer) await backup(entry.path,home);
          if (entry.originalBackup) {
            const stage = entry.path + '.equip-stage-' + randomUUID();
            const original = await json<{target?:string}>(join(entry.originalBackup,'original-link.json'),{});
            if (original.target) await symlink(original.target,stage,'file');
            else await cp(join(entry.originalBackup,'contents'),stage,{preserveTimestamps:true});
            await replaceFile(home,ledger,key,entry.path,stage,{...entry,observed:true});
          } else await rm(entry.path,{force:true});
          delete ledger.installs[key];
          receipts.push({...base,status:'synchronized',...(action ? {instructionResolution:action} : {}),message:entry.originalBackup ? 'Removed Equip instructions and restored the preexisting file or link.' : 'Removed managed instructions.'});
        } else receipts.push({...base,status:'conflicted',message:'Managed instructions were not removed because local files changed.',localFiles:current.files});
      } catch (error) {receipts.push({...base,status:'failed',message:(error as Error).message});}
    }
    await atomicJson(ledgerPath(home),ledger);
    return receipts;
  } finally {await lock.close();await rm(lockPath,{force:true});}
}

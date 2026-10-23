import { readFile } from 'node:fs/promises';
import { ImprovementStore } from './store.ts';
import { exportDirectory, importDirectory } from './transfer.ts';
import { snapshot } from './snapshot.ts';
import { compare, evaluate } from './evaluation.ts';
import { choice, identifier, trialInput } from './validation.ts';
import type { EntryKind } from './types.ts';

const kinds:EntryKind[]=['configuration','run','feedback','case','experiment','trial','evaluation'];
export async function improvementCommand(args:string[], home:string) {
  const command=args.shift() ?? 'help';
  if(command==='help') return { schema:1,feature:'improvement-loop',storage:'Local only: EQUIP_HOME/improvement/ledger.sqlite',commands:['snapshot --provider NAME --model NAME --harness NAME [--settings JSON] [--instructions PATH] [--skill DIR]','record --file JSON','feedback --file JSON','case --file JSON','experiment --file JSON','evaluate ID --runner FILE.mjs [--repetitions 3] [--timeout-ms 60000]','trial --file JSON (explicitly reconcile an uncertain trial)','compare ID','summary [--days 7]','show KIND ID','export [--directory NEW_PATH]','import --file JSON | --directory PATH'],runner:'Explicit trusted Node runner, JSON stdin/stdout; operator supplies the isolated environment and approves model usage. No automatic model calls or remote uploads.' };
  const flags=new Map<string,string[]>(); const positional:string[]=[];
  for(let i=0;i<args.length;i++) {
    if(args[i].startsWith('--')) {
      const key=args[i].slice(2);const value=args[++i];
      if(value===undefined || value.startsWith('--')) throw new Error(`--${key} needs a value.`);
      flags.set(key,[...(flags.get(key)??[]),value]);
    } else positional.push(args[i]);
  }
  const allowed:Record<string,string[]>={snapshot:['provider','model','harness','settings','instructions','skill'],record:['file'],feedback:['file'],case:['file'],experiment:['file'],trial:['file'],evaluate:['runner','repetitions','timeout-ms'],compare:[],summary:['days'],show:[],export:['directory'],import:['file','directory']};
  if(!allowed[command]) throw new Error('Unknown improvement command. Run equip improve help.');
  for(const [key,values] of flags) {
    if(!allowed[command].includes(key)) throw new Error(`Unknown option --${key} for ${command}.`);
    if(values.length>1 && !['instructions','skill'].includes(key)) throw new Error(`--${key} may be supplied once.`);
  }
  const expected=command==='show'?2:['evaluate','compare'].includes(command)?1:0;
  if(positional.length!==expected) throw new Error(`${command} expects ${expected} positional argument(s). Run equip improve help.`);
  const option=(key:string)=>flags.get(key)?.[0];
  const required=(key:string)=>{const value=option(key);if(!value)throw new Error(`--${key} is required.`);return value;};
  const input=async()=>{
    const file=required('file');let body:string;
    if(file==='-') { const chunks:Buffer[]=[];let size=0;for await(const part of process.stdin){const chunk=Buffer.from(part);size+=chunk.length;if(size>2*1024*1024)throw new Error('Improvement input exceeds 2 MiB.');chunks.push(chunk);}body=Buffer.concat(chunks).toString('utf8'); }
    else { body=await readFile(file,'utf8');if(Buffer.byteLength(body)>2*1024*1024)throw new Error('Improvement input exceeds 2 MiB.'); }
    try{return JSON.parse(body);}catch{throw new Error('Improvement input must be valid JSON.');}
  };
  const store=await ImprovementStore.open(home);
  try {
    switch(command) {
      case 'snapshot': {const configuration=await snapshot({provider:required('provider'),model:required('model'),harness:required('harness'),settings:JSON.parse(option('settings')??'{}'),instructions:flags.get('instructions')??[],skills:flags.get('skill')??[]});return {configurationId:store.recordConfiguration(configuration),configuration};}
      case 'record': return store.recordRun(await input());
      case 'feedback': return store.recordFeedback(await input());
      case 'case': return store.recordCase(await input());
      case 'experiment': return store.recordExperiment(await input());
      case 'trial': return store.finishTrial(trialInput(await input()));
      case 'evaluate': return await evaluate(store,identifier(positional[0]),required('runner'),{repetitions:Number(option('repetitions')??3),timeoutMs:Number(option('timeout-ms')??60000)});
      case 'compare': return compare(store,identifier(positional[0]));
      case 'summary': return store.summary(Number(option('days')??7));
      case 'show': return store.require(choice(positional[0],kinds,'kind'),identifier(positional[1]));
      case 'export': return option('directory') ? await exportDirectory(store,required('directory')) : store.export();
      case 'import': { if(option('directory')&&option('file'))throw new Error('Choose --file or --directory.');return option('directory') ? await importDirectory(store,required('directory')) : store.import(await input()); }
    }
  } finally {store.close();}
}

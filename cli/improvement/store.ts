import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaseInput, Configuration, EntryKind, ExperimentInput, FeedbackInput, RunInput, Trial } from './types.ts';
import { canonical, caseInput, configuration, digest, experimentInput, feedbackInput, object, runInput, trialInput } from './validation.ts';

export class ImprovementStore {
  constructor(private db: DatabaseSync, private now = () => new Date()) {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) throw new Error('This improvement ledger requires a newer Equip CLI.');
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entries (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS entries_time ON entries(kind,created_at);
      PRAGMA user_version=1;`);
  }
  static async open(home: string) {
    const directory = join(home, 'improvement');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'ledger.sqlite');
    const db = new DatabaseSync(path, { timeout: 5000 });
    try { await chmod(path, 0o600); return new ImprovementStore(db); }
    catch (error) { db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get<T = any>(kind: EntryKind, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM entries WHERE kind=? AND id=?').get(kind, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  require<T = any>(kind: EntryKind, id: string): T {
    const result = this.get<T>(kind, id); if (!result) throw new Error(`${kind} ${id} was not found.`); return result;
  }
  all<T = any>(kind: EntryKind, since = ''): T[] {
    return (this.db.prepare('SELECT data FROM entries WHERE kind=? AND created_at>=? ORDER BY created_at,rowid').all(kind,since) as Array<{ data:string }>).map(r => JSON.parse(r.data));
  }
  private put<T>(kind: EntryKind, id: string, value: T): T {
    this.db.prepare('INSERT INTO entries(kind,id,data,created_at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO NOTHING').run(kind,id,canonical(value),this.now().toISOString());
    if (canonical(this.get(kind,id)) !== canonical(value)) throw new Error(`${kind} ${id} already exists with different evidence. Use a new id.`);
    return value;
  }
  recordConfiguration(value: unknown) {
    const c = configuration(value); const id = digest(c); this.put('configuration',id,c); return id;
  }
  recordRun(value: unknown) {
    const run = runInput(value);
    return this.transaction(() => { const configurationId = this.recordConfiguration(run.configuration); this.put('run',run.id,run); return { ...run, configurationId }; });
  }
  recordFeedback(value: unknown) {
    const f = feedbackInput(value); this.require('run',f.runId); return this.put('feedback',f.id,f);
  }
  recordCase(value: unknown) {
    const c = caseInput(value); this.require('run',c.sourceRunId); return this.put('case',c.id,c);
  }
  recordExperiment(value: unknown) {
    const e = experimentInput(value); this.require('configuration',e.baseline); this.require('configuration',e.candidate);
    e.caseIds.forEach(id => this.require('case',id)); return this.put('experiment',e.id,e);
  }
  bindEvaluation(experimentId: string, runnerSha256: string, runtime = { node: process.versions.node, platform: process.platform as string, arch: process.arch as string }) {
    this.require('experiment',experimentId); return this.put('evaluation',experimentId,{ experimentId, runnerSha256, runtime });
  }
  reserveTrial(trial: Trial) {
    trialInput(trial);
    return this.transaction(() => {
      const existing = this.get<Trial>('trial',trial.id);
      if (existing) {
        if (existing.state === 'running') throw new Error(`Trial ${trial.id} has uncertain execution. Reconcile it before resuming.`);
        return false;
      }
      this.put('trial',trial.id,trial); return true;
    });
  }
  finishTrial(trial: Trial) {
    trialInput(trial);
    const prior = this.require<Trial>('trial',trial.id);
    if (prior.state !== 'running') throw new Error('A completed trial cannot be replaced.');
    for (const key of ['id','experimentId','caseId','arm','replicate','configurationId','runnerSha256'] as const) if (prior[key] !== trial[key]) throw new Error('Trial identity changed.');
    const e=this.require<ExperimentInput>('experiment',trial.experimentId);
    if (!e.caseIds.includes(trial.caseId) || e[trial.arm]!==trial.configurationId || this.require<any>('evaluation',e.id).runnerSha256!==trial.runnerSha256 || trial.state!=='finished') throw new Error('Trial does not match its experiment.');
    const changed=this.db.prepare('UPDATE entries SET data=? WHERE kind=? AND id=? AND data=?').run(canonical(trial),'trial',trial.id,canonical(prior));
    if (!changed.changes) throw new Error('Trial changed concurrently; reconcile its evidence.');
    return trial;
  }
  summary(days = 7) {
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('days must be an integer between 1 and 3650.');
    const since = new Date(this.now().getTime() - days * 86400000).toISOString();
    const runs = this.all<RunInput>('run',since); const runIds = new Set(runs.map(r => r.id));
    const feedback = this.all<FeedbackInput>('feedback').filter(f => runIds.has(f.runId));
    const latestUser = new Map<string,FeedbackInput>();
    for (const f of feedback) if (f.source === 'user' && f.verdict) latestUser.set(f.runId,f);
    const count = (values: string[]) => Object.fromEntries([...new Set(values)].map(v => [v,values.filter(x => x === v).length]));
    const metric = (key: 'elapsedMs' | 'costUsd' | 'humanMinutes') => { const values = runs.flatMap(r => r[key] === undefined ? [] : [r[key]!]); return { known:values.length, missing:runs.length-values.length, total:values.length ? values.reduce((a,b)=>a+b,0) : null }; };
    const uniqueReasons=(entries:Array<{runId:string;reason:string}>)=>count([...new Map(entries.map(e=>[`${e.runId}:${e.reason}`,e.reason])).values()]);
    return { days, runs:runs.length, status:count(runs.map(r=>r.status)), verification:count(runs.map(r=>r.verification)), satisfaction:{ rated:latestUser.size, unknown:runs.length-latestUser.size, verdicts:count([...latestUser.values()].map(f=>f.verdict!)) }, userReasons:uniqueReasons(feedback.filter(f=>f.source==='user').flatMap(f=>f.reasons.map(reason=>({runId:f.runId,reason})))), agentReasons:uniqueReasons([...runs.flatMap(r=>r.observations.map(o=>({runId:r.id,reason:o.reason}))),...feedback.filter(f=>f.source==='agent').flatMap(f=>f.reasons.map(reason=>({runId:f.runId,reason})))]), measurements:{ elapsedMs:metric('elapsedMs'),humanMinutes:metric('humanMinutes'),costUsd:metric('costUsd') }, cases:this.all('case').length, experiments:this.all('experiment').length };
  }
  *exportEntries(dependencyOrder = false) {
    const ordering = dependencyOrder ? "CASE kind WHEN 'configuration' THEN 0 WHEN 'run' THEN 1 WHEN 'feedback' THEN 2 WHEN 'case' THEN 3 WHEN 'experiment' THEN 4 WHEN 'evaluation' THEN 5 ELSE 6 END,created_at,rowid" : 'created_at,kind,rowid';
    for (const raw of this.db.prepare(`SELECT kind,id,data,created_at AS createdAt FROM entries ORDER BY ${ordering}`).iterate()) {
      const row = raw as {kind:EntryKind;id:string;data:string;createdAt:string};
      yield { ...row,data:JSON.parse(row.data) };
    }
  }
  export() {
    // Insertion order breaks timestamp ties. Sorting by id would reverse later
    // feedback during a round trip and change the user's latest verdict.
    return { schema:1, entries:[...this.exportEntries()] };
  }
  import(value:unknown, precedingFeedback: ReadonlySet<string> = new Set()) {
    const v=object(value,['schema','entries']);
    if(v.schema!==1 || !Array.isArray(v.entries) || v.entries.length>10000) throw new Error('Expected a schema 1 ledger export with at most 10000 entries.');
    const order:EntryKind[]=['configuration','run','feedback','case','experiment','evaluation','trial'];
    const entries=v.entries.map((raw:unknown)=>{
      const e=object(raw,['kind','id','data','createdAt']);
      if(!order.includes(e.kind) || typeof e.createdAt!=='string' || !Number.isFinite(Date.parse(e.createdAt))) throw new Error('Invalid exported entry.');
      return e;
    });
    return this.transaction(()=>{
      const previousFeedback=new Set<string>();
      for(const e of entries.sort((a,b)=>order.indexOf(a.kind)-order.indexOf(b.kind))) {
        const existed=this.get(e.kind,e.id);
        if(existed && e.kind==='feedback') previousFeedback.add(e.id);
        switch(e.kind) {
          case 'configuration': if(this.recordConfiguration(e.data)!==e.id) throw new Error('Configuration digest mismatch.'); break;
          case 'run': { const run=runInput(e.data); if(run.id!==e.id) throw new Error('Run id mismatch.'); this.require('configuration',digest(run.configuration)); this.put('run',run.id,run); break; }
          case 'feedback': if(feedbackInput(e.data).id!==e.id) throw new Error('Feedback id mismatch.'); this.recordFeedback(e.data); break;
          case 'case': if(caseInput(e.data).id!==e.id) throw new Error('Case id mismatch.'); this.recordCase(e.data); break;
          case 'experiment': if(experimentInput(e.data).id!==e.id) throw new Error('Experiment id mismatch.'); this.recordExperiment(e.data); break;
          case 'evaluation': { const d=object(e.data,['experimentId','runnerSha256','runtime']); const runtime=object(d.runtime,['node','platform','arch']); if(d.experimentId!==e.id || !/^[a-f0-9]{64}$/.test(d.runnerSha256) || ['node','platform','arch'].some(k=>typeof runtime[k]!=='string'||!runtime[k])) throw new Error('Evaluation identity mismatch.'); this.bindEvaluation(e.id,d.runnerSha256,runtime as {node:string;platform:string;arch:string}); break; }
          case 'trial': { const t=trialInput(e.data); if(t.id!==e.id) throw new Error('Trial id mismatch.'); const exp=this.require<ExperimentInput>('experiment',t.experimentId); if(!exp.caseIds.includes(t.caseId)||exp[t.arm]!==t.configurationId||this.require<any>('evaluation',exp.id).runnerSha256!==t.runnerSha256) throw new Error('Trial does not match its experiment.'); this.put('trial',t.id,t); break; }
        }
        if(!existed) this.db.prepare('UPDATE entries SET created_at=? WHERE kind=? AND id=?').run(new Date(e.createdAt).toISOString(),e.kind,e.id);
      }
      // Timestamp ties carry source insertion order. An overlapping import must
      // never silently append older feedback after a verdict already present.
      const incoming = entries.filter(e=>e.kind==='feedback');
      const sourceIds = new Set(incoming.map(e=>e.id));
      const sourceGroups = new Map<string,string[]>();
      for (const e of incoming) {
        const key=canonical([e.data.runId,new Date(e.createdAt).toISOString()]);
        const group=sourceGroups.get(key)??[];group.push(e.id);sourceGroups.set(key,group);
      }
      // Inspect only the incoming timestamp/run groups. Chunked restores must
      // not parse every prior feedback body again for each incoming chunk.
      const tiedFeedback=this.db.prepare("SELECT id FROM entries WHERE kind='feedback' AND created_at=? AND json_extract(data,'$.runId')=? ORDER BY rowid");
      for(const [key,ids] of sourceGroups) {
        const [runId,createdAt]=JSON.parse(key) as [string,string];
        const actual=(tiedFeedback.all(createdAt,runId) as Array<{id:string}>).map(row=>row.id);
        const firstIncoming=actual.findIndex(id=>sourceIds.has(id));
        if(canonical(actual.filter(id=>sourceIds.has(id)))!==canonical(ids) || (ids.some(id=>!previousFeedback.has(id)) && actual.some((id,index)=>!sourceIds.has(id)&&(!precedingFeedback.has(id)||index>firstIncoming)))) throw new Error('Ambiguous feedback ordering in overlapping import; restore to a new ledger or reconcile the source ordering.');
      }
      return { imported:entries.length };
    });
  }
}

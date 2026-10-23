import { createHash } from 'node:crypto';
import type { CaseInput, Configuration, ExperimentInput, FeedbackInput, RunInput, RunnerResult, Trial } from './types.ts';

export const reasons = ['unnecessary-questions', 'unfinished', 'incorrect', 'overengineered', 'poor-design', 'slow', 'cost', 'scope', 'authorization', 'other'] as const;
export function object(value: unknown, fields: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  const result = value as Record<string, any>;
  for (const key of Object.keys(result)) if (!fields.includes(key)) throw new Error(`Unknown field: ${key}`);
  return result;
}
export function text(value: unknown, field: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${field} must be nonempty text of at most ${max} characters.`);
  return value;
}
export function identifier(value: unknown): string {
  const id = text(value, 'id', 200);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/%-]*$/.test(id)) throw new Error('Invalid id.');
  return id;
}
export function choice<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new Error(`${field} must be one of ${values.join(', ')}.`);
  return value as T;
}
export function number(value: unknown, field: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new Error(`${field} must be a finite nonnegative ${integer ? 'integer' : 'number'}.`);
  return value;
}
function list(value: unknown, field: string, max = 100): any[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${field} must be an array with at most ${max} entries.`);
  return value;
}
export const evidence = (value: unknown) => list(value, 'evidence').map(item => text(item, 'evidence'));
function optionalNumbers(value: Record<string, any>) {
  for (const key of ['elapsedMs', 'humanMinutes', 'costUsd']) if (value[key] !== undefined) number(value[key], key);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function configuration(value: unknown): Configuration {
  const v = object(value, ['provider','model','harness','settings','instructions','skills','environment','basis']);
  for (const k of ['provider','model','harness']) text(v[k], k, 200);
  choice(v.basis, ['declared'], 'basis');
  if (!v.settings || typeof v.settings !== 'object' || Array.isArray(v.settings)) throw new Error('settings must be an object.');
  for (const [key, setting] of Object.entries(v.settings)) {
    text(key, 'setting name', 100);
    if (['apikey','token','accesstoken','secret','password','authorization'].includes(key.toLowerCase().replace(/[^a-z]/g,''))) throw new Error('Credentials must not be stored in configuration settings.');
    if (!['string','boolean','number'].includes(typeof setting) || (typeof setting === 'number' && !Number.isFinite(setting))) throw new Error('Settings must be scalar values.');
    if (typeof setting === 'string') text(setting, 'setting', 1000);
  }
  for (const item of list(v.instructions, 'instructions')) {
    object(item, ['path','sha256']); text(item.path, 'instruction path');
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid instruction SHA-256.');
  }
  for (const item of list(v.skills, 'skills')) {
    object(item, ['name','path','revision']); text(item.name, 'skill name', 100); text(item.path, 'skill path'); text(item.revision, 'skill revision', 200);
  }
  const env = object(v.environment, ['node','platform','arch']);
  for (const key of ['node','platform','arch']) text(env[key], key, 100);
  return v as Configuration;
}
export function runInput(value: unknown): RunInput {
  const v = object(value, ['id','title','configuration','status','acceptance','verification','observations','session','repository','pr','elapsedMs','humanMinutes','costUsd']);
  identifier(v.id); text(v.title, 'title'); configuration(v.configuration);
  choice(v.status, ['completed','blocked','failed'], 'status');
  choice(v.verification, ['verified','partial','unverified'], 'verification');
  const a = object(v.acceptance, ['met','total','evidence']);
  number(a.met, 'met', true); number(a.total, 'total', true); evidence(a.evidence);
  if (a.total < 1 || a.met > a.total || (v.status === 'completed' && a.met !== a.total)) throw new Error('Completed runs must account for every acceptance criterion.');
  if (v.verification === 'verified' && !a.evidence.length) throw new Error('Verified runs require evidence.');
  for (const o of list(v.observations, 'observations')) { object(o, ['reason','evidence','source']); choice(o.reason, reasons, 'reason'); text(o.evidence, 'observation evidence'); choice(o.source, ['agent','check'], 'observation source'); }
  for (const key of ['session','repository','pr']) if (v[key] !== undefined) text(v[key], key);
  optionalNumbers(v);
  return v as RunInput;
}
export function feedbackInput(value: unknown): FeedbackInput {
  const v = object(value, ['id','runId','source','verdict','reasons','note']); identifier(v.id); identifier(v.runId);
  choice(v.source, ['user','agent'], 'source');
  if (v.verdict !== undefined) choice(v.verdict, ['delegate-again','needed-steering','would-redo'], 'verdict');
  if (v.source !== 'user' && v.verdict !== undefined) throw new Error('Only explicit user feedback can assign satisfaction.');
  list(v.reasons, 'reasons').forEach(r => choice(r, reasons, 'reason')); text(v.note, 'note', 16000);
  return v as FeedbackInput;
}
export function caseInput(value: unknown): CaseInput {
  const v = object(value, ['id','title','prompt','expected','sourceRunId','kind']); identifier(v.id); identifier(v.sourceRunId);
  for (const k of ['title','prompt','expected']) text(v[k], k, 16000);
  choice(v.kind, ['regression','capability'], 'kind'); return v as CaseInput;
}
export function experimentInput(value: unknown): ExperimentInput {
  const v = object(value, ['id','hypothesis','change','baseline','candidate','caseIds','environment','metric']); identifier(v.id); identifier(v.baseline); identifier(v.candidate);
  for (const k of ['hypothesis','change','environment']) text(v[k], k);
  const ids = list(v.caseIds, 'caseIds'); ids.forEach(identifier);
  if (!ids.length || ids.length !== new Set(ids).size) throw new Error('caseIds must be nonempty and unique.');
  choice(v.metric, ['pass-rate','latency','cost','human-effort'], 'metric'); return v as ExperimentInput;
}
export function runnerResult(value: unknown): RunnerResult {
  const v = object(value, ['grade','evidence','costUsd','humanMinutes']); choice(v.grade, ['pass','fail','unknown'], 'grade'); evidence(v.evidence);
  if (v.grade !== 'unknown' && !v.evidence.length) throw new Error('A pass or fail requires evidence.');
  optionalNumbers(v); return v as RunnerResult;
}
export function trialInput(value: unknown): Trial {
  const v=object(value,['id','experimentId','caseId','arm','replicate','configurationId','runnerSha256','state','grade','evidence','elapsedMs','costUsd','humanMinutes','failure']);
  for (const k of ['id','experimentId','caseId','configurationId']) identifier(v[k]);
  choice(v.arm,['baseline','candidate'],'arm'); choice(v.state,['running','finished'],'state');
  number(v.replicate,'replicate',true); if (v.replicate<1 || v.replicate>20) throw new Error('Invalid replicate.');
  if (!/^[a-f0-9]{64}$/.test(v.runnerSha256)) throw new Error('Invalid runner SHA-256.');
  runnerResult({grade:v.grade,evidence:v.evidence,...(v.costUsd===undefined?{}:{costUsd:v.costUsd}),...(v.humanMinutes===undefined?{}:{humanMinutes:v.humanMinutes})});
  optionalNumbers(v); if(v.failure!==undefined) text(v.failure,'failure');
  if(v.id!==digest([v.experimentId,v.caseId,v.arm,v.replicate])) throw new Error('Trial id does not match its identity.');
  return v as Trial;
}

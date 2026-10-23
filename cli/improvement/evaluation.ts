import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import type { CaseInput, Configuration, ExperimentInput, RunnerResult, Trial } from './types.ts';
import { ImprovementStore } from './store.ts';
import { canonical, digest, runnerResult } from './validation.ts';

export interface RunnerRequest {
  schema: 1;
  experimentId: string;
  environment: string;
  case: CaseInput;
  configuration: Configuration;
  arm: 'baseline' | 'candidate';
  replicate: number;
}
export type Executor = (runner: string, request: RunnerRequest, timeoutMs: number) => Promise<RunnerResult>;

// Only an explicitly supplied runner is executable. Case text is stdin data and
// never a command. The runner owns its sandbox, model usage, and outcome checks.
export const executeRunner: Executor = (runner, request, timeoutMs) => new Promise((resolveResult,reject) => {
  const child = execFile(process.execPath, [runner], { timeout:timeoutMs, killSignal:'SIGKILL', maxBuffer:1024*1024, windowsHide:true }, (error,stdout) => {
    if (error) { reject(new Error(error.killed ? 'Runner timed out; execution was not retried.' : 'Runner failed; inspect the runner in its isolated environment.')); return; }
    try { resolveResult(runnerResult(JSON.parse(stdout))); }
    catch { reject(new Error('Runner must emit one valid RunnerResult JSON object.')); }
  });
  child.stdin!.on('error', () => {}); // The exit callback reports an early exit.
  child.stdin!.end(JSON.stringify(request));
});

export async function evaluate(store: ImprovementStore, experimentId: string, runnerPath: string, options: { repetitions?:number; timeoutMs?:number; execute?:Executor } = {}) {
  const repetitions = options.repetitions ?? 3;
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error('repetitions must be between 1 and 20.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('timeout-ms must be between 1 and 3600000.');
  const runner = resolve(runnerPath);
  if (!/\.(mjs|cjs|js)$/.test(runner)) throw new Error('Supply a trusted local Node runner ending in .mjs, .cjs, or .js.');
  const runnerSha256 = createHash('sha256').update(await readFile(runner)).digest('hex');
  const experiment = store.require<ExperimentInput>('experiment',experimentId);
  store.bindEvaluation(experimentId,runnerSha256);
  const execute = options.execute ?? executeRunner;
  const results: Trial[] = [];
  for (const caseId of experiment.caseIds) for (let replicate = 1; replicate <= repetitions; replicate++) {
    // Alternate order so the candidate does not always inherit the warm cache.
    const arms = replicate % 2 ? ['baseline','candidate'] as const : ['candidate','baseline'] as const;
    for (const arm of arms) {
      const configurationId = experiment[arm];
      const trial: Trial = { id:digest([experimentId,caseId,arm,replicate]),experimentId,caseId,arm,replicate,configurationId,runnerSha256,state:'running',grade:'unknown',evidence:[] };
      if (createHash('sha256').update(await readFile(runner)).digest('hex') !== runnerSha256) throw new Error('Runner changed during evaluation. Preserve the trials and use a new reviewed experiment.');
      if (!store.reserveTrial(trial)) continue;
      const started = performance.now();
      try {
        const value = runnerResult(await execute(runner,{ schema:1,experimentId,environment:experiment.environment,case:store.require<CaseInput>('case',caseId),configuration:store.require<Configuration>('configuration',configurationId),arm,replicate },timeoutMs));
        Object.assign(trial,value,{ state:'finished',elapsedMs:performance.now()-started });
      } catch (error) {
        // Failed and timed-out invocations consume their reserved trial. A retry
        // needs a new replicate; a crashed parent leaves an uncertain reservation.
        Object.assign(trial,{ state:'finished',grade:'unknown',elapsedMs:performance.now()-started,failure:error instanceof Error ? error.message : 'Runner failed.' });
      }
      store.finishTrial(trial); results.push(trial);
      if (trial.failure) return { executed:results.length,stopped:true,trial,comparison:compare(store,experimentId) };
    }
  }
  return { executed:results.length,stopped:false,comparison:compare(store,experimentId) };
}

export function compare(store: ImprovementStore, experimentId: string) {
  const experiment = store.require<ExperimentInput>('experiment',experimentId);
  const baseline = store.require<Configuration>('configuration',experiment.baseline);
  const candidate = store.require<Configuration>('configuration',experiment.candidate);
  const confounds: string[] = [];
  for (const field of ['provider','model','harness','settings','environment'] as const) if (canonical(baseline[field]) !== canonical(candidate[field])) confounds.push(`${field} differs; the change cannot be attributed to instructions or skills alone`);
  if (experiment.baseline === experiment.candidate) confounds.push('The baseline and candidate configurations are identical');
  const trials = store.all<Trial>('trial').filter(t=>t.experimentId===experimentId);
  const groups = new Map<string,Partial<Record<'baseline'|'candidate',Trial>>>();
  for (const trial of trials) {
    const key = `${trial.caseId}:${trial.replicate}`;
    const pair = groups.get(key) ?? {}; pair[trial.arm]=trial; groups.set(key,pair);
  }
  const pairs = [...groups.values()].filter((p): p is Record<'baseline'|'candidate',Trial> => Boolean(p.baseline && p.candidate));
  const valid = pairs.filter(p=>p.baseline.state==='finished' && p.candidate.state==='finished' && p.baseline.grade!=='unknown' && p.candidate.grade!=='unknown');
  const regressions = valid.filter(p=>p.baseline.grade==='pass' && p.candidate.grade!=='pass').map(p=>({ caseId:p.baseline.caseId,replicate:p.baseline.replicate }));
  const improvements = valid.filter(p=>p.baseline.grade!=='pass' && p.candidate.grade==='pass').length;
  const repeats = experiment.caseIds.map(id=>valid.filter(p=>p.baseline.caseId===id).length);
  const incomplete = pairs.length !== groups.size || valid.length !== pairs.length || repeats.some(n=>n<3);
  const armStats = (arm:'baseline'|'candidate') => {
    const armTrials = valid.map(p=>p[arm]);
    const metric = (key:'elapsedMs'|'costUsd'|'humanMinutes') => {
      const values = armTrials.flatMap(t=>t[key]===undefined ? [] : [t[key]!]).sort((a,b)=>a-b);
      const mid=Math.floor(values.length/2);
      return { known:values.length,missing:armTrials.length-values.length,median:values.length ? (values.length%2 ? values[mid] : (values[mid-1]+values[mid])/2) : null };
    };
    return { trials:armTrials.length,passes:armTrials.filter(t=>t.grade==='pass').length,elapsedMs:metric('elapsedMs'),costUsd:metric('costUsd'),humanMinutes:metric('humanMinutes') };
  };
  const before=armStats('baseline'); const after=armStats('candidate');
  const metricKey = { latency:'elapsedMs',cost:'costUsd','human-effort':'humanMinutes' }[experiment.metric as 'latency'|'cost'|'human-effort'] as 'elapsedMs'|'costUsd'|'humanMinutes'|undefined;
  const missingMetric = metricKey && (before[metricKey].missing || after[metricKey].missing);
  const median = (values:number[]) => { values.sort((a,b)=>a-b); const mid=Math.floor(values.length/2); return values.length ? (values.length%2 ? values[mid] : (values[mid-1]+values[mid])/2) : null; };
  const caseMetrics = metricKey ? experiment.caseIds.map(caseId=>{
    const samples=valid.filter(p=>p.baseline.caseId===caseId);
    const value=(arm:'baseline'|'candidate')=>median(samples.flatMap(p=>p[arm][metricKey]===undefined?[]:[p[arm][metricKey]!]));
    const baseline=value('baseline'), candidate=value('candidate');
    return {caseId,pairedTrials:samples.length,baseline,candidate,delta:baseline===null||candidate===null?null:candidate-baseline};
  }) : [];
  const metricRegressions=caseMetrics.filter(c=>c.delta!==null&&c.delta>0);
  let result = 'no-observed-improvement';
  if (confounds.length) result='confounded';
  else if (regressions.length || metricRegressions.length) result='regression-observed';
  else if (incomplete || missingMetric || (metricKey && valid.some(p=>p.baseline.grade!=='pass' || p.candidate.grade!=='pass'))) result='insufficient-evidence';
  else if (experiment.metric==='pass-rate' ? improvements>0 : before[metricKey!].median!==null && after[metricKey!].median! < before[metricKey!].median!) result='improvement-observed';
  return { experimentId,metric:experiment.metric,result,confounds,executionRuntime:store.get<any>('evaluation',experimentId)?.runtime??null,caseMetrics,metricRegressions,pairedTrials:valid.length,incompleteOrUnknown:groups.size-valid.length,minimumRepeatedPairs:Math.min(...repeats),regressions,improvements,baseline:before,candidate:after,limitation:'Observed sample results are not a statistical significance claim. Runner evidence and environment identity require independent inspection; no instruction changes are applied automatically.' };
}

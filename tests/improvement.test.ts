import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { beforeEach } from 'node:test';
import { compare, evaluate, executeRunner, type Executor, type RunnerRequest } from '../cli/improvement/evaluation.ts';
import { snapshot } from '../cli/improvement/snapshot.ts';
import { ImprovementStore } from '../cli/improvement/store.ts';
import type { CaseInput, Configuration, ExperimentInput, RunInput, Trial } from '../cli/improvement/types.ts';
import { digest } from '../cli/improvement/validation.ts';

// Fail closed if an offline test unexpectedly reaches a transport or command.
// Only explicitly registered fixture Node runners may cross the process boundary.
const fixtureRunners = new Set<string>();
const originalExecFile = childProcess.execFile;
beforeEach(t => {
  assert.ok('mock' in t);
  fixtureRunners.clear();
  const denied = () => { throw new Error('Unmocked external execution is forbidden in improvement tests.'); };
  t.mock.method(globalThis, 'fetch', denied);
  t.mock.method(net.Socket.prototype, 'connect', denied);
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork'] as const) t.mock.method(childProcess, method, denied);
  t.mock.method(childProcess, 'execFile', ((file: string, args: string[], ...rest: any[]) => {
    assert.equal(file, process.execPath, 'Only the current Node runtime is allowed');
    assert.equal(args.length, 1);
    assert.ok(fixtureRunners.has(args[0]), 'Only an explicit fixture runner is allowed');
    return (originalExecFile as any)(file, args, ...rest);
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
});

function config(changes: Partial<Configuration> = {}): Configuration {
  return {
    provider: 'fixture', model: 'fixture-model', harness: 'offline-test', settings: { effort: 'high' },
    instructions: [{ path: '/declared/AGENTS.md', sha256: 'a'.repeat(64) }], skills: [],
    environment: { node: '24.21.0', platform: 'linux', arch: 'x64' }, basis: 'declared', ...changes,
  };
}
function run(id = 'run-1', changes: Partial<RunInput> = {}): RunInput {
  return { id, title: 'Fix a recorded fixture defect', configuration: config(), status: 'completed',
    acceptance: { met: 1, total: 1, evidence: ['Focused regression passed'] }, verification: 'verified',
    observations: [{ reason: 'slow', evidence: 'Agent observed a repeated build', source: 'agent' }], ...changes };
}
function memoryStore(t: test.TestContext, now = () => new Date('2026-10-23T12:00:00Z')) {
  const store = new ImprovementStore(new DatabaseSync(':memory:'), now);
  t.after(() => store.close());
  return store;
}
async function directory(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'equip-improvement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function seed(store: ImprovementStore, changes: Partial<ExperimentInput> = {}, candidateChanges: Partial<Configuration> = {}) {
  const baseline = store.recordRun(run()).configurationId;
  const candidate = store.recordConfiguration(config({ instructions: [{ path: '/declared/AGENTS.md', sha256: 'b'.repeat(64) }], ...candidateChanges }));
  store.recordCase({ id: 'case-1', title: 'Recorded regression', prompt: 'Reproduce the fixture defect', expected: 'The focused check passes', sourceRunId: 'run-1', kind: 'regression' });
  return store.recordExperiment({ id: 'experiment-1', hypothesis: 'A clearer completion rule avoids an unfinished task', change: 'Clarify the acceptance instruction', baseline, candidate, caseIds: ['case-1'], environment: 'offline fixture environment', metric: 'pass-rate', ...changes });
}
async function runnerFile(t: test.TestContext, code = '// Injected executor must be used.\nthrow new Error("Unexpected real execution");\n') {
  const path = join(await directory(t), 'runner.mjs');
  await writeFile(path, code);
  return path;
}
function trials(store: ImprovementStore, e: ExperimentInput, result: (arm: Trial['arm'], replicate: number) => Partial<Trial> = () => ({}), repeats = 3) {
  const runnerSha256 = 'c'.repeat(64);
  store.bindEvaluation(e.id, runnerSha256);
  for (const caseId of e.caseIds) for (let replicate = 1; replicate <= repeats; replicate++) for (const arm of ['baseline', 'candidate'] as const) {
    const trial: Trial = { id: digest([e.id, caseId, arm, replicate]), experimentId: e.id, caseId, arm, replicate, configurationId: e[arm], runnerSha256, state: 'running', grade: 'unknown', evidence: [] };
    store.reserveTrial(trial);
    store.finishTrial({ ...trial, state: 'finished', grade: 'pass', evidence: ['Fixture assertion passed'], elapsedMs: arm === 'baseline' ? 100 : 50, ...result(arm, replicate) });
  }
}

test('satisfaction requires explicit user feedback; agent observations and silence remain separate', t => {
  const store = memoryStore(t);
  store.recordRun(run());
  store.recordRun(run('silent'));
  store.recordFeedback({ id: 'agent-note', runId: 'run-1', source: 'agent', reasons: ['slow'], note: 'The agent believes the user was satisfied' });
  assert.deepEqual(store.summary().satisfaction, { rated: 0, unknown: 2, verdicts: {} });
  assert.throws(() => store.recordFeedback({ id: 'agent-rating', runId: 'run-1', source: 'agent', verdict: 'delegate-again', reasons: [], note: 'Inferred approval' }), /Only explicit user feedback/);
  store.recordFeedback({ id: 'user-note', runId: 'run-1', source: 'user', reasons: ['unfinished'], note: 'Please finish the last step' });
  assert.equal(store.summary().satisfaction.unknown, 2);
  store.recordFeedback({ id: 'user-rating', runId: 'run-1', source: 'user', verdict: 'needed-steering', reasons: ['unfinished', 'unfinished'], note: 'I had to ask for completion' });
  const summary = store.summary();
  assert.deepEqual(summary.satisfaction, { rated: 1, unknown: 1, verdicts: { 'needed-steering': 1 } });
  assert.deepEqual(summary.agentReasons, { slow: 2 });
  assert.deepEqual(summary.userReasons, { unfinished: 1 });
});

test('missing measurement evidence stays unknown while measured zero stays known', t => {
  const store = memoryStore(t);
  store.recordRun(run('missing'));
  assert.deepEqual(store.summary().measurements.costUsd, { known: 0, missing: 1, total: null });
  store.recordRun(run('zero', { costUsd: 0, humanMinutes: 0, elapsedMs: 0 }));
  for (const metric of Object.values(store.summary().measurements)) assert.deepEqual(metric, { known: 1, missing: 1, total: 0 });
});

test('same-id evidence writes are idempotent and conflicting writes roll back configuration creation', t => {
  const store = memoryStore(t);
  const first = store.recordRun(run());
  assert.deepEqual(store.recordRun(JSON.parse(JSON.stringify(run()))), first);
  assert.equal(store.all('run').length, 1);
  const before = store.export();
  assert.throws(() => store.recordRun(run('run-1', { title: 'Rewritten history', configuration: config({ model: 'different' }) })), /different evidence/);
  assert.deepEqual(store.export(), before);
  const feedback = { id: 'feedback-1', runId: 'run-1', source: 'user', verdict: 'would-redo', reasons: ['incorrect'], note: 'The result is wrong' };
  store.recordFeedback(feedback); store.recordFeedback(feedback);
  assert.throws(() => store.recordFeedback({ ...feedback, verdict: 'delegate-again' }), /different evidence/);
  assert.equal(store.all('feedback').length, 1);
});

test('configuration identity ignores object key order but preserves every declared setting', t => {
  const store = memoryStore(t);
  const a = config({ settings: { effort: 'high', temperature: 0, fast: false } });
  const b = { ...a, settings: { fast: false, temperature: 0, effort: 'high' } };
  assert.equal(store.recordConfiguration(a), store.recordConfiguration(b));
  assert.notEqual(store.recordConfiguration(a), store.recordConfiguration({ ...a, settings: { ...a.settings, fast: true } }));
  assert.notEqual(store.recordConfiguration(a), store.recordConfiguration({ ...a, environment: { ...a.environment, node: '22.20.0' } }));
  assert.throws(() => store.recordConfiguration(config({ settings: { api_key: 'fixture-only' } })), /Credentials/);
});

test('snapshot hashes exact declared instruction bytes and skill contents without inferring undeclared sources', async t => {
  const root = await directory(t), instruction = join(root, 'AGENTS.md'), skill = join(root, 'fixture-skill');
  await mkdir(skill);
  const bytes = Buffer.from('Keep CRLF bytes\r\nKeep trailing spaces  \r\n');
  await writeFile(instruction, bytes);
  await writeFile(join(skill, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Offline fixture\n---\nRead the reference.\n');
  await writeFile(join(skill, 'reference.txt'), 'Original evidence\n');
  await writeFile(join(root, 'undeclared.md'), 'Do not capture me');
  const input = { provider: 'fixture', model: 'fixture-model', harness: 'offline-test', settings: {}, instructions: [instruction], skills: [skill] };
  const first = await snapshot(input);
  assert.equal(first.basis, 'declared');
  assert.deepEqual(first.instructions, [{ path: await realpath(instruction), sha256: createHash('sha256').update(bytes).digest('hex') }]);
  assert.equal(first.skills[0].name, 'fixture-skill');
  assert.equal(first.skills[0].path, await realpath(skill));
  await writeFile(join(skill, 'reference.txt'), 'Changed evidence\n');
  assert.notEqual((await snapshot(input)).skills[0].revision, first.skills[0].revision);
  await writeFile(instruction, bytes.toString().replaceAll('\r\n', '\n'));
  assert.notEqual((await snapshot(input)).instructions[0].sha256, first.instructions[0].sha256);
  assert.deepEqual((await snapshot({ ...input, instructions: [], skills: [] })).instructions, []);
});

test('cases require recorded source runs and experiments retain immutable configuration and case references', t => {
  const store = memoryStore(t);
  const caseInput = { id: 'orphan', title: 'Missing run', prompt: 'Reproduce', expected: 'Pass', sourceRunId: 'missing', kind: 'regression' };
  assert.throws(() => store.recordCase(caseInput), /run missing was not found/);
  const e = seed(store);
  const original = store.require('experiment', e.id);
  assert.throws(() => store.recordCase({ ...store.require<CaseInput>('case', 'case-1'), prompt: 'Edited replay prompt' }), /different evidence/);
  store.recordCase({ ...store.require<CaseInput>('case', 'case-1'), id: 'case-2' });
  assert.deepEqual(store.require('experiment', e.id), original);
  assert.throws(() => store.recordExperiment({ ...e, caseIds: ['case-1', 'case-2'] }), /different evidence/);
  assert.throws(() => store.recordExperiment({ ...e, id: 'missing-config', candidate: 'missing' }), /configuration missing was not found/);
  assert.throws(() => store.recordExperiment({ ...e, id: 'missing-case', caseIds: ['missing'] }), /case missing was not found/);
  assert.throws(() => store.recordExperiment({ ...e, id: 'duplicate-case', caseIds: ['case-1', 'case-1'] }), /unique/);
});

test('evaluation makes three paired repetitions with pinned configurations and skips completed slots', async t => {
  const store = memoryStore(t), e = seed(store), path = await runnerFile(t);
  const requests: RunnerRequest[] = [];
  const execute: Executor = async (runner, request, timeout) => {
    assert.equal(runner, path); assert.equal(timeout, 3210);
    const id = digest([e.id, request.case.id, request.arm, request.replicate]);
    assert.equal(store.require<Trial>('trial', id).state, 'running', 'Reservation precedes executor invocation');
    assert.deepEqual(request.configuration, store.require('configuration', e[request.arm]));
    assert.equal(request.case.sourceRunId, 'run-1');
    assert.equal(request.environment, e.environment);
    requests.push(request);
    return { grade: request.arm === 'baseline' ? 'fail' : 'pass', evidence: ['Fixture check result'] };
  };
  const result = await evaluate(store, e.id, path, { execute, timeoutMs: 3210 });
  assert.equal(result.executed, 6); assert.equal(result.stopped, false);
  assert.deepEqual(requests.map(r => `${r.replicate}:${r.arm}`), ['1:baseline', '1:candidate', '2:candidate', '2:baseline', '3:baseline', '3:candidate']);
  assert.equal(result.comparison.result, 'improvement-observed');
  assert.equal(result.comparison.minimumRepeatedPairs, 3);
  assert.equal((await evaluate(store, e.id, path, { execute })).executed, 0);
  assert.equal(requests.length, 6);
  const previous = store.all<Trial>('trial')[0];
  assert.throws(() => store.finishTrial({ ...previous, grade: 'fail' }), /cannot be replaced/);
  await writeFile(path, '// Changed runner evidence\n');
  await assert.rejects(evaluate(store, e.id, path, { execute }), /different evidence/);
  assert.equal(requests.length, 6);
});

test('a reservation survives reopen before execution and uncertain work cannot be replayed', async t => {
  const root = await directory(t), path = await runnerFile(t), store = await ImprovementStore.open(root);
  let experimentId = '', id = '';
  try {
    const e = seed(store); experimentId = e.id;
    await evaluate(store, e.id, path, { repetitions: 1, execute: async (_runner, request) => {
      id = digest([e.id, request.case.id, request.arm, request.replicate]);
      const observer = await ImprovementStore.open(root);
      try { assert.equal(observer.require<Trial>('trial', id).state, 'running'); }
      finally { observer.close(); }
      return { grade: 'unknown', evidence: ['Execution interrupted fixture'] };
    } });
  } finally { store.close(); }
  const reopened = await ImprovementStore.open(root);
  try {
    assert.equal(reopened.require<Trial>('trial', id).state, 'finished');
    const experiment = reopened.require<ExperimentInput>('experiment', experimentId);
    const trial: Trial = { id: digest([experimentId, 'case-1', 'candidate', 2]), experimentId, caseId: 'case-1', arm: 'candidate', replicate: 2, configurationId: experiment.candidate, runnerSha256: createHash('sha256').update(await readFile(path)).digest('hex'), state: 'running', grade: 'unknown', evidence: [] };
    reopened.reserveTrial(trial);
    let invoked = false;
    await assert.rejects(evaluate(reopened, experimentId, path, { execute: async () => { invoked = true; return { grade: 'pass', evidence: ['Unexpected'] }; } }), /uncertain execution/);
    assert.equal(invoked, false);
  } finally { reopened.close(); }
});

for (const failure of ['Runner failed', 'Runner timed out; execution was not retried.']) test(`evaluation stops after ${failure} and retains the consumed slot`, async t => {
  const store = memoryStore(t), e = seed(store), path = await runnerFile(t);
  let calls = 0;
  const result = await evaluate(store, e.id, path, { execute: async () => { calls++; throw new Error(failure); } });
  assert.equal(calls, 1); assert.equal(result.executed, 1); assert.equal(result.stopped, true);
  assert.equal(result.trial?.state, 'finished'); assert.equal(result.trial?.grade, 'unknown');
  assert.equal(result.trial?.failure, failure); assert.equal(result.comparison.result, 'insufficient-evidence');
  const consumed = result.trial!.id;
  await evaluate(store, e.id, path, { repetitions: 1, execute: async (_runner, request) => {
    assert.notEqual(digest([e.id, request.case.id, request.arm, request.replicate]), consumed);
    calls++; return { grade: 'pass', evidence: ['Another slot'] };
  } });
  assert.equal(calls, 2);
});

test('comparison refuses conclusions from fewer than three pairs, unknown grades, or one missing arm', t => {
  for (const mode of ['two-pairs', 'unknown', 'missing-arm']) {
    const store = memoryStore(t), e = seed(store);
    if (mode === 'two-pairs') trials(store, e, () => ({}), 2);
    else if (mode === 'unknown') trials(store, e, (arm, replicate) => arm === 'candidate' && replicate === 3 ? { grade: 'unknown', evidence: [] } : {});
    else {
      trials(store, e);
      const pending: Trial = { id: digest([e.id, 'case-1', 'baseline', 4]), experimentId: e.id, caseId: 'case-1', arm: 'baseline', replicate: 4, configurationId: e.baseline, runnerSha256: 'c'.repeat(64), state: 'running', grade: 'unknown', evidence: [] };
      store.reserveTrial(pending);
    }
    assert.equal(compare(store, e.id).result, 'insufficient-evidence', mode);
  }
});

test('any paired quality regression blocks a measured latency improvement', t => {
  const store = memoryStore(t), e = seed(store, { metric: 'latency' });
  trials(store, e, (arm, replicate) => arm === 'candidate' && replicate === 2 ? { grade: 'fail' } : {});
  const result = compare(store, e.id);
  assert.equal(result.result, 'regression-observed');
  assert.deepEqual(result.regressions, [{ caseId: 'case-1', replicate: 2 }]);
  assert.equal(result.candidate.elapsedMs.median, 50);
});

for (const field of ['provider', 'model', 'harness', 'settings', 'environment', 'identical'] as const) test(`comparison identifies ${field} configuration confounding`, t => {
  const store = memoryStore(t);
  const changed = field === 'settings' ? { settings: { effort: 'low' } } : field === 'environment' ? { environment: { ...config().environment, node: '22.20.0' } } : field === 'identical' ? { instructions: config().instructions } : { [field]: 'different' };
  const e = seed(store, {}, changed);
  trials(store, e, arm => ({ grade: arm === 'baseline' ? 'fail' : 'pass' }));
  const result = compare(store, e.id);
  assert.equal(result.result, 'confounded'); assert.equal(result.confounds.length, 1);
});

for (const [metric, key] of [['latency', 'elapsedMs'], ['cost', 'costUsd'], ['human-effort', 'humanMinutes']] as const) test(`${metric} needs complete metric evidence before claiming improvement`, t => {
  const missing = memoryStore(t), e = seed(missing, { metric });
  trials(missing, e, (arm, replicate) => ({ [key]: arm === 'baseline' && replicate === 1 ? undefined : arm === 'baseline' ? 10 : 0 }));
  assert.equal(compare(missing, e.id).result, 'insufficient-evidence');
  assert.equal(compare(missing, e.id).baseline[key].missing, 1);
  const measured = memoryStore(t), complete = seed(measured, { metric });
  trials(measured, complete, arm => ({ [key]: arm === 'baseline' ? 10 : 0 }));
  assert.equal(compare(measured, complete.id).result, 'improvement-observed');
  assert.equal(compare(measured, complete.id).candidate[key].median, 0);
});

test('local export/import preserves source evidence, timestamps, configuration hashes, and completed trials', t => {
  const source = memoryStore(t), e = seed(source);
  source.recordFeedback({ id: 'feedback-1', runId: 'run-1', source: 'user', verdict: 'needed-steering', reasons: ['unfinished'], note: 'Finish before handing back' });
  trials(source, e);
  const exported = source.export();
  const destination = memoryStore(t, () => new Date('2026-10-24T12:00:00Z'));
  assert.equal(destination.import(JSON.parse(JSON.stringify(exported))).imported, exported.entries.length);
  assert.deepEqual(destination.export(), exported);
  destination.import(exported);
  assert.deepEqual(destination.export(), exported);
  assert.deepEqual(compare(destination, e.id), compare(source, e.id));
  assert.equal(compare(source, e.id).result, 'no-observed-improvement');
});

test('export/import preserves the latest user verdict when feedback timestamps tie', t => {
  const source = memoryStore(t);
  source.recordRun(run());
  source.recordFeedback({ id: 'z-first', runId: 'run-1', source: 'user', verdict: 'would-redo', reasons: ['incorrect'], note: 'Initial result failed' });
  source.recordFeedback({ id: 'a-latest', runId: 'run-1', source: 'user', verdict: 'delegate-again', reasons: [], note: 'The corrected result is acceptable' });
  assert.deepEqual(source.summary().satisfaction.verdicts, { 'delegate-again': 1 });
  const destination = memoryStore(t);
  destination.import(source.export());
  assert.deepEqual(destination.summary().satisfaction, source.summary().satisfaction);
});

test('a conflicting or invalid import is atomic and leaves the existing ledger unchanged', t => {
  const source = memoryStore(t); seed(source);
  const destination = memoryStore(t); destination.recordRun(run('run-1', { title: 'Existing independent evidence' }));
  const before = destination.export();
  assert.throws(() => destination.import(source.export()), /different evidence/);
  assert.deepEqual(destination.export(), before);
  const invalid = structuredClone(source.export());
  invalid.entries.find(entry => entry.kind === 'case')!.data.sourceRunId = 'missing-run';
  const empty = memoryStore(t);
  assert.throws(() => empty.import(invalid), /run missing-run was not found/);
  assert.deepEqual(empty.export().entries, []);
});

test('real subprocess protocol passes hostile case text as JSON to only the supplied Node runner', async t => {
  const root = await directory(t), sentinel = join(root, 'injected'), path = join(root, 'runner ; literal.mjs');
  const hostile = `$(touch ${sentinel}); \"; touch ${sentinel}; #\n`;
  await writeFile(path, `let body = ''; for await (const chunk of process.stdin) body += chunk; const request = JSON.parse(body); process.stdout.write(JSON.stringify({ grade: 'pass', evidence: [request.case.prompt, request.configuration.model, request.arm, String(request.replicate)] }));\n`);
  fixtureRunners.add(path);
  const request: RunnerRequest = { schema: 1, experimentId: 'experiment-1', environment: 'offline', case: { id: 'case-1', title: 'Hostile text', prompt: hostile, expected: 'Literal data', sourceRunId: 'run-1', kind: 'regression' }, configuration: config(), arm: 'candidate', replicate: 3 };
  assert.deepEqual(await executeRunner(path, request, 5000), { grade: 'pass', evidence: [hostile, 'fixture-model', 'candidate', '3'] });
  await assert.rejects(stat(sentinel), { code: 'ENOENT' });
});

for (const [name, code, expected] of [
  ['malformed JSON', 'process.stdout.write("not json");', /one valid RunnerResult/],
  ['unsupported grade', 'console.log(JSON.stringify({grade:"excellent",evidence:["claim"]}));', /one valid RunnerResult/],
  ['pass without evidence', 'console.log(JSON.stringify({grade:"pass",evidence:[]}));', /one valid RunnerResult/],
  ['nonzero exit', 'process.exit(2);', /Runner failed/],
  ['timeout', 'setInterval(() => {}, 1000);', /timed out/],
] as const) test(`real Node runner rejects ${name} without a retry`, async t => {
  const path = await runnerFile(t, code); fixtureRunners.add(path);
  const request: RunnerRequest = { schema: 1, experimentId: 'experiment-1', environment: 'offline', case: { id: 'case-1', title: 'Fixture', prompt: 'Fixture', expected: 'Pass', sourceRunId: 'run-1', kind: 'regression' }, configuration: config(), arm: 'baseline', replicate: 1 };
  await assert.rejects(executeRunner(path, request, name === 'timeout' ? 150 : 5000), expected);
  assert.equal((childProcess.execFile as any).mock.calls.length, 1);
});

test('overlapping imports reject ambiguous tied verdict order atomically', t => {
  const source=memoryStore(t), destination=memoryStore(t);
  source.recordRun(run()); destination.recordRun(run());
  const first={id:'z-first',runId:'run-1',source:'user',verdict:'would-redo',reasons:[],note:'Earlier verdict'};
  const latest={...first,id:'a-latest',verdict:'delegate-again',note:'Later verdict'};
  source.recordFeedback(first); source.recordFeedback(latest);
  destination.recordFeedback(latest);
  const before=destination.export();
  assert.throws(()=>destination.import(source.export()),/Ambiguous feedback ordering/);
  assert.deepEqual(destination.export(),before);
  assert.deepEqual(destination.summary().satisfaction.verdicts,{'delegate-again':1});
});

test('an evaluation cannot resume under a different actual Node runtime or platform', async t => {
  const source=memoryStore(t), e=seed(source), runner=await runnerFile(t);
  const hash=createHash('sha256').update(await readFile(runner)).digest('hex');
  source.bindEvaluation(e.id,hash,{node:'different-runtime',platform:'different-platform',arch:process.arch});
  const transferred=memoryStore(t); transferred.import(source.export());
  let calls=0;
  await assert.rejects(evaluate(transferred,e.id,runner,{execute:async()=>{calls++;return {grade:'pass',evidence:['Unexpected']};}}),/different evidence/);
  assert.equal(calls,0);
  assert.equal(compare(transferred,e.id).executionRuntime.node,'different-runtime');
});

for(const [metric,key] of [['latency','elapsedMs'],['cost','costUsd'],['human-effort','humanMinutes']] as const) test(`${metric} reports per-case regressions hidden by pooled medians`,t=>{
  const store=memoryStore(t);
  store.recordRun(run());
  for(const id of ['a','b','c'])store.recordCase({id,title:id,prompt:id,expected:'Pass',sourceRunId:'run-1',kind:'regression'});
  const e=seed(store,{metric,caseIds:['a','b','c']});
  trials(store,e);
  // Seed a fresh experiment so each immutable trial contains the intended costs.
  const exported=store.export();
  for(const entry of exported.entries)if(entry.kind==='trial') {
    const trial=entry.data as Trial;
    trial[key]=trial.arm==='baseline'?100:trial.caseId==='a'?200:10;
  }
  const measured=memoryStore(t);measured.import(exported);
  const result=compare(measured,e.id);
  assert.ok(result.candidate[key].median!<result.baseline[key].median!);
  assert.equal(result.result,'regression-observed');
  assert.deepEqual(result.metricRegressions,[{caseId:'a',pairedTrials:3,baseline:100,candidate:200,delta:100}]);
});

test('a Node runner ignoring SIGTERM is forcibly stopped at its timeout', {timeout:5000}, async t=>{
  const path=await runnerFile(t,"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
  fixtureRunners.add(path);
  const request:RunnerRequest={schema:1,experimentId:'fixture',environment:'offline',case:{id:'fixture',title:'Fixture',prompt:'Fixture',expected:'Timeout',sourceRunId:'run-1',kind:'regression'},configuration:config(),arm:'baseline',replicate:1};
  const start=Date.now();
  await assert.rejects(executeRunner(path,request,300),/timed out/);
  assert.ok(Date.now()-start<3000,'Timeout must bound an uncooperative runner');
});

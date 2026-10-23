import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../cli/index.ts', import.meta.url));

// Loaded before the app and inherited by its explicit fixture Node runner.
// Unexpected network and external commands fail before they can run.
const offlineGuard = `
const cp = require('node:child_process');
const net = require('node:net');
const deny = () => { require('node:fs').appendFileSync(process.env.EQUIP_TEST_GUARD_LOG, 'denied\\n'); throw new Error('OFFLINE_TEST: unmocked network or external command rejected'); };
globalThis.fetch = deny;
net.Socket.prototype.connect = deny;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) cp[name] = deny;
const execFile = cp.execFile;
cp.execFile = function(file, args, ...rest) {
  if (file !== process.execPath || args.length !== 1 || args[0] !== process.env.EQUIP_TEST_RUNNER) return deny();
  return execFile.call(this, file, args, ...rest);
};
require('node:module').syncBuiltinESMExports();
`;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'equip-cli-improvement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'ledger-home'), agentHome = join(root, 'agent-home'), guard = join(root, 'offline.cjs');
  await mkdir(home); await mkdir(agentHome); await writeFile(guard, offlineGuard);
  // Bad local account files prove improve never consults application connection state.
  await writeFile(join(home, 'state.json'), 'THIS IS NOT ACCOUNT JSON');
  await writeFile(join(home, 'ledger.json'), 'THIS IS NOT THE IMPROVEMENT LEDGER');
  const runner = join(root, 'fixture runner.mjs');
  await writeFile(runner, `let body = ''; for await (const chunk of process.stdin) body += chunk; const request = JSON.parse(body); console.log(JSON.stringify({ grade: request.arm === 'baseline' ? 'fail' : 'pass', evidence: ['Offline fixture result: ' + request.case.expected], costUsd: 0 }));\n`);
  async function cli(args: string[], input?: unknown, overrideHome = home) {
    const environment: NodeJS.ProcessEnv = {
      PATH: dirname(process.execPath), HOME: agentHome, USERPROFILE: agentHome,
      TMPDIR: root, TEMP: root, TMP: root, EQUIP_HOME: overrideHome, EQUIP_AGENT_HOME: agentHome,
      EQUIP_NO_SERVICE: '1', EQUIP_TEST_RUNNER: runner, EQUIP_TEST_GUARD_LOG: join(root, 'guard.log'), NODE_OPTIONS: `--require=${guard}`,
      EQUIP_SERVER: 'https://offline.invalid', NO_COLOR: '1',
    };
    return await new Promise<{ code: number; stdout: string; stderr: string; json?: any }>((resolveResult, reject) => {
      const child = execFile(process.execPath, ['--experimental-transform-types', entry, 'improve', ...args], {
        cwd: root, env: environment, timeout: 10000, maxBuffer: 2 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') { reject(error); return; }
        let json: any; try { json = JSON.parse(stdout); } catch { /* Failed commands may not write JSON. */ }
        resolveResult({ code: error ? Number(error.code) : 0, stdout, stderr, json });
      });
      child.stdin!.end(input === undefined ? '' : JSON.stringify(input));
    });
  }
  async function success(args: string[], input?: unknown, overrideHome?: string) {
    const result = await cli(args, input, overrideHome);
    assert.equal(result.code, 0, `${args.join(' ')} failed: ${result.stderr}`);
    assert.ok(result.json, `Expected JSON output: ${result.stdout}`);
    return result.json;
  }
  return { root, home, agentHome, runner, cli, success };
}

function recordedRun(configuration: unknown) {
  return { id: 'cli-run', title: 'Recorded CLI regression', configuration, status: 'completed',
    acceptance: { met: 1, total: 1, evidence: ['Offline test passed'] }, verification: 'verified', observations: [] };
}

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const instruction = join(f.root, 'AGENTS.md');
  await writeFile(instruction, 'Finish all acceptance checks.\r\n');
  const args = ['snapshot', '--provider', 'fixture', '--model', 'fixture-model', '--harness', 'offline-test', '--instructions', instruction];
  const baseline = await f.success(args);
  await f.success(['record', '--file', '-'], recordedRun(baseline.configuration));
  await writeFile(instruction, 'Finish all acceptance checks and verify the outcome.\r\n');
  const candidate = await f.success(args);
  await f.success(['case', '--file', '-'], { id: 'cli-case', title: 'CLI replay', prompt: 'A local fixture prompt', expected: 'A local assertion passes', sourceRunId: 'cli-run', kind: 'regression' });
  await f.success(['experiment', '--file', '-'], { id: 'cli-experiment', hypothesis: 'Clearer instructions improve completion', change: 'Clarify completion', baseline: baseline.configurationId, candidate: candidate.configurationId, caseIds: ['cli-case'], environment: 'offline Node fixture', metric: 'pass-rate' });
  return { baseline, candidate };
}

test('CLI runs the local record, feedback, repeated evaluation, compare, and portable ledger loop', async t => {
  const f = await fixture(t), { baseline, candidate } = await seed(f);
  assert.notEqual(baseline.configurationId, candidate.configurationId);
  const unrated = await f.success(['summary']);
  assert.deepEqual(unrated.satisfaction, { rated: 0, unknown: 1, verdicts: {} });
  await f.success(['feedback', '--file', '-'], { id: 'cli-feedback', runId: 'cli-run', source: 'user', verdict: 'needed-steering', reasons: ['unfinished'], note: 'Had to ask for completion' });
  const evaluated = await f.success(['evaluate', 'cli-experiment', '--runner', f.runner, '--timeout-ms', '5000']);
  assert.equal(evaluated.executed, 6); assert.equal(evaluated.stopped, false);
  assert.equal(evaluated.comparison.result, 'improvement-observed');
  assert.equal((await f.success(['evaluate', 'cli-experiment', '--runner', f.runner])).executed, 0);
  const comparison = await f.success(['compare', 'cli-experiment']);
  assert.equal(comparison.minimumRepeatedPairs, 3); assert.equal(comparison.pairedTrials, 3);
  const summary = await f.success(['summary', '--days', '7']);
  assert.deepEqual(summary.satisfaction, { rated: 1, unknown: 0, verdicts: { 'needed-steering': 1 } });
  assert.deepEqual(summary.measurements.costUsd, { known: 0, missing: 1, total: null });
  assert.equal((await f.success(['show', 'configuration', baseline.configurationId])).basis, 'declared');
  const exported = await f.success(['export']);
  const importedHome = join(f.root, 'imported-home');
  await f.success(['import', '--file', '-'], exported, importedHome);
  assert.deepEqual(await f.success(['export'], undefined, importedHome), exported);
  assert.deepEqual(await f.success(['compare', 'cli-experiment'], undefined, importedHome), comparison);
  await assert.rejects(stat(join(f.root, 'guard.log')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.home, 'state.json'), 'utf8'), 'THIS IS NOT ACCOUNT JSON');
  assert.equal(await readFile(join(f.home, 'ledger.json'), 'utf8'), 'THIS IS NOT THE IMPROVEMENT LEDGER');
  if (process.platform !== 'win32') assert.equal((await stat(join(f.home, 'improvement', 'ledger.sqlite'))).mode & 0o777, 0o600);
});

test('CLI rejects ambiguous arguments, unknown fields, agent satisfaction, and invalid input', async t => {
  const f = await fixture(t);
  const help = await f.success(['help']);
  assert.equal(help.feature, 'improvement-loop');
  for (const [args, input, expected] of [
    [['summary', '--dyas', '7'], undefined, /Unknown option --dyas/],
    [['summary', '--days', '7', '--days', '8'], undefined, /may be supplied once/],
    [['summary', 'unexpected'], undefined, /expects 0 positional/],
    [['compare'], undefined, /expects 1 positional/],
    [['summary', '--days'], undefined, /needs a value/],
    [['record'], undefined, /--file is required/],
    [['record', '--file', '-'], { id: 'bad', invented: 'field' }, /Unknown field: invented/],
    [['feedback', '--file', '-'], { id: 'inferred', runId: 'no-run', source: 'agent', verdict: 'delegate-again', reasons: [], note: 'Inferred approval' }, /Only explicit user feedback/],
    [['summary', '--days', '0'], undefined, /days must be an integer/],
  ] as const) {
    const result = await f.cli([...args], input);
    assert.notEqual(result.code, 0, args.join(' ')); assert.match(result.stderr, expected);
  }
  const badFile = join(f.root, 'invalid.json'); await writeFile(badFile, '{broken');
  const malformed = await f.cli(['import', '--file', badFile]);
  assert.notEqual(malformed.code, 0); assert.match(malformed.stderr, /must be valid JSON/);
  const tooLarge = await f.cli(['import', '--file', '-'], { content: 'x'.repeat(2 * 1024 * 1024) });
  assert.notEqual(tooLarge.code, 0); assert.match(tooLarge.stderr, /exceeds 2 MiB/);
  assert.deepEqual((await f.success(['export'])).entries, []);
});

test('CLI subprocess guard rejects network and unapproved external commands before execution', async t => {
  const f = await fixture(t);
  await seed(f);
  const sentinel = join(f.root, 'must-not-exist');
  for (const code of [
    'await fetch("https://offline.invalid");',
    `import cp from 'node:child_process'; cp.execFileSync(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad')`)}]);`,
  ]) {
    await writeFile(f.runner, code);
    // Each runner identity needs a distinct immutable experiment.
    const original = await f.success(['show', 'experiment', 'cli-experiment']);
    const id = code.startsWith('await') ? 'blocked-network' : 'blocked-command';
    await f.success(['experiment', '--file', '-'], { ...original, id });
    const result = await f.success(['evaluate', id, '--runner', f.runner]);
    assert.equal(result.executed, 1); assert.equal(result.stopped, true);
    assert.equal(result.trial.grade, 'unknown'); assert.match(result.trial.failure, /Runner failed/);
  }
  assert.equal((await readFile(join(f.root, 'guard.log'), 'utf8')).trim().split('\n').length, 2);
  await assert.rejects(stat(sentinel), { code: 'ENOENT' });
});

test('chunked CLI backup restores more than 10000 records and 2 MiB with tied feedback order', {timeout:30000}, async t=>{
  const f=await fixture(t);
  const {baseline}=await seed(f);
  const {ImprovementStore}=await import('../cli/improvement/store.ts');
  const store=await ImprovementStore.open(f.home);
  try {
    store.transaction(()=>{
      for(let i=0;i<10020;i++)store.recordFeedback({id:`feedback-${i}`,runId:'cli-run',source:'user',verdict:i===10019?'delegate-again':'would-redo',reasons:[],note:i<142?'x'.repeat(16000):'Observed feedback'});
    });
  }finally{store.close();}
  const backup=join(f.root,'portable-backup');
  const receipt=await f.success(['export','--directory',backup]);
  assert.ok(receipt.entries>10000);assert.ok(receipt.chunks>1);
  let bytes=0;
  const manifest=JSON.parse(await readFile(join(backup,'manifest.json'),'utf8'));
  for(const chunk of manifest.chunks)bytes+=(await stat(join(backup,chunk.file))).size;
  assert.ok(bytes>2*1024*1024);
  const restored=join(f.root,'restored');
  assert.equal((await f.success(['import','--directory',backup],undefined,restored)).imported,receipt.entries);
  assert.deepEqual((await f.success(['summary'],undefined,restored)).satisfaction,(await f.success(['summary'])).satisfaction);
  assert.equal((await f.success(['import','--directory',backup],undefined,restored)).imported,receipt.entries);
  const chunkPath=join(backup,manifest.chunks.at(-1).file);
  await writeFile(chunkPath,'tampered');
  const rejected=await f.cli(['import','--directory',backup],undefined,join(f.root,'rejected'));
  assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/hash mismatch/);
  assert.deepEqual((await f.success(['export'],undefined,join(f.root,'rejected'))).entries,[]);
});

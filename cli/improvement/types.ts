/** Local-only evidence. User feedback and agent observations remain distinct. */
export type Verdict = 'delegate-again' | 'needed-steering' | 'would-redo';
export type Grade = 'pass' | 'fail' | 'unknown';
export type Reason = 'unnecessary-questions' | 'unfinished' | 'incorrect' | 'overengineered' | 'poor-design' | 'slow' | 'cost' | 'scope' | 'authorization' | 'other';
export interface Configuration {
  provider: string;
  model: string;
  harness: string;
  settings: Record<string, string | number | boolean>;
  instructions: Array<{ path: string; sha256: string }>;
  skills: Array<{ name: string; path: string; revision: string }>;
  environment: { node: string; platform: string; arch: string };
  basis: 'declared';
}
export interface RunInput {
  id: string;
  title: string;
  configuration: Configuration;
  status: 'completed' | 'blocked' | 'failed';
  acceptance: { met: number; total: number; evidence: string[] };
  verification: 'verified' | 'partial' | 'unverified';
  observations: Array<{ reason: Reason; evidence: string; source: 'agent' | 'check' }>;
  session?: string;
  repository?: string;
  pr?: string;
  elapsedMs?: number;
  humanMinutes?: number;
  costUsd?: number;
}
export interface FeedbackInput {
  id: string;
  runId: string;
  source: 'user' | 'agent';
  verdict?: Verdict;
  reasons: Reason[];
  note: string;
}
export interface CaseInput {
  id: string;
  title: string;
  prompt: string;
  expected: string;
  sourceRunId: string;
  kind: 'regression' | 'capability';
}
export interface ExperimentInput {
  id: string;
  hypothesis: string;
  change: string;
  baseline: string;
  candidate: string;
  caseIds: string[];
  environment: string;
  metric: 'pass-rate' | 'latency' | 'cost' | 'human-effort';
}
export interface RunnerResult {
  grade: Grade;
  evidence: string[];
  costUsd?: number;
  humanMinutes?: number;
}
export interface Trial {
  id: string;
  experimentId: string;
  caseId: string;
  arm: 'baseline' | 'candidate';
  replicate: number;
  configurationId: string;
  runnerSha256: string;
  state: 'running' | 'finished';
  grade: Grade;
  evidence: string[];
  elapsedMs?: number;
  costUsd?: number;
  humanMinutes?: number;
  failure?: string;
}
export type EntryKind = 'configuration' | 'run' | 'feedback' | 'case' | 'experiment' | 'trial' | 'evaluation';

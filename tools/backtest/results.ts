// Result shapes shared by the runner, metrics and report writer.
import type { Usage } from './client.ts';
import type { Agreement } from './delta.ts';
import type { OracleReport } from './oracles.ts';

export const LABELS = ['equivalent', 'spec-permitted variation', 'spec violation', 'regression', 'better-than-reference', 'spec-gap'] as const;
export type Label = (typeof LABELS)[number];

/** Every model-judged number carries this label in reports (maintainer decision, pilot only). */
export const GRADER_LABEL = 'same-family grader';

export interface CallCost {
  calls: number;
  usage: Usage;
  costUsd: number | null;
  durationMs: number;
}

export interface SpecAttempt extends CallCost {
  ok: boolean;
  /** Validator errors, safe to show to the model on retry (no reference behaviour in them). */
  errors: string[];
  /** Human-only evidence (for example the failing assertion messages against the reference); never sent to a model. */
  details?: string[];
}

export interface CandidateResult {
  k: number;
  stopReason: string;
  cost: CallCost;
  /** Final scratch commit pushed to the scratch origin (always-pushed invariant, scratch only). */
  commit: string | null;
  changedFiles: string[];
  report: OracleReport | null;
  clearsAllRungs: boolean;
  /** Test-level agreement with the reference over acceptance + held-out tests. */
  testAgreement: { total: number; agree: number };
  probeAgreement: Agreement | null;
  label: Label | null;
  labelSource: 'deterministic' | GraderTag | null;
  rationale?: string;
  /** Deterministic ground truth that the candidate regressed (held-out or repo tests fail). */
  deterministicRegression: boolean;
  error?: string;
}
export type GraderTag = 'same-family grader';

export interface LeakageResult {
  wrongIssue: { ran: boolean; similarity: number | null; passed: boolean | null; detail: string } | null;
  overlap: { issueFlags: string[]; specFlags: string[]; passed: boolean };
  history: { passed: boolean; detail: string[] } | null;
  docAtBase: { passed: boolean; detail: string[] };
}

export interface RowResult {
  id: string;
  sha: string;
  tier: 'A' | 'B';
  obs: 'E' | 'W' | 'N';
  status: 'complete' | 'awaiting-issue-approval' | 'leak-blocked' | 'spec-failed' | 'aborted' | 'error';
  note?: string;
  issueCost: CallCost | null;
  spec: {
    attempts: SpecAttempt[];
    passedValidators: boolean;
    retries: number;
    cost: CallCost;
    editDistance: number | null;
    humanMinutes: number | null;
  } | null;
  reference: { report: OracleReport; acceptancePassed: boolean; falseRejected: boolean } | null;
  candidates: CandidateResult[];
  graderCalls: number;
  leakage: LeakageResult | null;
}

export interface RunMeta {
  runId: string;
  /** 'none': file tools only. 'bwrap': candidates also had Bash, run inside bwrap. Results of the two modes are never mixed. */
  bashMode: 'none' | 'bwrap';
  sandbox: string | null;
  client: string;
  startedAt: string;
  finishedAt: string;
  k: number;
  aborted: string | null;
  budget: { expected: number; hardStop: number; used: number; byRole: Record<string, { calls: number; costUsd: number | null; inputTokens: number; outputTokens: number }> };
}

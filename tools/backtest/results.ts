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
  /** Charged toward the dollar cap in place of a missing costUsd (an upper bound, not a measurement). */
  estimatedUsd?: number;
  /** The call was killed (call limit, timeout): tokens and cost are lower bounds. */
  killed?: boolean;
}

/** Who produced a candidate: requested model/effort plus what the CLI reported (arms runs only). */
export interface ArmIdent {
  arm: string;
  /** The model the CLI reported in its init event; the requested one when the event carried none (modelFromInit false). */
  model: string;
  modelFromInit: boolean;
  effort: string;
  cliVersion: string;
  /** The model id requested on the command line (a moving alias may resolve to a different model). */
  cliAlias: string;
  family: string;
}

/** Which grader produced a label, and whether it shares a model family with the candidate it judged. */
export interface GraderTag {
  grader: string;
  family: string;
  sameFamilyAsCandidate: boolean;
}

export interface Grade {
  tag: GraderTag;
  label: Label;
  rationale: string;
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
  /** Deterministic label only (null: the oracles do not decide). Model-judged labels live in grades[]. */
  label: Label | null;
  /** 'same-family grader' only in results stored before grades[] existed (see gradesOf). */
  labelSource: 'deterministic' | typeof GRADER_LABEL | null;
  rationale?: string;
  /** Present in arms runs: who produced this candidate. */
  arm?: ArmIdent;
  /** sha256 of the rendered candidate prompt (identical bytes across arms for one row). */
  promptHash?: string;
  /** One entry per grader, fully crossed over graders in arms runs. */
  grades?: Grade[];
  /** Deterministic ground truth that the candidate regressed (held-out or repo tests fail). */
  deterministicRegression: boolean;
  error?: string;
}

const LEGACY_TAG: GraderTag = { grader: 'claude-cli', family: 'claude', sameFamilyAsCandidate: true };

/** The model-judged labels of a candidate, including pre-grades[] results (one label, labelSource 'same-family grader'). */
export function gradesOf(c: Pick<CandidateResult, 'label' | 'labelSource' | 'grades' | 'rationale'>): Grade[] {
  if (c.grades?.length) return c.grades;
  if (c.labelSource === GRADER_LABEL && c.label) return [{ tag: LEGACY_TAG, label: c.label, rationale: (c.rationale ?? '').replace(`${GRADER_LABEL}: `, '') }];
  return [];
}

/** Report wording for a grader tag. */
export const graderText = (t: GraderTag): string => `${t.grader}${t.sameFamilyAsCandidate ? ` (${GRADER_LABEL})` : ' (cross-family grader)'}`;

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
  /** Arms runs: what is per row in a single-client run, kept per arm (status, grader calls, leakage test 3). */
  perArm?: Record<string, ArmRowState>;
}

export interface ArmRowState {
  /** Candidates whose leakage test 3 failed: the arm/k is dropped, the row and other arms go on. */
  blocked: { k: number; note: string }[];
  graderCalls: number;
  leakageHistory: { passed: boolean; detail: string[] } | null;
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
  /** Arms runs (all optional: absent in single-client runs). */
  arms?: { id: string; model: string; effort: string; cliAlias: string; family: string }[];
  cliVersion?: string;
  /** Seed of the interleaving order (arm order per row and k). */
  seed?: string;
  candidateMaxCalls?: { value: number; default: number; deliberateChange: boolean };
  /** Model the CLI reported per arm; arms whose init event carried none fell back to the requested one. */
  reportedModels?: Record<string, string>;
  modelNotReported?: string[];
  dollar?: { capUsd: number; chargedUsd: number; estimatedUsd: number };
  harness?: { commit: string; dirty: boolean };
  /** Spend of this run id alone (the `budget` block below is the lifetime global ledger). */
  runBudget?: Record<string, { calls: number; costUsd: number | null; inputTokens: number; outputTokens: number }>;
  /** Front half copied from an earlier run (see arms.ts reuseFrontHalf). */
  reuse?: { from: string; manifest: string };
  budget: { expected: number; hardStop: number; used: number; byRole: Record<string, { calls: number; costUsd: number | null; inputTokens: number; outputTokens: number }> };
}

import { describe, expect, it } from 'vitest';
import { computeArmsMetrics, computeMetrics, TIER_A_ROWS } from '../metrics.ts';
import { buildReport } from '../report.ts';
import type { OracleReport } from '../oracles.ts';
import type { CandidateResult, Grade, RowResult, RunMeta } from '../results.ts';

const meta: RunMeta = { runId: 't', bashMode: 'none', sandbox: null, client: 'fake', startedAt: '', finishedAt: '', k: 3, aborted: null, budget: { expected: 565, hardStop: 850, used: 0, byRole: {} } };
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };
const cc = (calls: number) => ({ calls, usage, costUsd: calls / 10, durationMs: 60_000 });

const report = (over: Partial<OracleReport> & { held?: Record<string, 'passed' | 'failed'> } = {}): OracleReport => ({
  failedRepoTests: [], regressions: [], missingTests: [], acceptance: { total: 1, passed: 1, failed: [] },
  heldOut: { total: 1, outcomes: over.held ?? { 'a::t': 'passed' } }, tsc: null, loadErrors: [], probeProblems: [], failureMessages: {}, probe: [],
  rungs: { preMerge: true, conformance: true, shadow: true }, conformanceViolations: [], shadowViolations: [], ...over,
});

const cand = (k: number, over: Partial<CandidateResult> & { rep?: Partial<OracleReport> & { held?: Record<string, 'passed' | 'failed'> } } = {}): CandidateResult => ({
  k, stopReason: 'done', cost: cc(10), commit: 'a'.repeat(40), changedFiles: [], report: report(over.rep), clearsAllRungs: true,
  testAgreement: { total: 1, agree: 1 }, probeAgreement: null, label: 'equivalent', labelSource: 'deterministic', deterministicRegression: false, ...over,
});

const row = (id: string, cands: CandidateResult[], over: Partial<RowResult> = {}): RowResult => ({
  id, sha: 'abc', tier: 'A', obs: 'E', status: 'complete', issueCost: cc(1),
  spec: { attempts: [], passedValidators: true, retries: 0, cost: cc(2), editDistance: 0, humanMinutes: 1 },
  reference: { report: report(), acceptancePassed: true, falseRejected: false }, candidates: cands, graderCalls: 0, leakage: null, ...over,
});

describe('decision rule gating', () => {
  const good = (id: string) => row(id, [cand(1, { clearsAllRungs: false, label: 'spec violation', rep: { rungs: { preMerge: false, conformance: true, shadow: true } } }), cand(2), cand(3)]);

  it('a pilot of fewer than 11 strict rows is inconclusive in every cell, never validating or invalidating', () => {
    const m = computeMetrics(['A1', 'A2', 'A3', 'A4', 'A5'].map(good), meta);
    expect(m.decision.decisive).toBe(false);
    expect(m.decision).toMatchObject({ A1: 'inconclusive', A2: 'inconclusive', A3: 'inconclusive' });
    expect(m.R).toBe(5); // the raw count is still computed
    const none = computeMetrics(['A1', 'A2'].map((id) => row(id, [cand(1)])), meta);
    expect(none.decision.computed.A1).toBe('invalidating'); // would be invalidating at n=11, but is gated
    expect(none.decision.A1).toBe('inconclusive');
  });

  it('with all 11 strict rows the plan thresholds decide', () => {
    const ids = Array.from({ length: TIER_A_ROWS }, (_, i) => `R${i}`);
    const m = computeMetrics(ids.map((id) => row(id, [cand(1)])), meta);
    expect(m.decision.decisive).toBe(true);
    expect(m.decision.A1).toBe('invalidating'); // R=0 of 11 and no confirmed S
    const m2 = computeMetrics(ids.map(good), meta);
    expect(m2.R).toBe(11);
    expect(m2.decision.A1).toBe('validating');
  });

  it('tier B rows never count', () => {
    const m = computeMetrics([good('B1'), good('B2')].map((r) => ({ ...r, tier: 'B' as const })), meta);
    expect(m.tierA.completeRows).toBe(0);
    expect(m.R).toBe(0);
  });
});

describe('spec metrics', () => {
  it('an unedited spec counts edit distance 0 and its measured generation minutes (not null)', () => {
    const m = computeMetrics([row('A1', [cand(1)])], meta);
    expect(m.rows[0].specEditDistance).toBe(0);
    expect(m.rows[0].specHumanMinutes).toBe(1);
    expect(m.medianEditDistance).toBe(0);
    expect(m.medianHumanMinutes).toBe(1);
  });
});

describe('ladder accounting (A3)', () => {
  it('a held-out failure the candidate\'s own tests missed is NOT a catch (plan: conformance or shadow failure); it is reported as an escape found by held-out tests', () => {
    const failing = cand(1, { deterministicRegression: true, label: null, labelSource: null, rep: { held: { 'a::t': 'failed' } } });
    const m = computeMetrics([row('A1', [failing])], meta);
    expect(m.rows[0].catches).toBe(0);
    expect(m.rows[0].heldOutEscapes).toBe(1);
    expect(m.rows[0].escapes).toBe(1);
    expect(m.catches).toBe(0);
  });
  it('a candidate that fails its own pre-merge rung is not a held-out catch', () => {
    const c = cand(1, { clearsAllRungs: false, rep: { held: { 'a::t': 'failed' }, rungs: { preMerge: false, conformance: true, shadow: true } } });
    expect(computeMetrics([row('A1', [c])], meta).rows[0].heldOutEscapes).toBe(0);
  });
  it('a rung-only failure confirmed by held-out tests is a catch, without them a false positive', () => {
    const rep = { rungs: { preMerge: true, conformance: true, shadow: false } };
    const confirmed = cand(1, { clearsAllRungs: false, deterministicRegression: true, rep: { ...rep, held: { 'a::t': 'passed' } } });
    const unconfirmed = cand(2, { clearsAllRungs: false, rep });
    const m = computeMetrics([row('A1', [confirmed, unconfirmed])], meta);
    expect(m.rows[0]).toMatchObject({ catches: 1, falsePositives: 1 });
  });
});

describe('spec-failed rows count against A2', () => {
  const ok = (id: string) => row(id, [cand(1)]);
  const failedSpec = (id: string): RowResult => row(id, [], { status: 'spec-failed', spec: { attempts: [], passedValidators: false, retries: 1, cost: cc(2), editDistance: 0, humanMinutes: 1 }, reference: null });

  it('they count as attempted rows (toward the 11) and as non-passes: 7 of 11 failing specs invalidates A2', () => {
    const rows = [...Array.from({ length: 4 }, (_, i) => ok(`G${i}`)), ...Array.from({ length: 7 }, (_, i) => failedSpec(`F${i}`))];
    const m = computeMetrics(rows, meta);
    expect(m.tierA).toMatchObject({ completeRows: 4, specFailedRows: 7, attemptedRows: 11 });
    expect(m.decision.decisive).toBe(true);
    expect(m.referenceAcceptancePass).toBe(4);
    expect(m.decision.A2).toBe('invalidating');
  });
  it('fewer than 11 attempted rows stay inconclusive however many specs failed', () => {
    const m = computeMetrics([failedSpec('F1'), failedSpec('F2'), ok('G1')], meta);
    expect(m.decision.decisive).toBe(false);
    expect(m.decision.A2).toBe('inconclusive');
    expect(m.decision.computed.A2).toBe('invalidating');
  });
  it('a failing spec among 11 cannot be rescued into validating', () => {
    const rows = [...Array.from({ length: 7 }, (_, i) => ok(`G${i}`)), ...Array.from({ length: 4 }, (_, i) => failedSpec(`F${i}`))];
    const m = computeMetrics(rows, meta);
    expect(m.specsPassedWithinOneRetry).toBe(7);
    expect(m.decision.A2).not.toBe('validating');
  });
});

describe('arms metrics: candidate-only, paired set, two graders', () => {
  const rates = { inputPerM: 1, outputPerM: 1, cacheReadPerM: 1, cacheCreationPerM: 1 };
  const armsMeta: RunMeta = { ...meta, k: 2, arms: [{ id: 'a', model: 'ma', effort: 'medium', cliAlias: 'ma', family: 'claude', rates, worstCallUsd: 0.1 }, { id: 'b', model: 'mb', effort: 'medium', cliAlias: 'mb', family: 'claude', rates, worstCallUsd: 0.1 }], cliVersion: '1', seed: 's', candidateMaxCalls: { value: 20, default: 40, deliberateChange: true } };
  const ident = (arm: string) => ({ arm, model: `m${arm}`, modelFromInit: true, effort: 'medium', cliVersion: '1', cliAlias: `m${arm}`, family: 'claude' });
  const grade = (grader: string, label: Grade['label']): Grade => ({ tag: { grader, family: 'claude', sameFamilyAsCandidate: true }, label, rationale: 'r' });
  const ac = (arm: string, k: number, over: Partial<CandidateResult> = {}) => cand(k, { arm: ident(arm), ...over });

  it('per-arm cost counts candidate sessions only (not the front half or grading) and sums killed runs apart as estimates', () => {
    const killed = ac('a', 2, { stopReason: 'timeout', cost: { calls: 3, usage, costUsd: null, durationMs: 60_000, estimatedUsd: 0.7, killed: true } });
    const r = row('R1', [ac('a', 1), killed, ac('b', 1), ac('b', 2)], { graderCalls: 4, issueCost: cc(50), spec: { attempts: [], passedValidators: true, retries: 0, cost: cc(60), editDistance: 0, humanMinutes: 1 } });
    const m = computeArmsMetrics([r], armsMeta);
    const a = m.paired.find((x) => x.arm === 'a')!;
    expect(a).toMatchObject({ candidates: 2, calls: 13, timeouts: 1, lowerBound: true });
    expect(a.costUsd).toBeCloseTo(1.0);
    expect(a.estimatedUsd).toBeCloseTo(0.7);
    expect(m.paired.find((x) => x.arm === 'b')).toMatchObject({ calls: 20, costUsd: 2, estimatedUsd: 0, lowerBound: false });
    expect(m.frontHalf.calls).toBe(110); // reported once, outside the arm numbers
  });

  it('between-arm numbers use the paired set only: a row where an arm did not finish K is reported apart', () => {
    const full = row('R1', [ac('a', 1), ac('a', 2), ac('b', 1), ac('b', 2)]);
    const partial = row('R2', [ac('a', 1), ac('a', 2), ac('b', 1)]);
    const aborted = row('R3', [ac('a', 1)], { status: 'aborted' });
    const m = computeArmsMetrics([full, partial, aborted], armsMeta);
    expect(m.pairedRows).toEqual(['R1']);
    expect(m.unpairedRows.map((u) => u.id)).toEqual(['R2', 'R3']);
    expect(m.unpairedRows[0].reason).toMatch(/b 1\/2/);
    // an aborted row (a cap hit during grading) whose candidates are all there is still paired
    const capped = row('R4', [ac('a', 1), ac('a', 2), ac('b', 1), ac('b', 2)], { status: 'aborted' });
    expect(computeArmsMetrics([full, capped], armsMeta).pairedRows).toEqual(['R1', 'R4']);
    expect(m.paired.map((s) => s.candidates)).toEqual([2, 2]);
    expect(m.unpaired.find((s) => s.arm === 'a')!.candidates).toBe(3);
  });

  it('two grades per item flow through metrics, per grader and in the agreement count; the legacy counts see both', () => {
    const g2 = (arm: string, k: number, l1: Grade['label'], l2: Grade['label']) => ac(arm, k, { label: null, labelSource: null, clearsAllRungs: true, grades: [grade('g-a', l1), grade('g-b', l2)] });
    const r = row('R1', [g2('a', 1, 'spec-gap', 'spec-gap'), g2('a', 2, 'regression', 'spec-gap'), ac('b', 1), ac('b', 2)]);
    const m = computeArmsMetrics([r], armsMeta);
    expect(m.graders.map((g) => g.grader)).toEqual(['g-a', 'g-b']);
    expect(m.graders[0].byArm.a).toEqual({ 'spec-gap': 1, regression: 1 });
    expect(m.graders[1].byArm.a).toEqual({ 'spec-gap': 2 });
    expect(m.agreement).toEqual({ items: 2, agree: 1, rate: 0.5 });
    const legacy = computeMetrics([r], armsMeta);
    expect(legacy.graderLabelled.count).toBe(4);
    expect(legacy.graderLabelled.byGrader['g-a']).toEqual({ 'spec-gap': 1, regression: 1 });
    expect(legacy.rows[0].escapesModelJudged).toBe(1); // any grader's regression on a candidate that cleared every rung
  });

  it('the report carries the arms sections, labels each grader, and leaves out the decision rule', () => {
    const r = row('R1', [ac('a', 1, { label: null, labelSource: null, grades: [grade('g-a', 'spec-gap'), grade('g-b', 'equivalent')] }), ac('a', 2), ac('b', 1), ac('b', 2)]);
    const rep = buildReport({ ...armsMeta, runBudget: { grade: { calls: 2, costUsd: 0.08, inputTokens: 1, outputTokens: 1 } }, reportedModels: { a: 'ma-x' }, dollar: { capUsd: 15, chargedUsd: 3, estimatedUsd: 0.5 } }, { version: 1, plan: 'p', frozenAt: 'f', freezes: [], rows: [] }, [r], computeMetrics([r], armsMeta));
    for (const s of ['## Arms', 'ma-x', 'not reported', 'Paired set', 'Candidate-only', 'Grader g-a (family claude; sameFamilyAsCandidate: true, labelled same-family grader)', 'Agreement between graders', 'grade 2 calls', 'Dollar cap $15.00', 'no superiority claim', 'spec-gap [g-a (same-family grader)] / equivalent [g-b (same-family grader)]']) expect(rep.toLowerCase(), s).toContain(s.toLowerCase());
    expect(rep).not.toContain('## Decision rule');
  });
});

import { describe, expect, it } from 'vitest';
import { computeMetrics, TIER_A_ROWS } from '../metrics.ts';
import type { OracleReport } from '../oracles.ts';
import type { CandidateResult, RowResult, RunMeta } from '../results.ts';

const meta: RunMeta = { runId: 't', client: 'fake', startedAt: '', finishedAt: '', k: 3, aborted: null, budget: { expected: 565, hardStop: 850, used: 0, byRole: {} } };
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };
const cc = (calls: number) => ({ calls, usage, costUsd: calls / 10, durationMs: 60_000 });

const report = (over: Partial<OracleReport> & { held?: Record<string, 'passed' | 'failed'> } = {}): OracleReport => ({
  failedRepoTests: [], regressions: [], missingTests: [], acceptance: { total: 1, passed: 1, failed: [] },
  heldOut: { total: 1, outcomes: over.held ?? { 'a::t': 'passed' } }, tsc: null, loadErrors: [], probe: [],
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
  it('a held-out failure the candidate\'s own tests missed is a confirmed catch, and also an escape if every rung cleared', () => {
    const failing = cand(1, { deterministicRegression: true, label: null, labelSource: null, rep: { held: { 'a::t': 'failed' } } });
    const m = computeMetrics([row('A1', [failing])], meta);
    expect(m.rows[0].catches).toBe(1);
    expect(m.rows[0].heldOutCatches).toBe(1);
    expect(m.rows[0].escapes).toBe(1);
    expect(m.catches).toBe(1);
  });
  it('a candidate that fails its own pre-merge rung is not a held-out catch', () => {
    const c = cand(1, { clearsAllRungs: false, rep: { held: { 'a::t': 'failed' }, rungs: { preMerge: false, conformance: true, shadow: true } } });
    expect(computeMetrics([row('A1', [c])], meta).rows[0].heldOutCatches).toBe(0);
  });
  it('a rung-only failure confirmed by held-out tests is a catch, without them a false positive', () => {
    const rep = { rungs: { preMerge: true, conformance: true, shadow: false } };
    const confirmed = cand(1, { clearsAllRungs: false, deterministicRegression: true, rep: { ...rep, held: { 'a::t': 'passed' } } });
    const unconfirmed = cand(2, { clearsAllRungs: false, rep });
    const m = computeMetrics([row('A1', [confirmed, unconfirmed])], meta);
    expect(m.rows[0]).toMatchObject({ catches: 1, falsePositives: 1 });
  });
});

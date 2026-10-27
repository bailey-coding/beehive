// Metrics and the decision rule (plan sections 4 and 5), computed on the strict tier (A) only.
import type { RowResult, RunMeta, CandidateResult } from './results.ts';

export type Verdict = 'validating' | 'invalidating' | 'inconclusive';

export interface RowMetrics {
  id: string;
  obs: string;
  complete: boolean;
  specCalls: number;
  specRetries: number | null;
  specPassed: boolean;
  specEditDistance: number | null;
  specHumanMinutes: number | null;
  referenceAcceptancePassed: boolean | null;
  referenceFalseRejected: boolean | null;
  funnel: { k: number; preMerge: number; conformance: number; shadow: number; clearAll: number };
  /** Share of probe requests where candidates agree with the reference (status + body shape, modulo the surface). */
  meanProbeAgreement: number | null;
  anyCandidateFullyAgrees: boolean;
  rescue: boolean;
  rescueConfirmedDeterministically: boolean;
  spreadS: boolean;
  spreadConfirmedDeterministically: boolean;
  catches: number;
  falsePositives: number;
  escapes: number;
  escapesModelJudged: number;
  totalCalls: number;
  totalCostUsd: number | null;
  k1Cost: number | null;
}

export interface Metrics {
  rows: RowMetrics[];
  tierA: { n: number; nE: number; completeRows: number };
  /** Everything below is computed over tier A complete rows. */
  R: number;
  rescuesConfirmed: number;
  S: number;
  sConfirmed: number;
  specsPassedWithinOneRetry: number;
  referenceAcceptancePass: number;
  medianEditDistance: number | null;
  medianHumanMinutes: number | null;
  specCostShare: number | null;
  catches: number;
  falsePositives: number;
  escapesE: number;
  referenceFalseRejects: number;
  rungsRan: boolean;
  graderLabelled: { count: number; byLabel: Record<string, number>; label: 'same-family grader' };
  costPerAcceptedChange: number | null;
  costPerAcceptedChangeK1: number | null;
  decision: { A1: Verdict; A2: Verdict; A3: Verdict; decisive: boolean; note: string };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const rowCost = (r: RowResult): { calls: number; usd: number | null; tokens: number } => {
  const parts = [r.issueCost, r.spec?.cost ?? null, ...r.candidates.map((c) => c.cost)].filter((x): x is NonNullable<typeof x> => !!x);
  let usd: number | null = 0;
  let tokens = 0;
  let calls = r.graderCalls;
  for (const p of parts) {
    calls += p.calls;
    tokens += p.usage.inputTokens + p.usage.outputTokens + p.usage.cacheReadTokens + p.usage.cacheCreationTokens;
    usd = usd === null || p.costUsd === null ? null : usd + p.costUsd;
  }
  return { calls, usd, tokens };
};

function isConfirmedClear(c: CandidateResult): boolean {
  return c.clearsAllRungs && c.labelSource === 'deterministic' && (c.label === 'equivalent' || c.label === 'spec-permitted variation');
}

function rowMetrics(r: RowResult): RowMetrics {
  const cands = r.candidates.filter((c) => c.report);
  const clears = cands.filter((c) => c.clearsAllRungs);
  const c1 = cands.find((c) => c.k === 1);
  const rescue = !!c1 && !c1.clearsAllRungs && clears.length > 0;
  const heldPass = (c: CandidateResult) => Object.values(c.report!.heldOut.outcomes).filter((s) => s === 'passed').length;
  const differing = clears.length >= 2 && (new Set(clears.map((c) => c.label)).size > 1 || clears.some((c) => (c.probeAgreement?.permitted ?? 0) > 0));
  const detRank = clears.length >= 2 && new Set(clears.map(heldPass)).size > 1 && clears.every((c) => c.labelSource === 'deterministic');
  let catches = 0;
  let falsePositives = 0;
  let escapes = 0;
  let escapesModelJudged = 0;
  for (const c of cands) {
    const rep = c.report!;
    const preMergeOnly = rep.rungs.preMerge && (rep.rungs.conformance === false || rep.rungs.shadow === false);
    if (preMergeOnly) c.deterministicRegression ? catches++ : falsePositives++;
    if (c.clearsAllRungs) {
      if (c.deterministicRegression || c.label === 'regression' && c.labelSource === 'deterministic') escapes++;
      else if (c.label === 'regression' && c.labelSource === 'same-family grader') escapesModelJudged++;
    }
  }
  const cost = rowCost(r);
  const k1 = r.issueCost && r.spec && c1 ? r.issueCost.costUsd !== null && r.spec.cost.costUsd !== null && c1.cost.costUsd !== null ? r.issueCost.costUsd + r.spec.cost.costUsd + c1.cost.costUsd : null : null;
  const agreements = cands.map((c) => (c.probeAgreement && c.probeAgreement.total ? (c.probeAgreement.exact + c.probeAgreement.permitted) / c.probeAgreement.total : null)).filter((x): x is number => x !== null);
  return {
    id: r.id,
    obs: r.obs,
    complete: r.status === 'complete',
    specCalls: r.spec?.cost.calls ?? 0,
    specRetries: r.spec?.retries ?? null,
    specPassed: r.spec?.passedValidators ?? false,
    specEditDistance: r.spec?.editDistance ?? null,
    specHumanMinutes: r.spec?.humanMinutes ?? null,
    referenceAcceptancePassed: r.reference ? r.reference.acceptancePassed : null,
    referenceFalseRejected: r.reference ? r.reference.falseRejected : null,
    funnel: {
      k: r.candidates.length,
      preMerge: cands.filter((c) => c.report!.rungs.preMerge).length,
      conformance: cands.filter((c) => c.report!.rungs.preMerge && c.report!.rungs.conformance !== false).length,
      shadow: cands.filter((c) => c.clearsAllRungs).length,
      clearAll: clears.length,
    },
    meanProbeAgreement: agreements.length ? agreements.reduce((a, b) => a + b, 0) / agreements.length : null,
    anyCandidateFullyAgrees: cands.some((c) => c.label === 'equivalent'),
    rescue,
    rescueConfirmedDeterministically: rescue && clears.some(isConfirmedClear),
    spreadS: differing,
    spreadConfirmedDeterministically: differing && detRank,
    catches,
    falsePositives,
    escapes,
    escapesModelJudged,
    totalCalls: cost.calls,
    totalCostUsd: cost.usd,
    k1Cost: k1,
  };
}

export function computeMetrics(rows: RowResult[], _meta: RunMeta): Metrics {
  const all = rows.map(rowMetrics);
  const tierA = rows.filter((r) => r.tier === 'A');
  const done = all.filter((m) => rows.find((r) => r.id === m.id)!.tier === 'A' && m.complete);
  const doneRows = rows.filter((r) => r.tier === 'A' && r.status === 'complete');
  const R = done.filter((m) => m.rescue).length;
  const rescuesConfirmed = done.filter((m) => m.rescueConfirmedDeterministically).length;
  const S = done.filter((m) => m.spreadS).length;
  const sConfirmed = done.filter((m) => m.spreadConfirmedDeterministically).length;
  const specPassed1 = done.filter((m) => m.specPassed && (m.specRetries ?? 9) <= 1).length;
  const refAcc = done.filter((m) => m.referenceAcceptancePassed).length;
  const edit = median(done.map((m) => m.specEditDistance).filter((x): x is number => x !== null));
  const mins = median(done.map((m) => m.specHumanMinutes).filter((x): x is number => x !== null));
  const catches = done.reduce((n, m) => n + m.catches, 0);
  const fps = done.reduce((n, m) => n + m.falsePositives, 0);
  const escapesE = done.filter((m) => m.obs === 'E').reduce((n, m) => n + m.escapes, 0);
  const falseRejects = done.filter((m) => m.referenceFalseRejected).length;
  const rungsRan = doneRows.some((r) => r.candidates.some((c) => c.report && (c.report.rungs.conformance !== null || c.report.rungs.shadow !== null)));

  const totals = doneRows.map(rowCost);
  const specUsd = doneRows.map((r) => r.spec?.cost.costUsd ?? null);
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
  const usdKnown = doneRows.length > 0 && [...specUsd, ...totals.map((t) => t.usd)].every((x) => x !== null);
  const tok = (u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  const specShare = doneRows.length === 0 ? null
    : usdKnown && sum(totals.map((t) => t.usd)) > 0 ? sum(specUsd) / sum(totals.map((t) => t.usd))
    : sum(totals.map((t) => t.tokens)) > 0 ? doneRows.reduce((n, r) => n + (r.spec ? tok(r.spec.cost.usage) : 0), 0) / sum(totals.map((t) => t.tokens)) : null;
  const accepted = done.filter((m) => m.funnel.clearAll > 0);
  const gl: Record<string, number> = {};
  let glCount = 0;
  for (const r of rows) for (const c of r.candidates) if (c.labelSource === 'same-family grader' && c.label) { glCount++; gl[c.label] = (gl[c.label] ?? 0) + 1; }
  const perAccepted = accepted.length && done.every((m) => m.totalCostUsd !== null) ? done.reduce((a, m) => a + (m.totalCostUsd ?? 0), 0) / accepted.length : null;
  const k1Accepted = done.filter((m) => rows.find((r) => r.id === m.id)!.candidates.find((c) => c.k === 1)?.clearsAllRungs).length;
  const perAcceptedK1 = k1Accepted && done.every((m) => m.k1Cost !== null) ? done.reduce((a, m) => a + (m.k1Cost ?? 0), 0) / k1Accepted : null;

  const n = done.length;
  const A1: Verdict = R <= 1 && sConfirmed === 0 ? 'invalidating' : R >= 3 && rescuesConfirmed + sConfirmed >= 3 ? 'validating' : 'inconclusive';
  const editedRewrite = edit !== null && edit > 0.5;
  const A2: Verdict = refAcc < 5 || editedRewrite ? 'invalidating'
    : specPassed1 >= 8 && refAcc >= 8 && edit !== null && edit < 0.2 && mins !== null && mins < 10 && specShare !== null && specShare < 0.25 ? 'validating' : 'inconclusive';
  const A3: Verdict = !rungsRan ? 'inconclusive'
    : (catches === 0 && fps === 0) || escapesE >= 3 || falseRejects >= 3 ? 'invalidating'
    : catches >= 1 && escapesE <= 1 && falseRejects <= 1 ? 'validating' : 'inconclusive';
  const decisive = n >= 11;
  return {
    rows: all,
    tierA: { n: tierA.length, nE: tierA.filter((r) => r.obs === 'E').length, completeRows: n },
    R, rescuesConfirmed, S, sConfirmed,
    specsPassedWithinOneRetry: specPassed1,
    referenceAcceptancePass: refAcc,
    medianEditDistance: edit,
    medianHumanMinutes: mins,
    specCostShare: specShare,
    catches, falsePositives: fps, escapesE, referenceFalseRejects: falseRejects, rungsRan,
    graderLabelled: { count: glCount, byLabel: gl, label: 'same-family grader' },
    costPerAcceptedChange: perAccepted,
    costPerAcceptedChangeK1: perAcceptedK1,
    decision: {
      A1, A2, A3, decisive,
      note: decisive ? 'tier A has >= 11 complete rows' : `pilot: n=${n} complete tier-A row(s) of 11 required; thresholds are the plan's absolute counts and these cells are informational, not a decision (plan section 6)`,
    },
  };
}

// Behavioural comparison with the reference and deterministic-first labelling (plan section 3, steps 5-6).
import { compareRecords, type DeltaSurface, type ResponseRecord } from './delta.ts';
import type { OracleReport } from './oracles.ts';
import type { Label } from './results.ts';

export function testAgreement(cand: OracleReport, ref: OracleReport): { total: number; agree: number } {
  const keys = new Set([...Object.keys(ref.heldOut.outcomes)]);
  let agree = 0;
  for (const k of keys) if (cand.heldOut.outcomes[k] === ref.heldOut.outcomes[k]) agree++;
  // acceptance cases: reference status is all-passed by calibration; candidate agrees when its case passed
  const accTotal = ref.acceptance.total;
  const accAgree = accTotal - cand.acceptance.failed.filter((f) => !ref.acceptance.failed.includes(f)).length;
  return { total: keys.size + accTotal, agree: agree + Math.max(0, accAgree) };
}

export interface Deterministic {
  /** Null = the oracles do not decide: a model judges the residue. */
  label: Label | null;
  deterministicRegression: boolean;
  clearsAllRungs: boolean;
  why: string;
}

export function labelDeterministically(cand: OracleReport, ref: OracleReport, surface: DeltaSurface, candProbe: ResponseRecord[], refProbe: ResponseRecord[]): Deterministic {
  const heldFailed = Object.entries(ref.heldOut.outcomes).filter(([k, s]) => s === 'passed' && cand.heldOut.outcomes[k] !== 'passed').map(([k]) => k);
  const clears = cand.rungs.preMerge && cand.rungs.conformance !== false && cand.rungs.shadow !== false;
  const deterministicRegression = cand.regressions.length > 0 || cand.failedRepoTests.length > 0 || cand.missingTests.length > 0;
  if (cand.regressions.length > 0) return { label: 'regression', deterministicRegression, clearsAllRungs: clears, why: `${cand.regressions.length} repo test(s) that passed on base now fail` };
  if (cand.acceptance.failed.length > 0 || cand.conformanceViolations.length > 0 || cand.shadowViolations.length > 0 || cand.loadErrors.length > 0) {
    return { label: 'spec violation', deterministicRegression, clearsAllRungs: clears, why: 'acceptance, conformance or delta check failed' };
  }
  if (!clears) return { label: null, deterministicRegression, clearsAllRungs: clears, why: 'pre-merge rung failed without a decisive cause' };
  if (heldFailed.length > 0) return { label: null, deterministicRegression: true, clearsAllRungs: clears, why: `passes spec oracles but fails ${heldFailed.length} held-out test(s)` };
  if (candProbe.length && refProbe.length) {
    const a = compareRecords(candProbe, refProbe, surface);
    return a.exact === a.total
      ? { label: 'equivalent', deterministicRegression, clearsAllRungs: clears, why: 'all oracles and probes agree with the reference' }
      : { label: 'spec-permitted variation', deterministicRegression, clearsAllRungs: clears, why: `${a.differ.length} probe(s) differ from the reference within or outside the declared surface` };
  }
  return { label: 'equivalent', deterministicRegression, clearsAllRungs: clears, why: 'all oracles and held-out tests agree (no probes recorded)' };
}

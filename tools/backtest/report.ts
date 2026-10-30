// One markdown report per run. Model-judged numbers are labelled 'same-family grader'.
import type { Corpus } from './corpus.ts';
import type { Metrics } from './metrics.ts';
import { GRADER_LABEL, type RowResult, type RunMeta } from './results.ts';

const f = (n: number | null, d = 2) => (n === null ? 'n/a' : n.toFixed(d));
const usd = (n: number | null) => (n === null ? 'n/a' : `$${n.toFixed(2)}`);

export function buildReport(meta: RunMeta, corpus: Corpus, rows: RowResult[], m: Metrics): string {
  const L: string[] = [];
  L.push(`# Backtest report: ${meta.runId}`, '');
  L.push(`**Candidate tools: ${meta.bashMode === 'bwrap' ? `file tools + Bash in a bwrap sandbox (${meta.sandbox ?? 'sandbox not recorded'})` : 'file tools only (no Bash)'}. Results from the two modes are never mixed.**`, '');
  L.push(`Client: ${meta.client}. K=${meta.k}. Started ${meta.startedAt}, finished ${meta.finishedAt}.`);
  L.push(`Plan: ${corpus.plan}. Corpus frozen ${corpus.frozenAt}. Rows: ${rows.map((r) => r.id).join(', ')}.`, '');
  if (meta.aborted) L.push(`> **ABORTED (partial results):** ${meta.aborted}`, '');
  if (rows.some((r) => r.status === 'awaiting-issue-approval')) L.push('> **Stopped after the issue stage:** issue texts await human approval (see each row note).', '');
  L.push(`> Model-judged numbers below are labelled "${GRADER_LABEL}" (Sonnet 5.5 graded its own family's work; waived for the pilot only). A different-family grader is required for any confirmation run.`, '');

  L.push('## Budget', '');
  L.push(`Calls used ${meta.budget.used} (expected ${meta.budget.expected}, hard stop ${meta.budget.hardStop}).`, '');
  L.push('| role | calls | input tokens | output tokens | cost |', '|---|---|---|---|---|');
  for (const [role, v] of Object.entries(meta.budget.byRole)) L.push(`| ${role} | ${v.calls} | ${v.inputTokens} | ${v.outputTokens} | ${usd(v.costUsd)} |`);
  L.push('');

  L.push('## Per-row table', '');
  L.push('| row | tier/obs | status | spec attempts | spec ok | ref acceptance | ref false-rejected | candidates (label, source) | leakage 1/2/3/4 |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const lk = r.leakage;
    const lkc = lk ? [lk.wrongIssue ? (lk.wrongIssue.passed === null ? '?' : lk.wrongIssue.passed ? 'ok' : 'FAIL') : '-', lk.overlap.passed ? 'ok' : `${lk.overlap.specFlags.length + lk.overlap.issueFlags.length} flag(s)`, lk.history ? (lk.history.passed ? 'ok' : 'FAIL') : '-', lk.docAtBase.passed ? 'ok' : 'FAIL'].join('/') : '-';
    const cands = r.candidates.map((c) => `c${c.k}: ${c.label ?? 'unlabelled'}${c.labelSource === GRADER_LABEL ? ` (${GRADER_LABEL})` : ''}`).join('; ') || '-';
    L.push(`| ${r.id} \`${r.sha}\` | ${r.tier}/${r.obs} | ${r.status} | ${r.spec?.attempts.length ?? '-'} | ${r.spec ? (r.spec.passedValidators ? 'yes' : 'no') : '-'} | ${r.reference ? `${r.reference.report.acceptance.passed}/${r.reference.report.acceptance.total}` : '-'} | ${r.reference ? (r.reference.falseRejected ? 'YES' : 'no') : '-'} | ${cands} | ${lkc} |`);
  }
  L.push('');
  for (const r of rows) if (r.note) L.push(`- ${r.id}: ${r.note}`);
  L.push('');

  L.push('## Funnel (candidates clearing each rung)', '');
  L.push('| row | K run | pre-merge | + conformance | + shadow substitute | clear all | mean probe agreement | any fully agrees |', '|---|---|---|---|---|---|---|---|');
  for (const x of m.rows) L.push(`| ${x.id} | ${x.funnel.k} | ${x.funnel.preMerge} | ${x.funnel.conformance} | ${x.funnel.shadow} | ${x.funnel.clearAll} | ${f(x.meanProbeAgreement)} | ${x.anyCandidateFullyAgrees ? 'yes' : 'no'} |`);
  L.push('');

  L.push('## Metrics (tier A, complete rows)', '');
  L.push(`n = ${m.tierA.completeRows} complete (+${m.tierA.specFailedRows} spec-failed) of ${m.tierA.n} tier-A rows (${m.tierA.nE} observable-E).`, '');
  L.push(`- Rescue rate R: ${m.R} rows (${m.rescuesConfirmed} confirmed by deterministic oracles).`);
  L.push(`- Spec-permitted spread S: ${m.S} rows (${m.sConfirmed} confirmed deterministically).`);
  L.push(`- Specs passing validators within 1 retry: ${m.specsPassedWithinOneRetry}. Reference passes acceptance: ${m.referenceAcceptancePass}.`);
  L.push(`- Spec edit distance (median): ${f(m.medianEditDistance)}; human minutes (median): ${f(m.medianHumanMinutes, 1)}; spec share of per-change cost: ${f(m.specCostShare)}.`);
  L.push(`- Ladder: catches ${m.catches} false positives ${m.falsePositives}, escapes on E rows ${m.escapesE}, reference false-rejects ${m.referenceFalseRejects}. Conformance/shadow rungs ran: ${m.rungsRan ? 'yes' : 'no (no probe records)'}.`);
  L.push(`- Escapes found by held-out tests (candidate passed its own tests and the acceptance, fails a held-out test the reference passes; not counted as catches): ${m.rows.reduce((n, x) => n + x.heldOutEscapes, 0)}.`);
  L.push(`- Spec-failed rows (count against A2 as evidence): ${m.tierA.specFailedRows}.`);
  L.push(`- Cost per accepted change: ${usd(m.costPerAcceptedChange)}; same spec with K=1: ${usd(m.costPerAcceptedChangeK1)}.`);
  L.push(`- Model-judged labels (${GRADER_LABEL}): ${m.graderLabelled.count}${Object.keys(m.graderLabelled.byLabel).length ? ` (${Object.entries(m.graderLabelled.byLabel).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}. A human samples 20% of these.`);
  L.push(m.human ? `- Human review of the sample (${m.human.label}): ${m.human.labelAgree} of ${m.human.answered} model labels confirmed (${(100 * (m.human.agreementRate ?? 0)).toFixed(0)}%); divergence as judged by the human: ${Object.entries(m.human.divergence).map(([k, v]) => `${k} ${v}`).join(', ')}; a reviewer would accept ${m.human.reviewerAccepts} of ${m.human.answered}.` : '- Human review of the sample: not yet done (run `sample`, then `sample --ingest`).', '');

  L.push('## Decision rule (pre-registered thresholds, tier A only)', '');
  L.push(`| A1 value of N | A2 specs reliable, cheap | A3 oracles replace review (shadow rung) |`, '|---|---|---|', `| ${m.decision.A1} | ${m.decision.A2} | ${m.decision.A3} |`, '');
  if (!m.decision.decisive) L.push(`Raw cells if the thresholds were applied to this pilot anyway (not a verdict): A1 ${m.decision.computed.A1}, A2 ${m.decision.computed.A2}, A3 ${m.decision.computed.A3}.`, '');
  L.push(`${m.decision.note}. Evidence that rests on the ${GRADER_LABEL} alone cannot validate a cell.`, '');
  L.push('A2 clause "spec defects explain most candidate failures" is deliberately NOT implemented: attributing a divergence to a missing or wrong spec clause needs a human trace, so A2 invalidating test here uses only the reference-acceptance and rewrite clauses. Spec-failed rows already count against A2 (they lower the passing counts).', '');
  L.push('Not run: train, canary, full rungs; fuzz replay (about 200 requests per route); human review of issue texts beyond the approval gate; human sample of graded cases.', '');
  return L.join('\n');
}

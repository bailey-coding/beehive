// One markdown report per run. Model-judged numbers are labelled 'same-family grader'.
import type { Corpus } from './corpus.ts';
import { computeArmsMetrics, type ArmSummary, type ArmsMetrics, type Metrics } from './metrics.ts';
import { GRADER_LABEL, gradesOf, graderText, type CandidateResult, type RowResult, type RunMeta } from './results.ts';

const f = (n: number | null, d = 2) => (n === null ? 'n/a' : n.toFixed(d));
const usd = (n: number | null) => (n === null ? 'n/a' : `$${n.toFixed(2)}`);

function candText(c: CandidateResult): string {
  const gs = gradesOf(c);
  const who = c.arm ? `${c.arm.arm} ` : '';
  const labels = c.label ?? (gs.length ? gs.map((g) => `${g.label} [${graderText(g.tag)}]`).join(' / ') : 'unlabelled');
  return `${who}c${c.k}: ${labels}`;
}

const dur = (ms: number) => `${(ms / 60000).toFixed(1)} min`;
const costCell = (s: ArmSummary) => `${usd(s.costUsd)}${s.estimatedUsd ? ` + up to ${usd(s.estimatedUsd)} estimated` : ''}${s.lowerBound ? ' (lower bound: killed runs)' : ''}`;

function armTable(rows: ArmSummary[]): string[] {
  const L = ['| arm | rows | candidates | clear all rungs | held-out tests passed | deterministic regressions | escapes | held-out escapes | calls | tokens | cost | wall time | timeouts / call limits |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const s of rows) L.push(`| ${s.arm} | ${s.rows} | ${s.candidates} | ${s.clearAll}${s.clearAllRate === null ? '' : ` (${(100 * s.clearAllRate).toFixed(0)}%)`} | ${s.heldOutPassed}/${s.heldOutTotal} | ${s.deterministicRegressions} | ${s.escapes} | ${s.heldOutEscapes} | ${s.calls} | ${s.tokens} | ${costCell(s)} | ${dur(s.wallMs)} | ${s.timeouts} / ${s.callLimits} |`);
  return L;
}

function armsSections(meta: RunMeta, am: ArmsMetrics): string[] {
  const L: string[] = [];
  L.push('## Arms', '');
  L.push('| arm | requested model | model reported by the CLI | effort | family |', '|---|---|---|---|---|');
  for (const a of meta.arms!) L.push(`| ${a.id} | ${a.cliAlias} | ${meta.reportedModels?.[a.id] ?? `not reported (requested model assumed)`} | ${a.effort} | ${a.family} |`);
  L.push('');
  L.push(`CLI ${meta.cliVersion ?? 'unknown'}. Arm order per row and k: seeded interleave (seed \`${meta.seed ?? 'n/a'}\`). Candidate maxCalls ${meta.candidateMaxCalls?.value ?? 'n/a'} for every arm${meta.candidateMaxCalls?.deliberateChange ? ` (a deliberate change from the default ${meta.candidateMaxCalls.default})` : ''}. File tools only unless the header says otherwise.`);
  if (meta.harness) L.push(`Harness commit ${meta.harness.commit}${meta.harness.dirty ? ' (dirty tree)' : ''}.`);
  if (meta.reuse) L.push(`Front half (issue text, spec, leakage-1) reused from an earlier run, hash-recorded in front-half.json (manifest sha256 ${meta.reuse.manifest.slice(0, 12)}).`);
  if (meta.dollar) L.push(`Dollar cap $${meta.dollar.capUsd.toFixed(2)} for the whole run: $${meta.dollar.chargedUsd.toFixed(2)} charged, of which $${meta.dollar.estimatedUsd.toFixed(2)} are upper-bound estimates for killed runs that reported no cost.`);
  L.push('');
  L.push('## Candidate-only cost and outcomes per arm (paired rows)', '');
  L.push(`Paired set: rows where every arm finished all K=${meta.k} candidates: ${am.pairedRows.join(', ') || 'none'}. Cost, tokens and wall time are the candidate sessions only; the front half and grading are below, once.`, '');
  L.push(...armTable(am.paired), '');
  if (am.unpairedRows.length) {
    L.push('## Unpaired rows (reported separately, not in the comparison above)', '');
    for (const u of am.unpairedRows) L.push(`- ${u.id}: ${u.reason}`);
    L.push('', ...armTable(am.unpaired), '');
  }
  L.push('## Model-judged labels (secondary, one table per grader)', '');
  if (!am.graders.length) L.push('No candidate needed a model grader.', '');
  for (const g of am.graders) {
    L.push(`Grader ${g.grader} (family ${g.family}; sameFamilyAsCandidate: ${g.sameFamilyAsCandidate}${g.sameFamilyAsCandidate ? `, labelled ${GRADER_LABEL}` : ''}):`, '');
    L.push('| arm | labels |', '|---|---|');
    for (const [arm, byLabel] of Object.entries(g.byArm)) L.push(`| ${arm} | ${Object.entries(byLabel).map(([k, v]) => `${k}: ${v}`).join(', ')} |`);
    L.push('');
  }
  if (am.graders.length > 1) L.push(`Agreement between graders: ${am.agreement.agree} of ${am.agreement.items} items got the same label from every grader${am.agreement.rate === null ? '' : ` (${(100 * am.agreement.rate).toFixed(0)}%)`}. No agree-only headline number is computed; deterministic labels take precedence over any grader label.`, '');
  L.push('## Front half and grading (reported once, not per arm)', '');
  const rb = meta.runBudget ?? {};
  L.push(`- Front half stored with the rows (issue text, spec; earlier run, not spent here): ${am.frontHalf.calls} calls, ${usd(am.frontHalf.costUsd)}.`);
  L.push(`- Spent by this run: ${Object.entries(rb).map(([role, v]) => `${role} ${v.calls} calls ${usd(v.costUsd)}`).join('; ') || 'nothing recorded'}.`, '');
  L.push('## Threats to validity', '');
  L.push('- Few rows and K per row: descriptive only. The rows are this repo\'s own history, which the models may have seen. The spec was written by one model (Sonnet) for every arm and may favor its own reading.');
  L.push('- CLI and model-alias drift is recorded above, not controlled. Timeouts hit slower models harder (same cap for every arm). No sampling seed control: K is the only variance handle.');
  L.push('- Ceiling effect: most candidates clear every rung, so held-out tests are the discriminator. Candidates have file tools only and cannot run tests.');
  L.push('');
  return L;
}

export function buildReport(meta: RunMeta, corpus: Corpus, rows: RowResult[], m: Metrics): string {
  const L: string[] = [];
  L.push(`# Backtest report: ${meta.runId}`, '');
  L.push(`**Candidate tools: ${meta.bashMode === 'bwrap' ? `file tools + Bash in a bwrap sandbox (${meta.sandbox ?? 'sandbox not recorded'})` : 'file tools only (no Bash)'}. Results from the two modes are never mixed.**`, '');
  L.push(`Client: ${meta.client}. K=${meta.k}. Started ${meta.startedAt}, finished ${meta.finishedAt}.`);
  L.push(`Plan: ${corpus.plan}. Corpus frozen ${corpus.frozenAt}. Rows: ${rows.map((r) => r.id).join(', ')}.`, '');
  if (meta.aborted) L.push(`> **ABORTED (partial results):** ${meta.aborted}`, '');
  if (rows.some((r) => r.status === 'awaiting-issue-approval')) L.push('> **Stopped after the issue stage:** issue texts await human approval (see each row note).', '');
  if (meta.arms) L.push('> **Descriptive comparison, no superiority claim** (few rows, K candidates each). Only the deterministic endpoints are conclusions. Every model-judged number below is labelled with its grader and whether that grader shares a family with the candidate; same-family labels stay out of every conclusion.', '');
  else L.push(`> Model-judged numbers below are labelled "${GRADER_LABEL}" (Sonnet 5.5 graded its own family's work; waived for the pilot only). A different-family grader is required for any confirmation run.`, '');

  L.push('## Budget', '');
  L.push(`Calls used ${meta.budget.used} (expected ${meta.budget.expected}, hard stop ${meta.budget.hardStop}); the table is the lifetime global ledger${meta.arms ? ', not this run (see "Cost per arm" for this run)' : ''}.`, '');
  L.push('| role | calls | input tokens | output tokens | cost |', '|---|---|---|---|---|');
  for (const [role, v] of Object.entries(meta.budget.byRole)) L.push(`| ${role} | ${v.calls} | ${v.inputTokens} | ${v.outputTokens} | ${usd(v.costUsd)} |`);
  L.push('');

  L.push('## Per-row table', '');
  L.push('| row | tier/obs | status | spec attempts | spec ok | ref acceptance | ref false-rejected | candidates (label, source) | leakage 1/2/3/4 |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const lk = r.leakage;
    const lkc = lk ? [lk.wrongIssue ? (lk.wrongIssue.passed === null ? '?' : lk.wrongIssue.passed ? 'ok' : 'FAIL') : '-', lk.overlap.passed ? 'ok' : `${lk.overlap.specFlags.length + lk.overlap.issueFlags.length} flag(s)`, lk.history ? (lk.history.passed ? 'ok' : 'FAIL') : '-', lk.docAtBase.passed ? 'ok' : 'FAIL'].join('/') : '-';
    const cands = r.candidates.map(candText).join('; ') || '-';
    L.push(`| ${r.id} \`${r.sha}\` | ${r.tier}/${r.obs} | ${r.status} | ${r.spec?.attempts.length ?? '-'} | ${r.spec ? (r.spec.passedValidators ? 'yes' : 'no') : '-'} | ${r.reference ? `${r.reference.report.acceptance.passed}/${r.reference.report.acceptance.total}` : '-'} | ${r.reference ? (r.reference.falseRejected ? 'YES' : 'no') : '-'} | ${cands} | ${lkc} |`);
  }
  L.push('');
  for (const r of rows) if (r.note) L.push(`- ${r.id}: ${r.note}`);
  L.push('');

  if (meta.arms) {
    L.push(...armsSections(meta, computeArmsMetrics(rows, meta)));
    return L.join('\n');
  }
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

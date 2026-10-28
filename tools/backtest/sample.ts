// Human review of model-judged labels (plan: a human samples 20% of them). `sample` picks cases with a seeded,
// deterministic rule, writes a self-contained review file for someone who has not seen the run, and `--ingest` turns the
// human's answers into a machine-readable file that metrics.ts reads (agreement of human and model labels).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CorpusRow } from './corpus.ts';
import { redact } from './client.ts';
import type { CandidateResult } from './results.ts';
import { GRADER_LABEL } from './results.ts';

export const DEFAULT_SEED = 20261028;
/** Labels preferred first, one per label, so the sample covers different kinds of verdict. */
export const LABEL_PRIORITY = ['spec violation', 'spec-gap', 'regression', 'better-than-reference', 'spec-permitted variation', 'equivalent'];

export interface SampleCase {
  rowId: string;
  k: number;
  label: string;
  rationale: string;
}

/** mulberry32: a small seeded PRNG, so the pick is reproducible from the seed alone. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick `n` model-judged cases: one per label in priority order (seeded choice within a label), then fill from the rest. */
export function pickCases(cases: SampleCase[], n: number, seed: number): SampleCase[] {
  const rnd = prng(seed);
  const sorted = [...cases].sort((a, b) => (a.rowId + a.k).localeCompare(b.rowId + b.k, 'en', { numeric: true }));
  const picked: SampleCase[] = [];
  const pool = [...sorted];
  const take = (c: SampleCase) => {
    picked.push(c);
    pool.splice(pool.indexOf(c), 1);
  };
  for (const label of LABEL_PRIORITY) {
    if (picked.length >= n) break;
    const group = pool.filter((c) => c.label === label);
    if (group.length) take(group[Math.floor(rnd() * group.length)]);
  }
  while (picked.length < n && pool.length) take(pool[Math.floor(rnd() * pool.length)]);
  return picked;
}

export interface RunFiles {
  runDir: string;
  rows: CorpusRow[];
  /** Reference diff of a row's real change (harness-only; read from git). */
  referenceDiff: (row: CorpusRow) => Promise<string>;
}

export function modelJudged(runDir: string): { cases: SampleCase[]; candidates: Map<string, CandidateResult> } {
  const cases: SampleCase[] = [];
  const candidates = new Map<string, CandidateResult>();
  const rowsDir = path.join(runDir, 'rows');
  for (const id of fs.readdirSync(rowsDir)) {
    const cdir = path.join(rowsDir, id, 'candidates');
    if (!fs.existsSync(cdir)) continue;
    for (const f of fs.readdirSync(cdir).filter((x) => /^c\d+\.json$/.test(x))) {
      const c = JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8')) as CandidateResult;
      if (c.labelSource === GRADER_LABEL && c.label) {
        cases.push({ rowId: id, k: c.k, label: c.label, rationale: (c.rationale ?? '').replace(`${GRADER_LABEL}: `, '') });
        candidates.set(`${id}-c${c.k}`, c);
      }
    }
  }
  return { cases, candidates };
}

/** Keep the relevant hunks: source and tests, no docs, no acceptance scaffolding, at most `maxLines` lines. */
export function trimDiff(diff: string, maxLines = 140): string {
  const blocks = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const keep = blocks.filter((b) => !/^diff --git a\/(docs\/|tests\/backtest-acceptance\/)/.test(b));
  const lines = keep.join('').split('\n');
  if (lines.length <= maxLines) return lines.join('\n').trimEnd();
  return `${lines.slice(0, maxLines).join('\n')}\n... (${lines.length - maxLines} more lines not shown)`;
}

function acceptanceSummary(spec: { acceptance: { file: string; name: string; code: string }[]; contract: string; out_of_scope?: string[] }): string {
  const out: string[] = [];
  for (const a of spec.acceptance) {
    out.push(`- \`${a.file}\``);
    const its = [...a.code.matchAll(/\bit(?:\.each\([^)]*\))?\(\s*[`'"]([^`'"]+)[`'"]/g)].map((m) => m[1]);
    for (const t of its.slice(0, 8)) out.push(`  - case: ${t}`);
    const expects = [...a.code.matchAll(/^\s*expect\(([^\n]{0,110})/gm)].map((m) => m[1].trim());
    for (const e of expects.slice(0, 6)) out.push(`  - asserts: \`expect(${e}\``);
  }
  try {
    const rules = (JSON.parse(spec.contract) as { rules?: string[] }).rules ?? [];
    for (const r of rules.slice(0, 6)) out.push(`- contract rule: ${r}`);
  } catch {
    /* contract not JSON */
  }
  for (const r of spec.out_of_scope ?? []) out.push(`- must not change: ${r}`);
  return out.join('\n');
}

function oracleFacts(c: CandidateResult): string {
  const r = c.report;
  if (!r) return '- no oracle report recorded for this candidate';
  const lines: string[] = [];
  const msg = (k: string) => (r.failureMessages?.[k] ? ` - ${redact(r.failureMessages[k], 220).replace(/\n/g, ' ')}` : ' - (message not recorded in this run)');
  lines.push(`- rungs: pre-merge ${r.rungs.preMerge ? 'pass' : 'FAIL'}, conformance ${r.rungs.conformance === null ? 'not run' : r.rungs.conformance ? 'pass' : 'FAIL'}, shadow ${r.rungs.shadow === null ? 'not run' : r.rungs.shadow ? 'pass' : 'FAIL'}`);
  lines.push(`- spec acceptance tests: ${r.acceptance.passed}/${r.acceptance.total} pass`);
  for (const k of r.acceptance.failed) lines.push(`  - FAILED ${k}${msg(k)}`);
  const heldFailed = Object.entries(r.heldOut.outcomes).filter(([, s]) => s !== 'passed').map(([k]) => k);
  lines.push(`- held-out tests (from the real change): ${r.heldOut.total - heldFailed.length}/${r.heldOut.total} pass${heldFailed.length ? ' (a held-out test may also be red at the base; compare with the reference)' : ''}`);
  for (const k of heldFailed.slice(0, 8)) lines.push(`  - FAILED ${k}${msg(k)}`);
  if (r.regressions.length) lines.push(`- repo tests that passed at base and now fail: ${r.regressions.slice(0, 5).join('; ')}`);
  if (r.failedRepoTests.length) lines.push(`- repo tests failing (not red at base): ${r.failedRepoTests.slice(0, 5).join('; ')}`);
  for (const v of [...r.conformanceViolations, ...r.shadowViolations].slice(0, 6)) lines.push(`- probe violation: ${v}`);
  for (const e of r.loadErrors.slice(0, 3)) lines.push(`- load error: ${redact(e, 200).replace(/\n/g, ' ')}`);
  lines.push(`- deterministic notes: ${c.deterministicRegression ? 'a repo or held-out test fails for this candidate' : 'no deterministic failure recorded'}`);
  return lines.join('\n');
}

export const QUESTIONS = [
  'Q1 Is the model grader\'s label right? (yes / no)',
  'Q2 Is the divergence from the reference a spec gap, a permitted variation, or a candidate fault? (spec-gap / permitted-variation / candidate-fault)',
  'Q3 Would a reviewer accept the candidate as it stands? (yes / no)',
];

export async function renderSample(opts: { run: string; seed: number; chosen: SampleCase[]; total: number; files: RunFiles; candidates: Map<string, CandidateResult>; template?: boolean }): Promise<string> {
  const L: string[] = [];
  L.push(`# Human sample: ${opts.run}`, '');
  L.push(`You have not seen this run, and you do not need to. Each case below is one candidate implementation of a real past change, judged by a model (${GRADER_LABEL}: the same model family that wrote the candidate and the spec, so its label is NOT independent evidence). Please check the label yourself.`, '');
  L.push(`Sample: ${opts.chosen.length} of ${opts.total} model-judged cases, picked with seed ${opts.seed} (mulberry32; one case per label in the order ${LABEL_PRIORITY.slice(0, 3).join(', ')}, seeded choice within a label). Re-running \`sample --run ${opts.run} --seed ${opts.seed}\` gives the same pick.`, '');
  L.push('How to answer: replace each `___` with your answer, save the file, then run `npm run backtest -- sample --run ' + opts.run + ' --ingest`.', '');
  for (const c of opts.chosen) {
    const row = opts.files.rows.find((r) => r.id === c.rowId)!;
    L.push(`---`, '', `## Case ${c.rowId}-c${c.k}: ${row.change}`, '');
    if (opts.template) {
      L.push('(template: the real file lists here, for each case, the issue text, the spec acceptance summary, the candidate diff next to the reference diff, the oracle failures with messages, and the model grader\'s label and rationale.)', '');
    } else {
      const rowDir = path.join(opts.files.runDir, 'rows', c.rowId);
      const issue = JSON.parse(fs.readFileSync(path.join(rowDir, 'issue.json'), 'utf8')) as { text: string };
      const spec = JSON.parse(fs.readFileSync(path.join(rowDir, 'spec.json'), 'utf8'));
      const cand = opts.candidates.get(`${c.rowId}-c${c.k}`)!;
      const patchFile = path.join(rowDir, 'candidates', `c${c.k}.patch`);
      const candPatch = fs.existsSync(patchFile) ? trimDiff(fs.readFileSync(patchFile, 'utf8')) : '(candidate diff not saved)';
      const refPatch = trimDiff(await opts.files.referenceDiff(row));
      L.push('### Issue (what the candidate was asked to do)', '', ...issue.text.trim().split('\n').map((l) => `> ${l}`), '');
      L.push('### What the spec\'s acceptance tests check', '', acceptanceSummary(spec), '');
      L.push('### Candidate diff (trimmed to source and tests; no docs)', '', '```diff', candPatch, '```', '');
      L.push('### Reference diff (the real merged change, same trimming)', '', '```diff', refPatch, '```', '');
      L.push('### Test and oracle results for the candidate', '', oracleFacts(cand), '');
      L.push(`### The model grader's verdict (${GRADER_LABEL})`, '', `- label: **${c.label}**`, `- rationale: ${c.rationale || '(none recorded)'}`, '');
    }
    L.push('### Your answers', '');
    for (let i = 0; i < QUESTIONS.length; i++) L.push(`${QUESTIONS[i]}`, `A${i + 1}: ___`, '');
    L.push('Notes (optional): ___', '');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- answers

export const HumanAnswersSchema = z.object({
  run: z.string(),
  seed: z.number(),
  ingestedAt: z.string(),
  cases: z.array(
    z.object({
      key: z.string(),
      rowId: z.string(),
      k: z.number(),
      modelLabel: z.string(),
      labelRight: z.boolean(),
      divergence: z.enum(['spec-gap', 'permitted-variation', 'candidate-fault']),
      reviewerAccepts: z.boolean(),
      notes: z.string(),
    }),
  ),
});
export type HumanAnswers = z.infer<typeof HumanAnswersSchema>;

const yn = (s: string): boolean | null => (/^(y|yes)\b/i.test(s) ? true : /^(n|no)\b/i.test(s) ? false : null);

/** Parse the filled-in review file. Throws with the case and question that is unanswered or unreadable. */
export function parseAnswers(md: string, run: string, seed: number, now = new Date()): HumanAnswers {
  const cases: HumanAnswers['cases'] = [];
  const parts = md.split(/^## Case /m).slice(1);
  if (parts.length === 0) throw new Error('no cases found in the file');
  for (const part of parts) {
    const head = part.match(/^([A-Za-z0-9]+)-c(\d+):/);
    if (!head) throw new Error('a case header is not in the form "## Case A4-c1: ..."');
    const key = `${head[1]}-c${head[2]}`;
    const model = part.match(/- label: \*\*([^*]+)\*\*/)?.[1] ?? 'unknown';
    const ans = (n: number) => (part.match(new RegExp(`^A${n}:\\s*(.*)$`, 'm'))?.[1] ?? '').trim();
    const a1 = yn(ans(1));
    const a3 = yn(ans(3));
    const a2 = ans(2).toLowerCase().replace(/\s+/g, '-').replace(/^spec-gap.*/, 'spec-gap').replace(/^permitted.*/, 'permitted-variation').replace(/^candidate.*/, 'candidate-fault');
    if (a1 === null) throw new Error(`${key}: A1 must be yes or no (found "${ans(1)}")`);
    if (!['spec-gap', 'permitted-variation', 'candidate-fault'].includes(a2)) throw new Error(`${key}: A2 must be spec-gap, permitted-variation or candidate-fault (found "${ans(2)}")`);
    if (a3 === null) throw new Error(`${key}: A3 must be yes or no (found "${ans(3)}")`);
    const notes = (part.match(/^Notes \(optional\):\s*(.*)$/m)?.[1] ?? '').trim().replace(/^___$/, '');
    cases.push({ key, rowId: head[1], k: Number(head[2]), modelLabel: model, labelRight: a1, divergence: a2 as HumanAnswers['cases'][number]['divergence'], reviewerAccepts: a3, notes });
  }
  return HumanAnswersSchema.parse({ run, seed, ingestedAt: now.toISOString(), cases });
}

export function loadHumanAnswers(runDir: string): HumanAnswers | null {
  const f = path.join(runDir, 'human-answers.json');
  return fs.existsSync(f) ? HumanAnswersSchema.parse(JSON.parse(fs.readFileSync(f, 'utf8'))) : null;
}

export interface HumanAgreement {
  label: 'human sample (independent of the same-family grader)';
  answered: number;
  /** Human says the model's label is right. */
  labelAgree: number;
  agreementRate: number | null;
  divergence: Record<string, number>;
  reviewerAccepts: number;
}

export function humanAgreement(h: HumanAnswers | null): HumanAgreement | null {
  if (!h || h.cases.length === 0) return null;
  const divergence: Record<string, number> = {};
  for (const c of h.cases) divergence[c.divergence] = (divergence[c.divergence] ?? 0) + 1;
  const labelAgree = h.cases.filter((c) => c.labelRight).length;
  return { label: 'human sample (independent of the same-family grader)', answered: h.cases.length, labelAgree, agreementRate: labelAgree / h.cases.length, divergence, reviewerAccepts: h.cases.filter((c) => c.reviewerAccepts).length };
}

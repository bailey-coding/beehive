import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CorpusRow } from '../corpus.ts';
import { computeMetrics } from '../metrics.ts';
import { sanitizeReport } from '../publish.ts';
import { buildReport } from '../report.ts';
import type { CandidateResult, RowResult, RunMeta } from '../results.ts';
import { DEFAULT_SEED, humanAgreement, loadHumanAnswers, modelJudged, parseAnswers, pickCases, renderSample, trimDiff, type SampleCase } from '../sample.ts';

const cases: SampleCase[] = [
  { rowId: 'A11', k: 1, label: 'spec violation', rationale: 'r1' },
  { rowId: 'A11', k: 3, label: 'spec violation', rationale: 'r3' },
  { rowId: 'A4', k: 1, label: 'spec-gap', rationale: 'r4' },
  { rowId: 'A4', k: 2, label: 'spec-permitted variation', rationale: 'r5' },
  { rowId: 'A4', k: 3, label: 'spec-gap', rationale: 'r6' },
  { rowId: 'A5', k: 1, label: 'spec-permitted variation', rationale: 'r7' },
  { rowId: 'A5', k: 2, label: 'spec-gap', rationale: 'r8' },
  { rowId: 'A5', k: 3, label: 'spec-permitted variation', rationale: 'r9' },
];

describe('seeded pick', () => {
  it('is deterministic for a seed, independent of input order, and prefers one spec violation and one spec-gap', () => {
    const a = pickCases(cases, 2, DEFAULT_SEED);
    const b = pickCases([...cases].reverse(), 2, DEFAULT_SEED);
    expect(a).toEqual(b);
    expect(a.map((c) => c.label).sort()).toEqual(['spec violation', 'spec-gap']);
    expect(pickCases(cases, 2, DEFAULT_SEED)).toEqual(a);
  });
  it('different seeds can choose different cases within a label; n larger than the pool returns everything once', () => {
    const picks = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => pickCases(cases, 2, s).map((c) => `${c.rowId}${c.k}`).join()));
    expect(picks.size).toBeGreaterThan(1);
    expect(new Set(pickCases(cases, 20, 1).map((c) => `${c.rowId}${c.k}`)).size).toBe(8);
  });
  it('falls back to any case when a preferred label is absent', () => {
    const only = cases.filter((c) => c.label === 'spec-permitted variation');
    expect(pickCases(only, 2, 5)).toHaveLength(2);
  });
});

describe('trimDiff', () => {
  const diff = `diff --git a/docs/X.md b/docs/X.md\n+doc\ndiff --git a/tests/backtest-acceptance/a.test.ts b/tests/backtest-acceptance/a.test.ts\n+acc\ndiff --git a/workers/x.ts b/workers/x.ts\n${'+line\n'.repeat(300)}`;
  it('drops docs and acceptance scaffolding and caps the length', () => {
    const t = trimDiff(diff, 50);
    expect(t).not.toContain('docs/X.md');
    expect(t).not.toContain('backtest-acceptance');
    expect(t).toContain('workers/x.ts');
    expect(t).toMatch(/more lines not shown/);
    expect(t.split('\n').length).toBeLessThanOrEqual(52);
  });
});

function fixtureRun() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-run-'));
  const rowDir = path.join(runDir, 'rows', 'A4');
  fs.mkdirSync(path.join(rowDir, 'candidates'), { recursive: true });
  fs.writeFileSync(path.join(rowDir, 'issue.json'), JSON.stringify({ text: 'SLO thresholds can be NaN\n\nThe monitor reads healthy when a threshold is unset.' }));
  fs.writeFileSync(path.join(rowDir, 'spec.json'), JSON.stringify({ name: 's', contract: JSON.stringify({ rules: ['unset thresholds use defaults'] }), acceptance: [{ name: 'a', file: 'slo.test.ts', code: "it('unset uses defaults', async () => {\n  expect(res.status).toBe(200);\n});" }], declaredDeltaSurface: [{ version: '1.0', routes: [] }], out_of_scope: ['other routes unchanged'] }));
  fs.writeFileSync(path.join(rowDir, 'candidates', 'c1.patch'), 'diff --git a/workers/slo.ts b/workers/slo.ts\n+const x = 1;\n');
  const cand = { k: 1, label: 'spec-gap', labelSource: 'same-family grader', rationale: 'same-family grader: both fall back to defaults', deterministicRegression: true, report: { rungs: { preMerge: true, conformance: true, shadow: null }, acceptance: { total: 2, passed: 1, failed: ['tests/backtest-acceptance/slo.test.ts::unset uses defaults'] }, heldOut: { total: 2, outcomes: { 'w::a': 'passed', 'w::b': 'failed' } }, regressions: [], failedRepoTests: [], conformanceViolations: [], shadowViolations: [], loadErrors: [], failureMessages: { 'tests/backtest-acceptance/slo.test.ts::unset uses defaults': 'AssertionError: expected 500 to be 200' } } } as unknown as CandidateResult;
  fs.writeFileSync(path.join(rowDir, 'candidates', 'c1.json'), JSON.stringify(cand));
  return runDir;
}
const corpusRow = { id: 'A4', sha: 'abc1234', change: 'SLO thresholds never NaN' } as CorpusRow;

describe('review file', () => {
  it('has, per case, the issue, spec summary, both diffs, oracle failures with messages, the model verdict and three questions', async () => {
    const runDir = fixtureRun();
    const { cases: cs, candidates } = modelJudged(runDir);
    expect(cs).toHaveLength(1);
    const md = await renderSample({ run: 'r', seed: 7, chosen: cs, total: 1, files: { runDir, rows: [corpusRow], referenceDiff: async () => 'diff --git a/workers/slo.ts b/workers/slo.ts\n+const real = 2;\n' }, candidates });
    for (const s of ['seed 7', '### Issue', 'SLO thresholds can be NaN', "What the spec's acceptance tests check", 'case: unset uses defaults', 'asserts: `expect(res.status)', 'contract rule: unset thresholds use defaults', 'must not change: other routes unchanged', '+const x = 1;', '+const real = 2;', 'FAILED tests/backtest-acceptance/slo.test.ts::unset uses defaults - AssertionError: expected 500 to be 200', 'held-out tests (from the real change): 1/2 pass', 'rungs: pre-merge pass, conformance pass, shadow not run', 'label: **spec-gap**', 'both fall back to defaults', 'same-family grader', 'Q1', 'Q2', 'Q3', 'A1: ___', 'A2: ___', 'A3: ___']) expect(md, s).toContain(s);
  });
  it('the template carries the structure but no candidate or reference source', async () => {
    const runDir = fixtureRun();
    const { cases: cs, candidates } = modelJudged(runDir);
    const md = await renderSample({ run: 'r', seed: 7, chosen: cs, total: 1, files: { runDir, rows: [corpusRow], referenceDiff: async () => 'SECRET-REFERENCE' }, candidates, template: true });
    expect(md).toContain('A1: ___');
    expect(md).not.toMatch(/const x = 1|SECRET-REFERENCE|SLO thresholds can be NaN/);
  });
});

describe('answers', () => {
  const filled = (a1: string, a2: string, a3: string) => `# x\n## Case A4-c1: SLO\n- label: **spec-gap**\nA1: ${a1}\nA2: ${a2}\nA3: ${a3}\nNotes (optional): looks fine\n## Case A11-c1: CLI\n- label: **spec violation**\nA1: no\nA2: candidate-fault\nA3: no\nNotes (optional): ___\n`;
  it('parses filled answers into the machine-readable shape and computes agreement', () => {
    const h = parseAnswers(filled('yes', 'spec gap', 'Yes'), 'r', 7, new Date('2026-10-28T00:00:00Z'));
    expect(h.cases).toEqual([
      { key: 'A4-c1', rowId: 'A4', k: 1, modelLabel: 'spec-gap', labelRight: true, divergence: 'spec-gap', reviewerAccepts: true, notes: 'looks fine' },
      { key: 'A11-c1', rowId: 'A11', k: 1, modelLabel: 'spec violation', labelRight: false, divergence: 'candidate-fault', reviewerAccepts: false, notes: '' },
    ]);
    const a = humanAgreement(h)!;
    expect(a).toMatchObject({ answered: 2, labelAgree: 1, agreementRate: 0.5, reviewerAccepts: 1, divergence: { 'spec-gap': 1, 'candidate-fault': 1 } });
    expect(humanAgreement(null)).toBeNull();
  });
  it('rejects unanswered or unreadable answers, naming the case and question', () => {
    expect(() => parseAnswers(filled('___', 'spec-gap', 'yes'), 'r', 1)).toThrow(/A4-c1: A1 must be yes or no/);
    expect(() => parseAnswers(filled('yes', 'maybe', 'yes'), 'r', 1)).toThrow(/A4-c1: A2 must be/);
    expect(() => parseAnswers(filled('yes', 'spec-gap', 'perhaps'), 'r', 1)).toThrow(/A4-c1: A3 must be yes or no/);
    expect(() => parseAnswers('nothing here', 'r', 1)).toThrow(/no cases/);
  });
  it('metrics.ts reads the answers: agreement appears in the metrics and the report, labelled as a human sample', () => {
    const runDir = fixtureRun();
    const h = parseAnswers(filled('yes', 'spec-gap', 'yes'), 'r', 7);
    fs.writeFileSync(path.join(runDir, 'human-answers.json'), JSON.stringify(h));
    const loaded = loadHumanAnswers(runDir);
    expect(loaded).not.toBeNull();
    const meta: RunMeta = { runId: 'r', bashMode: 'none', sandbox: null, client: 'fake', startedAt: '', finishedAt: '', k: 1, aborted: null, budget: { expected: 1, hardStop: 1, used: 0, byRole: {} } };
    const rows: RowResult[] = [];
    const m = computeMetrics(rows, meta, loaded);
    expect(m.human).toMatchObject({ answered: 2, labelAgree: 1 });
    const rep = buildReport(meta, { version: 1, plan: 'p', frozenAt: 'f', freezes: [], rows: [] }, rows, m);
    expect(rep).toMatch(/Human review of the sample \(human sample \(independent of the same-family grader\)\): 1 of 2 model labels confirmed \(50%\)/);
    expect(buildReport(meta, { version: 1, plan: 'p', frozenAt: 'f', freezes: [], rows: [] }, rows, computeMetrics(rows, meta))).toMatch(/Human review of the sample: not yet done/);
  });
});

describe('published summaries', () => {
  it('strip code blocks, tokens and home paths', () => {
    const t = sanitizeReport('# r\n```ts\nconst secret = 1;\n```\n- note sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA and /home/paseo/x/y and Bearer abcdefghijklmnop1234\nplain', { name: 'pilot-9', home: '/home/paseo' });
    expect(t).not.toMatch(/const secret|sk-ant|\/home\/paseo|abcdefghijklmnop1234/);
    expect(t).toContain('(code block removed)');
    expect(t).toContain('~/x/y');
    expect(t).toContain('plain');
    expect(t.startsWith('<!-- Summary of run pilot-9')).toBe(true);
  });
});

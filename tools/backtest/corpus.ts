// Corpus freeze file (docs/backtest/corpus.json) and the plan's selection checks that can run without a model.
import fs from 'node:fs';
import { z } from 'zod';
import { changedFiles, commitMessage, git, isDocFile, isTestFile, parentOf } from './git.ts';
import { extractIssueSource } from './text.ts';

export const CorpusRowSchema = z.object({
  id: z.string(),
  sha: z.string().regex(/^[0-9a-f]{7,40}$/),
  base: z.string().regex(/^[0-9a-f]{40}$/),
  tier: z.enum(['A', 'B']),
  /** E = HTTP status/body at a worker edge, W = worker-to-worker/timing/config, N = not HTTP-visible. */
  obs: z.enum(['E', 'W', 'N']),
  component: z.string(),
  change: z.string(),
  issueSource: z.object({
    kind: z.enum(['body', 'subject', 'body+doc']),
    note: z.string(),
    /** Docs the issue text may cite; each must exist at the base (leakage test 4). A quote, when present, is the only
     *  part shown to the issue rewriter (problem clause only) and must appear verbatim in the doc at the base. */
    docs: z.array(z.object({ path: z.string(), quote: z.string().optional() })),
    thin: z.boolean(),
    subject: z.string(),
    body: z.string(),
  }),
  /** Terms naming the change; grepped in docs/ at the base (leakage test 4). */
  keyTerms: z.array(z.string()),
  /** Base docs known to mention a key term, reviewed and accepted as problem-only. */
  acknowledgedDocHits: z.array(z.string()).default([]),
  /** Base docs that state the solution: removed from every agent checkout of this row (scratch repos). */
  scrubDocs: z.array(z.string()).default([]),
  files: z.object({ source: z.array(z.string()), tests: z.array(z.string()), docs: z.array(z.string()) }),
  /** Result of `check --base-green --write`: red tests (drop), flaky tests (kept, noted). */
  baseGreen: z
    .object({ checkedAt: z.string(), tests: z.number(), red: z.array(z.string()), flaky: z.array(z.string()), loadErrors: z.array(z.string()), verdict: z.enum(['keep', 'drop']) })
    .optional(),
  /** Free-text caveats about the row's oracles (for example a base test include that covers little). */
  corpusNote: z.string().optional(),
});

export const CorpusSchema = z.object({
  version: z.literal(1),
  plan: z.string(),
  frozenAt: z.string(),
  rows: z.array(CorpusRowSchema),
});

export type CorpusRow = z.infer<typeof CorpusRowSchema>;
export type Corpus = z.infer<typeof CorpusSchema>;

export interface FreezeInput {
  id: string;
  sha: string;
  tier: 'A' | 'B';
  obs: 'E' | 'W' | 'N';
  component: string;
  kind: CorpusRow['issueSource']['kind'];
  note: string;
  docs?: { path: string; quote?: string }[];
  keyTerms: string[];
  acknowledgedDocHits?: string[];
  scrubDocs?: string[];
  corpusNote?: string;
}

export async function buildRow(repo: string, f: FreezeInput): Promise<CorpusRow> {
  const sha = (await git(repo, ['rev-parse', f.sha])).trim();
  const { subject, body } = await commitMessage(repo, sha);
  const src = extractIssueSource(subject, body);
  const files = await changedFiles(repo, sha);
  return CorpusRowSchema.parse({
    id: f.id,
    sha: sha.slice(0, 7),
    base: await parentOf(repo, sha),
    tier: f.tier,
    obs: f.obs,
    component: f.component,
    change: src.subject,
    issueSource: {
      kind: f.kind,
      note: f.note,
      docs: f.docs ?? [],
      thin: f.kind === 'subject' || src.body.length < 40,
      subject: src.subject,
      body: src.body,
    },
    keyTerms: f.keyTerms,
    acknowledgedDocHits: f.acknowledgedDocHits ?? [],
    scrubDocs: f.scrubDocs ?? [],
    corpusNote: f.corpusNote,
    files: {
      source: files.filter((x) => !isTestFile(x) && !isDocFile(x)),
      tests: files.filter(isTestFile),
      docs: files.filter(isDocFile),
    },
  });
}

export async function freezeCorpus(repo: string, inputs: FreezeInput[], out: string, now = new Date()): Promise<Corpus> {
  const rows: CorpusRow[] = [];
  for (const f of inputs) rows.push(await buildRow(repo, f));
  const problems = await checkIndependence(repo, rows);
  if (problems.length) throw new Error(`base independence (filter 4) failed:\n${problems.join('\n')}`);
  const corpus: Corpus = { version: 1, plan: 'docs/SPEC-BACKTEST-PLAN.md', frozenAt: now.toISOString(), rows };
  fs.writeFileSync(out, JSON.stringify(corpus, null, 2) + '\n');
  return corpus;
}

/** Loads the freeze file and re-derives each base from git: a drifted or hand-edited row is rejected. */
export async function loadCorpus(file: string, repo: string, ids?: string[]): Promise<Corpus> {
  const c = CorpusSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const r of c.rows) {
    const base = await parentOf(repo, r.sha);
    if (base !== r.base) throw new Error(`corpus row ${r.id}: base ${r.base} does not match ${r.sha}^ (${base})`);
  }
  if (ids) {
    const missing = ids.filter((i) => !c.rows.some((r) => r.id === i));
    if (missing.length) throw new Error(`rows not in corpus: ${missing.join(', ')}`);
    return { ...c, rows: c.rows.filter((r) => ids.includes(r.id)) };
  }
  return c;
}

/** Plan filter 4: no selected commit is the parent of another, and no shared non-test source file within 25 commits. */
export async function checkIndependence(repo: string, rows: CorpusRow[], window = 25): Promise<string[]> {
  const problems: string[] = [];
  const order = (await git(repo, ['rev-list', '--no-merges', 'HEAD'])).split('\n').filter(Boolean);
  const pos = (sha: string) => order.findIndex((o) => o.startsWith(sha));
  for (const a of rows) {
    for (const b of rows) {
      if (a.id >= b.id) continue;
      if (b.base.startsWith(a.sha) || a.base.startsWith(b.sha)) problems.push(`${a.id} and ${b.id}: one is the parent of the other`);
      const pa = pos(a.sha);
      const pb = pos(b.sha);
      if (pa >= 0 && pb >= 0 && Math.abs(pa - pb) <= window) {
        const shared = a.files.source.filter((f) => b.files.source.includes(f));
        if (shared.length) problems.push(`${a.id} and ${b.id}: share ${shared.join(', ')} within ${window} commits`);
      }
    }
  }
  return problems;
}

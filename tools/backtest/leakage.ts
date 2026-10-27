// Leakage tests 1-4 (docs/SPEC-BACKTEST-PLAN.md section 2). Test 5 (scrub docs added after the issue) holds by
// construction: agents only ever see a single-commit checkout of the base tree.
import path from 'node:path';
import { exec } from './exec.ts';
import type { CorpusRow } from './corpus.ts';
import { existsAt, git, grepAt, showAt } from './git.ts';
import { jaccard } from './text.ts';
import type { ParsedSpec } from './spec.ts';

/** Test 4: every cited doc exists at the base (`git cat-file -e`); key terms grepped in docs/ at the base. */
export async function docAtBaseTest(repo: string, row: CorpusRow): Promise<{ passed: boolean; detail: string[] }> {
  const detail: string[] = [];
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  for (const d of row.issueSource.docs) {
    if (!(await existsAt(repo, row.base, d.path))) {
      detail.push(`cited doc ${d.path} does not exist at base ${row.base.slice(0, 7)} (added later or wrong path)`);
    } else if (d.quote && !norm(await showAt(repo, row.base, d.path)).includes(norm(d.quote))) {
      detail.push(`quote from ${d.path} is not verbatim in the doc at base`);
    }
  }
  const allowed = new Set([...row.acknowledgedDocHits, ...row.scrubDocs]);
  for (const term of row.keyTerms) {
    const hits = (await grepAt(repo, row.base, term, ['docs'], { word: true })).filter((h) => !allowed.has(h.split(':')[0]));
    for (const h of hits.slice(0, 5)) detail.push(`key term "${term}" appears at base: ${h.slice(0, 140)}`);
  }
  return { passed: detail.length === 0, detail };
}

/** Test 3: the agent checkout is a single-commit repo with no real remote, history or reference to the change. */
export async function historyTest(scratchRepo: string, workRoot: string, realRepo: string, row: CorpusRow): Promise<{ passed: boolean; detail: string[] }> {
  const detail: string[] = [];
  const count = parseInt((await git(scratchRepo, ['rev-list', '--all', '--count'])).trim(), 10);
  if (count !== 1) detail.push(`scratch repo has ${count} commits across refs, expected 1`);
  const known = await exec('git', ['cat-file', '-e', `${row.sha}^{commit}`], { cwd: scratchRepo });
  if (known.code === 0) detail.push(`scratch repo knows the change commit ${row.sha}`);
  const urls = (await exec('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd: scratchRepo })).stdout.split('\n').filter(Boolean).map((l) => l.split(' ')[1]);
  const root = path.resolve(workRoot) + path.sep;
  for (const u of urls) if (!path.resolve(u).startsWith(root)) detail.push('a remote points outside the run directory');
  const rel = path.relative(path.resolve(realRepo), path.resolve(scratchRepo));
  if (!rel.startsWith('..')) detail.push('scratch repo lives inside the real repo checkout (agents could climb into it)');
  if ((await exec('git', ['ls-files', '--', 'tools/backtest', 'docs/backtest'], { cwd: scratchRepo })).stdout.trim()) detail.push('harness or corpus files present in the agent tree');
  return { passed: detail.length === 0, detail };
}

export function endpointSignature(p: ParsedSpec): Set<string> {
  return new Set(p.contract.endpoints.map((e) => `${e.method.toUpperCase()} ${e.path}`));
}

/** Test 1 verdict: spec generated from a different row's issue must differ from the true one. */
export function wrongIssueVerdict(truth: ParsedSpec, wrong: ParsedSpec): { similarity: number; passed: boolean; detail: string } {
  const text = (p: ParsedSpec) => `${p.spec.name} ${p.spec.description ?? ''} ${p.spec.contract}`;
  const similarity = jaccard(text(truth), text(wrong));
  const a = endpointSignature(truth);
  const b = endpointSignature(wrong);
  const sameEndpoints = a.size === b.size && [...a].every((x) => b.has(x));
  const passed = similarity < 0.8 && !(sameEndpoints && a.size > 0 && similarity >= 0.6);
  return { similarity, passed, detail: `token similarity ${similarity.toFixed(2)}, ${sameEndpoints ? 'same' : 'different'} endpoint set` };
}

/** All identifier-like tokens (6+ chars) in the base tree, for test 2. */
export async function baseTokenSet(repo: string, base: string): Promise<Set<string>> {
  const r = await exec('git', ['grep', '-h', '-o', '-I', '-E', '[A-Za-z_$][A-Za-z0-9_$]{5,}', base], { cwd: repo });
  return new Set(r.stdout.split('\n').filter(Boolean));
}

// Pilot orchestrator. Sequential, resumable by artifact, aborts cleanly on the budget stop and writes partial results.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BudgetedClient, BudgetExceeded, type BudgetTracker } from './budget.ts';
import type { ModelClient } from './client.ts';
import { labelDeterministically, testAgreement } from './compare.ts';
import type { Corpus, CorpusRow } from './corpus.ts';
import { compareRecords } from './delta.ts';
import { candidatePrompt, cost, docExcerpt, generateSpec, gradePrompt, issuePrompt, parseGrade, sumCost } from './generate.ts';
import { copyDepsInto } from './bashsandbox.ts';
import { addedLinesOf, addWorktree, commitAndPush, createScratchRepo, diffOf, git, showAt } from './git.ts';
import { baseTokenSet, docAtBaseTest, historyTest, reachabilityTest, referenceMarkers, wrongIssueVerdict } from './leakage.ts';
import { requireSandbox } from './sandbox.ts';
import { acceptanceAgainstReference, baselineReport, evaluateCheckout, linkDeps, loadHeldOut, runAcceptanceOn, type BaselineReport, type OracleConfig } from './oracles.ts';
import { installProbe } from './probe.ts';
import { GRADER_LABEL, type CandidateResult, type LeakageResult, type RowResult, type RunMeta } from './results.ts';
import { ACCEPTANCE_DIR, parseSpec, validateSpec, writeAcceptance, type ParsedSpec } from './spec.ts';
import { normalizedTokenLevenshtein, overlapFlags } from './text.ts';
import { buildReport } from './report.ts';
import { computeMetrics } from './metrics.ts';

export interface RunOptions {
  corpus: Corpus;
  /** The real repo: read-only (git archive / show / diff). */
  repo: string;
  /** Directory holding node_modules, linked into every checkout. */
  harnessRoot: string;
  outDir: string;
  runId: string;
  /** Global call ledger shared by every run, pilot pass and smoke/canary call (default tools/backtest/.ledger.json, gitignored). */
  ledgerFile: string;
  client: ModelClient;
  tracker: BudgetTracker;
  k: number;
  cfg: OracleConfig;
  /** Scratch checkouts live here: must be outside every repo. */
  workRoot: string;
  /** `required`: stop after the issue stage until each issue.json has "approved": true (plan: a human reads each). */
  issueApproval: 'required' | 'auto';
  candidateMaxCalls?: number;
  candidateTimeoutMs?: number;
  /** Opt-in: candidates get a bwrap-sandboxed Bash tool. The client must have been built with a passing sandbox proof. */
  allowBash?: boolean;
  /** Description of the active Bash sandbox (from the proof), recorded in run.json and the report. */
  sandboxDetail?: string | null;
  keepWork?: boolean;
  log?: (s: string) => void;
}

const readJson = <T,>(f: string): T => JSON.parse(fs.readFileSync(f, 'utf8')) as T;
const writeJson = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};

interface IssueFile {
  text: string;
  approved: boolean;
  cost: ReturnType<typeof cost> | null;
  lintFlags: string[];
}

export async function runPilot(o: RunOptions): Promise<{ rows: RowResult[]; meta: RunMeta; reportPath: string }> {
  const log = o.log ?? (() => {});
  const runDir = path.join(o.outDir, o.runId);
  assertDisjoint(o.workRoot);
  if (o.cfg.sandbox === 'unshare') log(`sandbox for agent-written code: ${await requireSandbox()}`); // refuses before any spend if unavailable
  // One global ledger across --run names: a new run name cannot reset the plan's cap.
  o.tracker.attach(o.ledgerFile);
  const client = new BudgetedClient(o.client, o.tracker);
  const startedAt = new Date().toISOString();
  const bashMode: 'none' | 'bwrap' = o.allowBash ? 'bwrap' : 'none';
  const prevMeta = path.join(runDir, 'run.json');
  if (fs.existsSync(prevMeta)) {
    const prev = JSON.parse(fs.readFileSync(prevMeta, 'utf8')).meta?.bashMode ?? 'none';
    if (prev !== bashMode) throw new Error(`run ${o.runId} was started with bashMode=${prev}; refusing to continue it with bashMode=${bashMode} (results of the two modes are never mixed): use a new --run name`);
  }
  const rows: RowResult[] = o.corpus.rows.map((r) => ({ id: r.id, sha: r.sha, tier: r.tier, obs: r.obs, status: 'aborted', issueCost: null, spec: null, reference: null, candidates: [], graderCalls: 0, leakage: null }));
  let aborted: string | null = null;
  const rowDir = (r: CorpusRow) => path.join(runDir, 'rows', r.id);
  const save = (res: RowResult) => writeJson(path.join(rowDir(o.corpus.rows.find((r) => r.id === res.id)!), 'result.json'), res);

  try {
    // ---- phase 1: issue text for every row (+ doc-at-base leakage test 4, no model cost)
    const issues = new Map<string, IssueFile>();
    for (const row of o.corpus.rows) {
      const res = rows.find((r) => r.id === row.id)!;
      const t4 = await docAtBaseTest(o.repo, row);
      res.leakage = { wrongIssue: null, overlap: { issueFlags: [], specFlags: [], passed: true }, history: null, docAtBase: t4 };
      if (!t4.passed) {
        res.status = 'leak-blocked';
        res.note = `doc-at-base test failed: ${t4.detail.join(' | ')}`;
        log(`${row.id}: leak-blocked (test 4)`);
        save(res);
        continue;
      }
      const file = path.join(rowDir(row), 'issue.json');
      let issue: IssueFile;
      if (fs.existsSync(file)) issue = readJson<IssueFile>(file);
      else {
        const docs: { path: string; excerpt: string }[] = [];
        for (const d of row.issueSource.docs) docs.push({ path: d.path, excerpt: docExcerpt(await showAt(o.repo, row.base, d.path), d.quote) });
        const r = await client.run({ role: 'issue', rowId: row.id, prompt: issuePrompt(row, docs), tools: 'none', maxCalls: 2, timeoutMs: 5 * 60_000 });
        const permitted = `${row.issueSource.subject}\n${row.issueSource.body}\n${docs.map((d) => d.excerpt).join('\n')}`;
        const lintFlags = overlapFlags({ text: r.text, issueText: permitted, diffAdded: await addedLinesOf(o.repo, row.sha), baseTokens: await baseTokenSet(o.repo, row.base) });
        issue = { text: r.text.trim(), approved: o.issueApproval === 'auto', cost: cost(r), lintFlags };
        writeJson(file, issue);
      }
      res.issueCost = issue.cost;
      res.leakage.overlap.issueFlags = issue.lintFlags;
      issues.set(row.id, issue);
      log(`${row.id}: issue text ready (${issue.approved ? 'approved' : 'awaiting approval'}, ${issue.lintFlags.length} lint flags)`);
    }
    const pending = o.corpus.rows.filter((r) => issues.has(r.id) && !issues.get(r.id)!.approved);
    if (pending.length) {
      for (const r of pending) {
        const res = rows.find((x) => x.id === r.id)!;
        res.status = 'awaiting-issue-approval';
        res.note = `read ${path.join(rowDir(r), 'issue.json')}, delete solution words, set "approved": true, then rerun with the same --run`;
        save(res);
      }
      for (const res of rows) if (res.status === 'aborted') res.status = 'awaiting-issue-approval';
      log(`stopping after issue stage: ${pending.length} issue text(s) await human approval`);
    } else {
      for (const row of o.corpus.rows) {
        const res = rows.find((r) => r.id === row.id)!;
        if (res.status === 'leak-blocked') continue;
        res.status = 'aborted';
        try {
          await runRow(o, client, row, issues, res, rowDir(row), log);
        } catch (e) {
          if (e instanceof BudgetExceeded) throw e;
          res.status = 'error';
          res.note = e instanceof Error ? e.message : String(e);
          log(`${row.id}: error ${res.note}`);
        } finally {
          save(res);
          if (!o.keepWork) fs.rmSync(path.join(o.workRoot, o.runId, row.id), { recursive: true, force: true });
        }
      }
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    aborted = e.reason;
    log(`ABORT: ${aborted}`);
    for (const row of o.corpus.rows) {
      const res = rows.find((r) => r.id === row.id)!;
      // Only rows that never finished get 'aborted'; spec-failed, error, leak-blocked and complete keep their status.
      if (res.status === 'aborted') {
        res.status = 'aborted';
        res.note ??= aborted ?? undefined;
      }
      save(res);
    }
  }

  const meta: RunMeta = {
    runId: o.runId,
    bashMode,
    sandbox: o.allowBash ? o.sandboxDetail ?? null : null,
    client: o.client.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    k: o.k,
    aborted,
    budget: { expected: o.tracker.expected, hardStop: o.tracker.hardStop, used: o.tracker.used, byRole: o.tracker.byRole() },
  };
  writeJson(path.join(runDir, 'run.json'), { meta, ledger: o.tracker.ledger, rows });
  const reportPath = path.join(runDir, 'report.md');
  fs.writeFileSync(reportPath, buildReport(meta, o.corpus, rows, computeMetrics(rows, meta)));
  return { rows, meta, reportPath };
}

/** Private top-level temp root for one agent: nothing of the harness (references, deps, real repo) lives under or above it. */
function agentRootDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bt-agent-'));
}

export function assertDisjoint(workRoot: string): void {
  const tmp = fs.realpathSync(os.tmpdir());
  fs.mkdirSync(workRoot, { recursive: true });
  const w = fs.realpathSync(workRoot);
  if (tmp === w || tmp.startsWith(w + path.sep)) throw new Error(`workRoot ${workRoot} must not contain the temp directory that holds agent checkouts`);
}

async function runRow(o: RunOptions, client: BudgetedClient, row: CorpusRow, issues: Map<string, IssueFile>, res: RowResult, dir: string, log: (s: string) => void): Promise<void> {
  const work = path.join(o.workRoot, o.runId, row.id);
  const issueText = issues.get(row.id)!.text;
  const leak = res.leakage!;
  const agentRoots: string[] = [];
  const added = await addedLinesOf(o.repo, row.sha);
  let markers = await referenceMarkers(o.repo, row.sha, row.base, added);
  const forbidden = [o.workRoot, o.repo, o.harnessRoot];
  try {
    // ---- dependency provider (harness side only: installed from the base's own lockfile, never HEAD's node_modules)
    const deps = await createScratchRepo(o.repo, row.base, path.join(work, 'deps'), row.scrubDocs);
    if (o.cfg.installDeps && !fs.existsSync(path.join(deps.repo, 'node_modules'))) await o.cfg.installDeps(deps.repo);
    installProbe(deps.repo);
    const runOnBase = (files: string[]) => runAcceptanceOn(deps.repo, o.cfg, files);

    // ---- spec arm: the read-only generator runs in its own private root (single-commit tree, no deps)
    const specRoot = agentRootDir();
    agentRoots.push(specRoot);
    const specAgent = await createScratchRepo(o.repo, row.base, specRoot, row.scrubDocs);
    const sr = reachabilityTest({ agentRoot: specRoot, cwd: specAgent.repo, forbiddenRoots: forbidden, markers });
    if (!sr.passed) {
      res.status = 'leak-blocked';
      res.note = `reachability test failed (spec generator): ${sr.detail.join(' | ')}`;
      return;
    }
    // Reference checkout up front: the spec must pass on the real change before any candidate call is spent.
    const refScratch = await createScratchRepo(o.repo, row.base, path.join(work, 'reference'), row.scrubDocs);
    linkDeps(deps.repo, refScratch.repo);
    const patchFile = path.join(work, 'reference.patch');
    fs.writeFileSync(patchFile, await diffOf(o.repo, row.sha));
    await git(refScratch.repo, ['apply', '--exclude=docs/*', patchFile]);
    await git(refScratch.repo, ['add', '-A']);
    await git(refScratch.repo, ['commit', '-q', '-m', 'reference']);
    const specFile = path.join(dir, 'spec.json');
    let parsed: ParsedSpec | null = null;
    if (fs.existsSync(specFile)) {
      parsed = parseSpec(readJson(specFile));
    } else {
      const onReference = async (p: ParsedSpec) => {
        const a = await acceptanceAgainstReference(refScratch.repo, deps.repo, o.cfg, p);
        const errors = a.malformed.map((m) => `probe record() misused (${m})`);
        for (const e of a.loadErrors) errors.push(`acceptance failed to load against the reference implementation: ${e.slice(0, 160)}`);
        for (const f of a.failing) errors.push(`acceptance case "${f.name}" does not pass on a correct implementation of the issue (checked against the real change, whose behaviour is not shown): it asserts something the issue does not require, or uses the wrong entrypoint or layer. Rewrite it to assert only what the issue states, through its public entrypoint.`);
        for (const c of a.contractViolations) errors.push(`recorded probe "${c.label}" contradicts the spec's own contract on a correct implementation (details withheld): fix the contract's responses or the probe.`);
        for (const d of a.deltaViolations) errors.push(`recorded probe "${d.label}": the declared delta surface does not allow the change a correct implementation makes there (${d.kind}; details withheld). List the route or fields that change, and record only real HTTP responses at real routes.`);
        const details = [...a.failing.map((f) => `${f.name}: ${f.message ?? 'failed'}`), ...a.contractViolations.map((c) => c.detail), ...a.deltaViolations.map((d) => `${d.label}: ${d.kind} ${d.detail}`)];
        return { errors, details };
      };
      const g = await generateSpec({ client, row, issueText, baseDir: deps.repo, agentCwd: specAgent.repo, validate: true, runOnBase, extraValidate: onReference });
      if (g.raw) writeJson(path.join(dir, 'spec.generated.json'), g.raw);
      const passed = g.attempts[g.attempts.length - 1].ok;
      // Unedited spec: edit distance 0 and minutes = measured generation time. A human fix overwrites both below.
      res.spec = { attempts: g.attempts, passedValidators: passed, retries: g.attempts.length - 1, cost: g.cost, editDistance: 0, humanMinutes: g.cost.durationMs / 60000 };
      writeJson(path.join(dir, 'spec.meta.json'), res.spec);
      if (!passed || !g.parsed) {
        res.status = 'spec-failed';
        res.note = g.attempts[g.attempts.length - 1].errors.join('; ');
        writeJson(path.join(dir, 'result.json'), res); // the stop rule below may abort the run: keep this status
        o.tracker.recordSpecOutcome(false);
        return;
      }
      o.tracker.recordSpecOutcome(true);
      parsed = g.parsed;
      // A human may fix S: keep both versions and the edit distance.
      const fixed = path.join(dir, 'spec.fixed.json');
      if (fs.existsSync(fixed)) {
        const v = await validateSpec(readJson(fixed), deps.repo, runOnBase);
        if (!v.result.ok || !v.parsed) throw new Error(`spec.fixed.json fails validators: ${v.result.errors.join('; ')}`);
        res.spec.editDistance = normalizedTokenLevenshtein(JSON.stringify(g.raw), JSON.stringify(readJson(fixed)));
        const mins = path.join(dir, 'spec.fixed.meta.json');
        res.spec.humanMinutes = fs.existsSync(mins) ? readJson<{ minutes?: number }>(mins).minutes ?? null : null;
        parsed = v.parsed;
        writeJson(specFile, readJson(fixed));
        writeJson(path.join(dir, 'spec.meta.json'), res.spec);
      } else writeJson(specFile, g.raw);
    }
    if (!res.spec && fs.existsSync(path.join(dir, 'spec.meta.json'))) res.spec = readJson(path.join(dir, 'spec.meta.json'));
    const specJson = JSON.stringify(readJson(specFile), null, 2);
    markers = await referenceMarkers(o.repo, row.sha, row.base, added, `${specJson}\n${issueText}`);

    // ---- leakage tests 1 (wrong issue) and 2 (overlap)
    const all = o.corpus.rows;
    const wrongRow = all.length > 1 ? all[(all.findIndex((r) => r.id === row.id) + 1) % all.length] : null;
    if (wrongRow && issues.has(wrongRow.id)) {
      const w = await generateSpec({ client, row, issueText: issues.get(wrongRow.id)!.text, baseDir: deps.repo, agentCwd: specAgent.repo, validate: false, runOnBase, role: 'leakage' });
      if (w.parsed) {
        const v = wrongIssueVerdict(parsed, w.parsed);
        leak.wrongIssue = { ran: true, similarity: v.similarity, passed: v.passed, detail: v.detail };
      } else leak.wrongIssue = { ran: true, similarity: null, passed: null, detail: 'wrong-issue spec did not parse' };
    }
    leak.overlap.specFlags = overlapFlags({ text: specJson, issueText, diffAdded: await addedLinesOf(o.repo, row.sha), baseTokens: await baseTokenSet(o.repo, row.base) });
    leak.overlap.passed = leak.overlap.specFlags.length === 0 && leak.overlap.issueFlags.length === 0;

    // ---- baseline + reference arm (harness-owned roots, outside every agent root)
    const heldOut = await loadHeldOut(o.repo, row.sha, row.base, row.files.tests);
    const baseline: BaselineReport = await baselineReport(deps.repo, o.cfg, parsed.spec, heldOut);
    const evalArgs = { cfg: o.cfg, spec: parsed.spec, contract: parsed.contract, surface: parsed.surface, baseline, heldOut };
    const refReport = await evaluateCheckout({ dir: refScratch.repo, ...evalArgs });
    const refAccepted = refReport.acceptance.total > 0 && refReport.acceptance.passed === refReport.acceptance.total;
    const heldBad = Object.entries(refReport.heldOut.outcomes).some(([k, s]) => s !== 'passed' && !baseline.heldOutRed.includes(k));
    const falseRejected = !refReport.rungs.preMerge || refReport.rungs.conformance === false || refReport.rungs.shadow === false || heldBad;
    res.reference = { report: refReport, acceptancePassed: refAccepted, falseRejected };
    writeJson(path.join(dir, 'reference.json'), res.reference);
    log(`${row.id}: reference acceptance ${refReport.acceptance.passed}/${refReport.acceptance.total}${falseRejected ? ' (FALSE-REJECTED by a rung)' : ''}`);

    // ---- candidate arm
    const refDiff = fs.readFileSync(patchFile, 'utf8');
    const residue: { c: CandidateResult; facts: string[]; patch: string }[] = [];
    for (let k = 1; k <= o.k; k++) {
      const cfile = path.join(dir, 'candidates', `c${k}.json`);
      if (fs.existsSync(cfile)) {
        res.candidates.push(readJson<CandidateResult>(cfile));
        continue;
      }
      // Private root: only the single-commit scratch repo, its worktree and its scratch origin. No deps, no references.
      const croot = agentRootDir();
      agentRoots.push(croot);
      const scratch = await createScratchRepo(o.repo, row.base, croot, row.scrubDocs);
      const wt = path.join(croot, 'wt');
      const branch = `work/${row.id}-c${k}`;
      await addWorktree(scratch.repo, wt, branch);
      installProbe(wt);
      const accFiles = writeAcceptance(wt, parsed.spec);
      const agentTmp = path.join(croot, 'tmp');
      if (o.allowBash) {
        fs.mkdirSync(agentTmp);
        copyDepsInto(deps.repo, wt); // a plain copy inside the agent's root, never a symlink out of it
      }
      const h = await historyTest(scratch.repo, croot, o.repo, row);
      const reach = reachabilityTest({ agentRoot: croot, cwd: wt, forbiddenRoots: forbidden, markers });
      leak.history = { passed: (leak.history?.passed ?? true) && h.passed && reach.passed, detail: [...(leak.history?.detail ?? []), ...h.detail, ...reach.detail] };
      if (!h.passed || !reach.passed) {
        res.status = 'leak-blocked';
        res.note = `leakage test 3 failed: ${[...h.detail, ...reach.detail].join(' | ')}`;
        return;
      }
      const cr: CandidateResult = { k, stopReason: 'error', cost: { calls: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: 0, durationMs: 0 }, commit: null, changedFiles: [], report: null, clearsAllRungs: false, testAgreement: { total: 0, agree: 0 }, probeAgreement: null, label: null, labelSource: null, deterministicRegression: false };
      try {
        const run = await client.run({ role: 'candidate', rowId: row.id, prompt: candidatePrompt(issueText, specJson, accFiles, { bash: !!o.allowBash }), tools: 'agent', cwd: wt, ...(o.allowBash ? { bashBox: { agentRoot: croot, cwd: wt, tmpDir: agentTmp } } : {}), maxCalls: o.candidateMaxCalls ?? 40, timeoutMs: o.candidateTimeoutMs ?? 30 * 60_000 });
        cr.cost = cost(run);
        cr.stopReason = run.stopReason;
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          // Always-pushed invariant: whatever the agent left is committed and pushed to scratch before aborting.
          await commitAndPush(wt, branch, `scratch: ${row.id} c${k} (aborted)`).catch(() => {});
          throw e;
        }
        cr.error = e instanceof Error ? e.message : String(e);
      }
      cr.commit = await commitAndPush(wt, branch, `candidate ${row.id} c${k}`);
      cr.changedFiles = (await git(wt, ['diff', '--name-only', 'main', 'HEAD'])).split('\n').filter((f) => f && !f.startsWith(ACCEPTANCE_DIR));
      const patch = await git(wt, ['diff', 'main', 'HEAD', '--', '.', `:!${ACCEPTANCE_DIR}`]);
      fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'candidates', `c${k}.patch`), patch);
      // Evaluate a clone of the pushed scratch branch under the harness root, with the base's own installed deps.
      const evalDir = path.join(work, `eval-${k}`);
      await git(work, ['clone', '-q', '--no-hardlinks', '-b', `scratch/${row.id}-c${k}`, scratch.origin, evalDir]);
      fs.appendFileSync(path.join(evalDir, '.git', 'info', 'exclude'), 'node_modules\n.vitest-cache\ntest-results\n');
      linkDeps(deps.repo, evalDir);
      cr.report = await evaluateCheckout({ dir: evalDir, ...evalArgs });
      cr.testAgreement = testAgreement(cr.report, refReport);
      cr.probeAgreement = cr.report.probe.length && refReport.probe.length ? compareRecords(cr.report.probe, refReport.probe, parsed.surface) : null;
      const det = labelDeterministically(cr.report, refReport, parsed.surface, cr.report.probe, refReport.probe);
      cr.clearsAllRungs = det.clearsAllRungs;
      cr.deterministicRegression = det.deterministicRegression;
      cr.label = det.label;
      cr.labelSource = det.label ? 'deterministic' : null;
      cr.rationale = det.why;
      if (!det.label) residue.push({ c: cr, patch, facts: [det.why, `held-out failures: ${Object.entries(refReport.heldOut.outcomes).filter(([key, s]) => s === 'passed' && cr.report!.heldOut.outcomes[key] !== 'passed').map(([key]) => key).join('; ') || 'none'}`] });
      res.candidates.push(cr);
      writeJson(cfile, cr);
      log(`${row.id} c${k}: ${cr.label ?? 'residue'} (${cr.cost.calls} calls, rungs ${cr.clearsAllRungs ? 'cleared' : 'not cleared'})`);
    }

    // ---- model-judged residue (at most 3 grader calls per row; every such number is labelled 'same-family grader')
    for (const r of residue.slice(0, 3)) {
      const g = await client.run({ role: 'grade', rowId: row.id, prompt: gradePrompt({ issueText, specJson, candidateDiff: r.patch, referenceDiff: refDiff, facts: r.facts }), tools: 'none', maxCalls: 2, timeoutMs: 5 * 60_000 });
      res.graderCalls += g.calls;
      try {
        const v = parseGrade(g.text);
        r.c.label = v.label;
        r.c.labelSource = GRADER_LABEL;
        r.c.rationale = `${GRADER_LABEL}: ${v.rationale}`;
      } catch (e) {
        r.c.rationale = `${r.c.rationale}; grader reply unusable: ${e instanceof Error ? e.message : e}`;
      }
      writeJson(path.join(dir, 'candidates', `c${r.c.k}.json`), r.c);
    }
    res.status = 'complete';
  } finally {
    if (!o.keepWork) for (const r of agentRoots) fs.rmSync(r, { recursive: true, force: true });
  }
}

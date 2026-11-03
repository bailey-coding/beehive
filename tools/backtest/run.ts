// Pilot orchestrator. Sequential, resumable by artifact, aborts cleanly on the budget stop and writes partial results.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { armIdent, assertPreflight, GRADE_MAX_CALLS, preflight, pricingOf, reuseFrontHalf, runIdentity, seededOrder, sha256, type ArmSpec } from './arms.ts';
import { BudgetedClient, BudgetExceeded, DollarMeter, type BudgetTracker } from './budget.ts';
import type { ModelClient } from './client.ts';
import { labelDeterministically, testAgreement } from './compare.ts';
import type { Corpus, CorpusRow } from './corpus.ts';
import { compareRecords } from './delta.ts';
import { candidatePrompt, cost, docExcerpt, generateSpec, gradePrompt, issuePrompt, parseGrade, sumCost } from './generate.ts';
import { copyDepsInto } from './bashsandbox.ts';
import { addedLinesOf, addWorktree, commitAndPush, createScratchRepo, diffOf, git, showAt } from './git.ts';
import { baseTokenSet, docAtBaseTest, historyTest, reachabilityTest, referenceMarkers, wrongIssueVerdict } from './leakage.ts';
import { requireSandbox } from './sandbox.ts';
import { loadHumanAnswers } from './sample.ts';
import { acceptanceAgainstReference, baselineReport, evaluateCheckout, linkDeps, loadHeldOut, runAcceptanceOn, type BaselineReport, type OracleConfig } from './oracles.ts';
import { installProbe } from './probe.ts';
import { gradesOf, type ArmRowState, type CandidateResult, type Grade, type GraderTag, type LeakageResult, type RowResult, type RunMeta } from './results.ts';
import { ACCEPTANCE_DIR, parseSpec, validateSpec, writeAcceptance, type ParsedSpec } from './spec.ts';
import { normalizedTokenLevenshtein, overlapFlags } from './text.ts';
import { buildReport } from './report.ts';
import { computeMetrics } from './metrics.ts';

export interface ArmRun {
  spec: ArmSpec;
  client: ModelClient;
  cliVersion: string;
}

/** Candidate runs of one arm, and the grader it lends (crossed grading uses every arm's client). */
interface ArmCtx {
  /** null: the single-client layout (candidates/c1.json, eval-1). */
  id: string | null;
  client: BudgetedClient;
  run?: ArmRun;
}

interface GraderCtx {
  tag: (candidate: CandidateResult) => GraderTag;
  client: BudgetedClient;
  id: string;
}

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
  /** The one client of a single-client run (every role). Unused in an arms run, where each arm brings its own. */
  client?: ModelClient;
  tracker: BudgetTracker;
  /** Arms run (docs/plans/model-comparison-plan.md): candidates of every arm per row, interleaved, then crossed grading. */
  arms?: ArmRun[];
  /** Seed of the arm order (default: the run id). */
  seed?: string;
  /** Arms run: copy the front half (issue, spec, leakage-1 result) of these rows from an earlier run directory. The front half is never generated in an arms run. */
  reuseFrom?: string;
  harness?: { commit: string; dirty: boolean };
  /** Arms run: run-level hard cap in USD; hitting it aborts the whole run. */
  dollarCapUsd?: number;
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
  const armRuns = o.arms;
  const rowDir = (r: CorpusRow) => path.join(runDir, 'rows', r.id);
  if (!armRuns && !o.client) throw new Error('runPilot needs a client, or arms');
  const meter = armRuns ? new DollarMeter(o.dollarCapUsd ?? 15, o.tracker, o.runId) : undefined;
  const client = armRuns ? null : new BudgetedClient(o.client!, o.tracker);
  const armCtxs: ArmCtx[] = armRuns
    ? armRuns.map((a) => ({ id: a.spec.id, run: a, client: new BudgetedClient(a.client, o.tracker, true, { ident: { runId: o.runId, arm: a.spec.id, model: a.spec.model, effort: a.spec.effort, cliVersion: a.cliVersion, cliAlias: a.spec.model }, pricing: pricingOf(a.spec), meter }) }))
    : [{ id: null, client: client! }];
  // Single-client run: the one client grades, tagged as the pilot's same-family grader. Arms run: every arm's client grades every residue item.
  const graders: GraderCtx[] = armRuns
    ? armCtxs.map((a) => ({ id: a.id!, client: a.client, tag: (c: CandidateResult): GraderTag => ({ grader: a.id!, family: a.run!.spec.family, sameFamilyAsCandidate: a.run!.spec.family === (c.arm?.family ?? '') }) }))
    : [{ id: o.client!.name, client: client!, tag: () => ({ grader: o.client!.name, family: 'claude', sameFamilyAsCandidate: true }) }];
  const startedAt = new Date().toISOString();
  const bashMode: 'none' | 'bwrap' = o.allowBash ? 'bwrap' : 'none';
  const seed = o.seed ?? o.runId;
  const identity = armRuns ? runIdentity(armRuns.map((a) => a.spec), armRuns[0].cliVersion) : null;
  const prevMeta = path.join(runDir, 'run.json');
  if (fs.existsSync(prevMeta)) {
    const pm = JSON.parse(fs.readFileSync(prevMeta, 'utf8')).meta as Partial<RunMeta> | undefined;
    const prev = pm?.bashMode ?? 'none';
    if (prev !== bashMode) throw new Error(`run ${o.runId} was started with bashMode=${prev}; refusing to continue it with bashMode=${bashMode} (results of the two modes are never mixed): use a new --run name`);
    // Arm table, model, effort and CLI version are fixed for a run id, like bashMode: results of two setups are never mixed.
    const prevIdentity = pm?.arms ? runIdentity(pm.arms, pm.cliVersion ?? '') : null;
    if (prevIdentity !== identity) throw new Error(`run ${o.runId} was started with ${prevIdentity ?? 'a single client'}; refusing to continue it with ${identity ?? 'a single client'} (changed arm table, model, effort or CLI version): use a new --run name`);
    if (armRuns && pm?.candidateMaxCalls && pm.candidateMaxCalls.value !== (o.candidateMaxCalls ?? 40)) throw new Error(`run ${o.runId} was started with candidate maxCalls ${pm.candidateMaxCalls.value}; refusing to continue it with ${o.candidateMaxCalls ?? 40}`);
  }
  let reuseManifest: ReturnType<typeof reuseFrontHalf> | null = null;
  if (armRuns) {
    if (armRuns.length < 2) throw new Error('an arms run needs at least two arms');
    if (!o.reuseFrom || !o.harness) throw new Error('an arms run reuses a frozen front half: reuseFrom and harness are required');
    reuseManifest = reuseFrontHalf({ fromRunDir: o.reuseFrom, toRunDir: runDir, rows: o.corpus.rows, harness: o.harness });
    // Worst case in calls, before any spend: pending candidates x maxCalls + pending grading + the canary reserve.
    const kCand = o.corpus.rows.length * armRuns.length * o.k;
    let storedCands = 0;
    let ungraded = 0;
    for (const row of o.corpus.rows) {
      for (const a of armRuns) {
        for (let k = 1; k <= o.k; k++) {
          const f = path.join(rowDir(row), 'candidates', a.spec.id, `c${k}.json`);
          if (!fs.existsSync(f)) continue;
          storedCands++;
          const c = readJson<CandidateResult>(f);
          if (c.label === null && c.report) ungraded += armRuns.filter((g) => !gradesOf(c).some((x) => x.tag.grader === g.spec.id)).length;
        }
      }
    }
    const pf = preflight({ pendingCandidates: kCand - storedCands, pendingGrades: (kCand - storedCands) * armRuns.length + ungraded, candidateMaxCalls: o.candidateMaxCalls ?? 40, remaining: o.tracker.remaining });
    log(`pre-flight: worst case ${pf.worstCase} calls (candidates ${pf.candidateCalls}, grading ${pf.gradingCalls}, canary reserve ${pf.canaryCalls}) of ${pf.remaining} remaining`);
    assertPreflight(pf);
  }
  const rows: RowResult[] = o.corpus.rows.map((r) => ({ id: r.id, sha: r.sha, tier: r.tier, obs: r.obs, status: 'aborted', issueCost: null, spec: null, reference: null, candidates: [], graderCalls: 0, leakage: null }));
  let aborted: string | null = null;
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
        if (!client) throw new Error(`${row.id}: no issue.json and an arms run never generates the front half`);
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
          await runRow(o, { front: client, arms: armCtxs, graders, seed, reuse: !!reuseManifest }, row, issues, res, rowDir(row), log);
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
    client: armRuns ? 'arms' : o.client!.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    k: o.k,
    aborted,
    ...(armRuns ? armsMeta(o, armRuns, rows, seed, meter!, reuseManifest!) : {}),
    budget: { expected: o.tracker.expected, hardStop: o.tracker.hardStop, used: o.tracker.used, byRole: o.tracker.byRole() },
  };
  writeJson(path.join(runDir, 'run.json'), { meta, ledger: o.tracker.ledger, rows });
  const reportPath = path.join(runDir, 'report.md');
  fs.writeFileSync(reportPath, buildReport(meta, o.corpus, rows, computeMetrics(rows, meta, loadHumanAnswers(runDir))));
  return { rows, meta, reportPath };
}

function armsMeta(o: RunOptions, armRuns: ArmRun[], rows: RowResult[], seed: string, meter: DollarMeter, manifest: ReturnType<typeof reuseFrontHalf>): Partial<RunMeta> {
  const reported: Record<string, string> = {};
  const unreported: string[] = [];
  for (const a of armRuns) {
    const fromInit = rows.flatMap((r) => r.candidates).find((c) => c.arm?.arm === a.spec.id && c.arm.modelFromInit);
    if (fromInit) reported[a.spec.id] = fromInit.arm!.model;
    else unreported.push(a.spec.id); // the init event carried no model: results carry the requested one, flagged here
  }
  return {
    arms: armRuns.map((a) => ({ id: a.spec.id, model: a.spec.model, effort: a.spec.effort, cliAlias: a.spec.model, family: a.spec.family })),
    cliVersion: armRuns[0].cliVersion,
    seed,
    candidateMaxCalls: { value: o.candidateMaxCalls ?? 40, default: 40, deliberateChange: (o.candidateMaxCalls ?? 40) !== 40 },
    reportedModels: reported,
    modelNotReported: unreported,
    dollar: { capUsd: meter.capUsd, chargedUsd: meter.chargedUsd, estimatedUsd: meter.estimatedUsd },
    harness: o.harness,
    reuse: { from: o.reuseFrom!, manifest: sha256(JSON.stringify(manifest)) },
  };
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

interface RowCtx {
  /** Client for the front half (issue, spec, leakage-1): single-client runs only. */
  front: BudgetedClient | null;
  arms: ArmCtx[];
  graders: GraderCtx[];
  seed: string;
  /** The front half was copied from an earlier run: re-validate the spec at HEAD before any candidate call. */
  reuse: boolean;
}

async function runRow(o: RunOptions, ctx: RowCtx, row: CorpusRow, issues: Map<string, IssueFile>, res: RowResult, dir: string, log: (s: string) => void): Promise<void> {
  const client = ctx.front;
  const armsMode = !!o.arms;
  if (armsMode) res.perArm = Object.fromEntries(ctx.arms.map((a) => [a.id!, { blocked: [], graderCalls: 0, leakageHistory: null } as ArmRowState]));
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
    if (fs.existsSync(specFile)) {
      parsed = parseSpec(readJson(specFile));
      if (ctx.reuse) {
        // Reused spec: validators and the reference acceptance run again at HEAD (no model) before any candidate call is spent.
        const v = await validateSpec(readJson(specFile), deps.repo, runOnBase);
        if (!v.result.ok || !v.parsed) throw new Error(`reused spec fails validators at HEAD: ${v.result.errors.join('; ')}`);
        const x = await onReference(v.parsed);
        if (x.errors.length) throw new Error(`reused spec fails the reference acceptance at HEAD: ${x.errors.join('; ')}`);
        parsed = v.parsed;
      }
    } else {
      if (!client) throw new Error(`${row.id}: no spec.json and an arms run never generates the front half`);
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
    // Leakage-1 is not resumable and its pairing depends on the row set: once a result is stored (or reused from an earlier run) it is read back, not paid for again.
    const leakFile = path.join(dir, 'leakage1.json');
    if (fs.existsSync(leakFile)) leak.wrongIssue = readJson<{ wrongIssue: LeakageResult['wrongIssue'] }>(leakFile).wrongIssue;
    else if (wrongRow && issues.has(wrongRow.id)) {
      if (!client) throw new Error(`${row.id}: no leakage1.json and an arms run never runs the front half`);
      const w = await generateSpec({ client, row, issueText: issues.get(wrongRow.id)!.text, baseDir: deps.repo, agentCwd: specAgent.repo, validate: false, runOnBase, role: 'leakage' });
      if (w.parsed) {
        const v = wrongIssueVerdict(parsed, w.parsed);
        leak.wrongIssue = { ran: true, similarity: v.similarity, passed: v.passed, detail: v.detail };
      } else leak.wrongIssue = { ran: true, similarity: null, passed: null, detail: 'wrong-issue spec did not parse' };
      writeJson(leakFile, { wrongIssue: leak.wrongIssue });
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

    // ---- candidate arms: for each k every arm, in a seeded order (arms mode) or the single client (legacy)
    const refDiff = fs.readFileSync(patchFile, 'utf8');
    const cdir = path.join(dir, 'candidates');
    const candFile = (arm: string | null, k: number) => (arm ? path.join(cdir, arm, `c${k}.json`) : path.join(cdir, `c${k}.json`));
    const patchPath = (arm: string | null, k: number) => (arm ? path.join(cdir, arm, `c${k}.patch`) : path.join(cdir, `c${k}.patch`));
    const armIds = ctx.arms.map((a) => a.id);
    for (let k = 1; k <= o.k; k++) {
      const order = armsMode ? seededOrder(ctx.seed, row.id, k, armIds as string[]).map((id) => ctx.arms.find((a) => a.id === id)!) : ctx.arms;
      for (const arm of order) {
        const cfile = candFile(arm.id, k);
        if (fs.existsSync(cfile)) {
          res.candidates.push(readJson<CandidateResult>(cfile));
          continue;
        }
        const tag = arm.id ? `${row.id}-${arm.id}-c${k}` : `${row.id}-c${k}`;
        // Private root: only the single-commit scratch repo, its worktree and its scratch origin. No deps, no references.
        const croot = agentRootDir();
        agentRoots.push(croot);
        const scratch = await createScratchRepo(o.repo, row.base, croot, row.scrubDocs);
        const wt = path.join(croot, 'wt');
        const branch = `work/${tag}`;
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
        const hist = { passed: h.passed && reach.passed, detail: [...h.detail, ...reach.detail] };
        leak.history = { passed: (leak.history?.passed ?? true) && hist.passed, detail: [...(leak.history?.detail ?? []), ...hist.detail] };
        if (arm.id) {
          const st = res.perArm![arm.id];
          st.leakageHistory = { passed: (st.leakageHistory?.passed ?? true) && hist.passed, detail: [...(st.leakageHistory?.detail ?? []), ...hist.detail] };
        }
        if (!hist.passed) {
          const note = `leakage test 3 failed: ${hist.detail.join(' | ')}`;
          if (!arm.id) {
            res.status = 'leak-blocked';
            res.note = note;
            return;
          }
          // Arms run: this arm/k is dropped, the row and the other arms go on.
          res.perArm![arm.id].blocked.push({ k, note });
          log(`${row.id} ${arm.id} c${k}: leak-blocked (${note})`);
          if (!o.keepWork) fs.rmSync(croot, { recursive: true, force: true });
          continue;
        }
        const prompt = candidatePrompt(issueText, specJson, accFiles, { bash: !!o.allowBash });
        const cr: CandidateResult = { k, stopReason: 'error', cost: { calls: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: 0, durationMs: 0 }, commit: null, changedFiles: [], report: null, clearsAllRungs: false, testAgreement: { total: 0, agree: 0 }, probeAgreement: null, label: null, labelSource: null, deterministicRegression: false };
        if (arm.run) {
          cr.arm = armIdent(arm.run.spec, arm.run.cliVersion);
          cr.promptHash = sha256(prompt);
        }
        let reported: string | undefined;
        try {
          const run = await arm.client.run({ role: 'candidate', rowId: row.id, prompt, tools: 'agent', cwd: wt, ...(o.allowBash ? { bashBox: { agentRoot: croot, cwd: wt, tmpDir: agentTmp } } : {}), maxCalls: o.candidateMaxCalls ?? 40, timeoutMs: o.candidateTimeoutMs ?? 30 * 60_000 });
          cr.cost = cost(run);
          cr.stopReason = run.stopReason;
          reported = run.model;
          if (arm.run) cr.arm = armIdent(arm.run.spec, arm.run.cliVersion, run.model);
        } catch (e) {
          if (e instanceof BudgetExceeded) {
            // Always-pushed invariant: whatever the agent left is committed and pushed to scratch before aborting.
            await commitAndPush(wt, branch, `scratch: ${tag} (aborted)`).catch(() => {});
            throw e;
          }
          cr.error = e instanceof Error ? e.message : String(e);
        }
        // Refuse a resume that now sees another model for this arm (checked outside the try: it must not become a candidate error).
        const earlier = res.candidates.find((c) => c.arm?.arm === arm.id && c.arm.modelFromInit);
        if (reported && earlier && earlier.arm!.model !== reported) throw new Error(`arm ${arm.id} reported model ${reported}, but an earlier candidate of this run reported ${earlier.arm!.model}: results of two models are never mixed`);
        cr.commit = await commitAndPush(wt, branch, `candidate ${tag}`);
        cr.changedFiles = (await git(wt, ['diff', '--name-only', 'main', 'HEAD'])).split('\n').filter((f) => f && !f.startsWith(ACCEPTANCE_DIR));
        const patch = await git(wt, ['diff', 'main', 'HEAD', '--', '.', `:!${ACCEPTANCE_DIR}`]);
        fs.mkdirSync(path.dirname(patchPath(arm.id, k)), { recursive: true });
        fs.writeFileSync(patchPath(arm.id, k), patch);
        // Evaluate a clone of the pushed scratch branch under the harness root, with the base's own installed deps.
        const evalDir = arm.id ? path.join(work, arm.id, `c${k}`) : path.join(work, `eval-${k}`);
        await git(work, ['clone', '-q', '--no-hardlinks', '-b', `scratch/${tag}`, scratch.origin, evalDir]);
        fs.appendFileSync(path.join(evalDir, '.git', 'info', 'exclude'), 'node_modules\n.vitest-cache\ntest-results\n');
        linkDeps(deps.repo, evalDir);
        // The clone is self-contained: delete the agent's root now, so no later agent (another arm, a later k) can find it next to the harness dirs.
        if (!o.keepWork) {
          fs.rmSync(croot, { recursive: true, force: true });
          agentRoots.splice(agentRoots.indexOf(croot), 1);
        }
        cr.report = await evaluateCheckout({ dir: evalDir, ...evalArgs });
        cr.testAgreement = testAgreement(cr.report, refReport);
        cr.probeAgreement = cr.report.probe.length && refReport.probe.length ? compareRecords(cr.report.probe, refReport.probe, parsed.surface) : null;
        const det = labelDeterministically(cr.report, refReport, parsed.surface, cr.report.probe, refReport.probe);
        cr.clearsAllRungs = det.clearsAllRungs;
        cr.deterministicRegression = det.deterministicRegression;
        cr.label = det.label;
        cr.labelSource = det.label ? 'deterministic' : null;
        cr.rationale = det.why;
        res.candidates.push(cr);
        writeJson(cfile, cr);
        log(`${tag}: ${cr.label ?? 'residue'} (${cr.cost.calls} calls, rungs ${cr.clearsAllRungs ? 'cleared' : 'not cleared'})`);
      }
    }

    // ---- model-judged residue, a separate pass over every arm's candidates (rebuilt from stored results, so a resume covers
    // all of them). Each residue item is graded by every grader; the grader prompt never names the arm. A single-client run
    // grades at most 3 items per row, as before.
    const pool = res.candidates.filter((c) => c.label === null && c.report).sort((a, b) => a.k - b.k || (a.arm?.arm ?? '').localeCompare(b.arm?.arm ?? ''));
    for (const c of armsMode ? pool : pool.slice(0, 3)) {
      const arm = c.arm?.arm ?? null;
      const facts = [(c.rationale ?? '').split('; grader reply unusable')[0], `held-out failures: ${Object.entries(refReport.heldOut.outcomes).filter(([key, st]) => st === 'passed' && c.report!.heldOut.outcomes[key] !== 'passed').map(([key]) => key).join('; ') || 'none'}`];
      const patch = fs.readFileSync(patchPath(arm, c.k), 'utf8');
      for (const g of ctx.graders) {
        const tag = g.tag(c);
        if (gradesOf(c).some((x) => x.tag.grader === tag.grader)) continue;
        const gr = await g.client.run({ role: 'grade', rowId: row.id, prompt: gradePrompt({ issueText, specJson, candidateDiff: patch, referenceDiff: refDiff, facts }), tools: 'none', maxCalls: GRADE_MAX_CALLS, timeoutMs: 5 * 60_000 });
        res.graderCalls += gr.calls;
        if (arm) res.perArm![arm].graderCalls += gr.calls;
        try {
          const v = parseGrade(gr.text);
          (c.grades ??= []).push({ tag, label: v.label, rationale: v.rationale } satisfies Grade);
        } catch (e) {
          c.rationale = `${c.rationale}; grader reply unusable (${tag.grader}): ${e instanceof Error ? e.message : e}`;
        }
        writeJson(candFile(arm, c.k), c);
      }
    }
    res.status = 'complete';
  } finally {
    if (!o.keepWork) for (const r of agentRoots) fs.rmSync(r, { recursive: true, force: true });
  }
}

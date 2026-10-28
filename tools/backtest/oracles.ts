// Local oracles: the repo's own tests, tsc, spec acceptance, held-out tests from the real change, probe replay.
// No platform gate is used (it is simulated, docs/SPEC-BACKTEST-PLAN.md section 0).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec, type ExecResult } from './exec.ts';
import { boxExec, requireSandbox } from './sandbox.ts';
import { existsAt, git, isTestFile, showAt } from './git.ts';
import { installProbe, PROBE_ENV, readMalformed, readProbe } from './probe.ts';
import { ACCEPTANCE_DIR, removeAcceptance, writeAcceptance, type ParsedSpec, type SpecFile, type TestOutcome } from './spec.ts';
import { checkContract, checkDelta, type DeltaSurface, type ResponseRecord } from './delta.ts';

export interface OracleConfig {
  /** Command prefix; files are appended. */
  testCommand: string[];
  /** Null disables the tsc rung (fixtures). */
  tscCommand: string[] | null;
  testTimeoutMs: number;
  tscTimeoutMs: number;
  /** Installs the dependencies of a base checkout (root and cli/). Null = nothing to install (fixtures). */
  installDeps: ((dir: string) => Promise<void>) | null;
  /** Runs per suite when something fails (flake detection): red = failed in every run, flaky = in some. */
  baseAttempts: number;
  evalAttempts: number;
  /**
   * 'unshare': every oracle subprocess runs in the OS sandbox (no network, no view of the real filesystem, scrubbed env,
   * private HOME) and the harness refuses to run if the sandbox is unavailable. 'off' is only for trusted code (the base
   * commit's own tests in `check --base-green`) and for tests that explicitly opt out.
   */
  sandbox: 'unshare' | 'off';
}

/** `npm ci` where a lockfile exists, `npm install` where not, in the root and in cli/. Never HEAD's node_modules. */
export async function npmInstall(dir: string): Promise<void> {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k];
  for (const d of [dir, path.join(dir, 'cli')]) {
    if (!fs.existsSync(path.join(d, 'package.json'))) continue;
    const verb = fs.existsSync(path.join(d, 'package-lock.json')) ? 'ci' : 'install';
    const r = await exec('npm', [verb, '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: d, env, timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new Error(`npm ${verb} failed in ${path.relative(dir, d) || '.'}: ${r.stderr.trim().slice(-300)}`);
  }
}

/** Link the installed dependencies of one checkout into another (symlinks stay outside any candidate-visible tree). */
export function linkDeps(from: string, to: string): void {
  for (const rel of ['node_modules', 'cli/node_modules']) {
    const src = path.join(from, rel);
    const dest = path.join(to, rel);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(src, dest, 'dir');
    }
  }
}

export const DEFAULT_ORACLE_CONFIG: OracleConfig = {
  testCommand: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--exclude', 'tests/e2e/**'],
  tscCommand: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'],
  testTimeoutMs: 15 * 60_000,
  tscTimeoutMs: 10 * 60_000,
  installDeps: npmInstall,
  baseAttempts: 3,
  evalAttempts: 2,
  sandbox: 'unshare',
};

/** Minimal env for test subprocesses: no tokens, no CI flag (the root vitest config retries under CI). */
export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[k]) out[k] = process.env[k];
  return { ...out, ...extra };
}

/** Read-only binds for dependency trees reached through symlinks (node_modules is installed outside the evaluation root). */
export function depsRo(cwd: string): string[] {
  const out: string[] = [];
  for (const rel of ['node_modules', 'cli/node_modules']) {
    const p = path.join(cwd, rel);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) {
        // The symlink's first-hop target must exist inside the box (it may itself be a symlink), backed by the final real dir.
        const hop = path.resolve(path.dirname(p), fs.readlinkSync(p));
        out.push(`${hop}=${fs.realpathSync(p)}`);
      }
    } catch {
      /* absent */
    }
  }
  return out;
}

/** Run a command in cwd: sandboxed when cfg.sandbox is 'unshare' (refusing if unavailable), else directly. */
export async function runIn(cwd: string, cfg: OracleConfig, cmd: string, args: string[], opts: { env: Record<string, string>; timeoutMs: number; extraRw?: string[] }): Promise<ExecResult> {
  if (cfg.sandbox === 'unshare') {
    await requireSandbox();
    const rw = [cwd, ...(opts.extraRw ?? []), ...Object.values(opts.env).filter((v) => path.isAbsolute(v)).map((v) => path.dirname(v))];
    return boxExec(cmd, args, { cwd, rw: [...new Set(rw)], ro: depsRo(cwd) }, { timeoutMs: opts.timeoutMs, env: opts.env });
  }
  return exec(cmd, args, { cwd, env: testEnv(opts.env), timeoutMs: opts.timeoutMs });
}

export interface VitestRun {
  outcomes: TestOutcome[];
  loadErrors: string[];
  timedOut: boolean;
  /** Process exited without producing a JSON report. */
  crashed: boolean;
}

export async function runVitest(cwd: string, cfg: OracleConfig, files: string[] = [], env: Record<string, string> = {}): Promise<VitestRun> {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-vt-'));
  const out = path.join(reportDir, 'report.json');
  const [cmd, ...pre] = cfg.testCommand;
  // The base commit's own vitest `include` may not cover the files we need (A1's base only includes tests/**).
  // For explicit files, run through a derived config that adds them to the base config's include.
  const derived = path.join(cwd, 'vitest.backtest.config.ts');
  const extra: string[] = [];
  if (files.length) {
    fs.writeFileSync(derived, `import { mergeConfig } from 'vitest/config';\nimport base from './vitest.config';\nexport default mergeConfig(base, { test: { include: ${JSON.stringify(files)} } });\n`);
    extra.push('--config', 'vitest.backtest.config.ts');
  }
  const r = await runIn(cwd, cfg, cmd, [...pre, ...extra, '--reporter=json', `--outputFile.json=${out}`, ...files], { env, timeoutMs: cfg.testTimeoutMs, extraRw: [reportDir] });
  fs.rmSync(derived, { force: true });
  const run: VitestRun = { outcomes: [], loadErrors: [], timedOut: r.timedOut, crashed: false };
  if (!fs.existsSync(out)) {
    run.crashed = true;
    run.loadErrors.push(`no report (exit ${r.code}): ${r.stderr.trim().slice(-300)}`);
    return run;
  }
  const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  for (const f of rep.testResults ?? []) {
    const file = path.relative(cwd, f.name).split(path.sep).join('/');
    const results = f.assertionResults ?? [];
    if (results.length === 0 && f.status === 'failed') run.loadErrors.push(`${file}: ${String(f.message ?? '').slice(0, 200)}`);
    for (const a of results) {
      const message = a.status === 'failed' ? String((a.failureMessages ?? [])[0] ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 400) : undefined;
      run.outcomes.push({ file, name: stableName(a.fullName ?? a.title), status: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped', ...(message ? { message } : {}) });
    }
  }
  return run;
}

export interface StableRun extends VitestRun {
  /** Tests that failed in some runs and passed in others: reported, never counted as red or as a regression. */
  flaky: string[];
}

/** Run, and when anything fails rerun the failing files up to `attempts` times. Red = failed in every run. */
export async function stableRun(cwd: string, cfg: OracleConfig, attempts: number, files: string[] = [], env: Record<string, string> = {}): Promise<StableRun> {
  const first = await runVitest(cwd, cfg, files, env);
  const failedKeys = (r: VitestRun) => new Set(r.outcomes.filter((o) => o.status === 'failed').map((o) => `${o.file}::${o.name}`));
  const stillFailing = failedKeys(first);
  const everFailed = new Set(stillFailing);
  let last = first;
  for (let i = 1; i < attempts && stillFailing.size > 0; i++) {
    const refiles = [...new Set([...stillFailing].map((k) => k.split('::')[0]))];
    last = await runVitest(cwd, cfg, refiles, env);
    const ran = new Set(last.outcomes.map((o) => `${o.file}::${o.name}`));
    const nowFailed = failedKeys(last);
    for (const k of [...stillFailing]) if (ran.has(k) && !nowFailed.has(k)) stillFailing.delete(k);
  }
  const flaky = [...everFailed].filter((k) => !stillFailing.has(k));
  const flakySet = new Set(flaky);
  const outcomes = first.outcomes.map((o) => (flakySet.has(`${o.file}::${o.name}`) ? { ...o, status: 'skipped' as const } : o));
  return { ...first, outcomes, flaky, loadErrors: last === first ? first.loadErrors : [...new Set([...first.loadErrors, ...last.loadErrors])] };
}

export async function runTsc(cwd: string, cfg: OracleConfig): Promise<{ errors: number; sample: string[] } | null> {
  if (!cfg.tscCommand) return null;
  const [cmd, ...args] = cfg.tscCommand;
  const r = await runIn(cwd, cfg, cmd, args, { env: {}, timeoutMs: cfg.tscTimeoutMs });
  const lines = r.stdout.split('\n').filter((l) => /error TS\d+/.test(l));
  return { errors: r.timedOut ? Number.MAX_SAFE_INTEGER : lines.length, sample: lines.slice(0, 5) };
}

/** Test identity across runs: random ids in titles (it.each over randomUUID) are normalised, or the same test looks "missing". */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const stableName = (name: string) => name.replace(UUID, '<uuid>');
const key = (o: TestOutcome) => `${o.file}::${stableName(o.name)}`;

export interface HeldOut {
  /** Test files of the real change at the change commit: path -> content. Harness-only, never inside a mountable path. */
  files: Record<string, string>;
  /** Those of them that already exist at the base (run there once to find tests that are red before the change). */
  existingAtBase: string[];
}

export async function loadHeldOut(repo: string, sha: string, base: string, testFiles: string[]): Promise<HeldOut> {
  const files: Record<string, string> = {};
  for (const f of testFiles.filter(isTestFile)) {
    // *.test-d.ts is type-level (covered by tsc); tests/e2e needs live workers and is never run by the harness.
    if (!/\.test\.ts$/.test(f) || f.startsWith('tests/e2e/')) continue;
    files[f] = await showAt(repo, sha, f);
  }
  const existingAtBase: string[] = [];
  for (const f of Object.keys(files)) if (await existsAt(repo, base, f)) existingAtBase.push(f);
  return { files, existingAtBase };
}

export interface OracleReport {
  /** Tests (all files except acceptance) failing here that are not already red at the base. */
  failedRepoTests: string[];
  /** Tests that passed on base and fail here. */
  regressions: string[];
  /** Tests that passed on base and are absent here. */
  missingTests: string[];
  acceptance: { total: number; passed: number; failed: string[] };
  heldOut: { total: number; outcomes: Record<string, TestOutcome['status']> };
  tsc: { errors: number; baseErrors: number } | null;
  loadErrors: string[];
  /** record() misuse in the acceptance tests (never silently ignored). */
  probeProblems: string[];
  /** First failure message per failing acceptance or held-out test (human evidence; never fed to a model). */
  failureMessages: Record<string, string>;
  probe: ResponseRecord[];
  rungs: { preMerge: boolean; conformance: boolean | null; shadow: boolean | null };
  conformanceViolations: string[];
  shadowViolations: string[];
}

export interface BaselineReport {
  outcomes: TestOutcome[];
  /** Held-out tests (base versions of the files) that already fail at the base: not the candidate's fault. */
  heldOutRed: string[];
  loadErrors: string[];
  tscErrors: number | null;
  probe: ResponseRecord[];
}

async function resetTree(dir: string): Promise<void> {
  await git(dir, ['reset', '-q', '--hard']);
  await git(dir, ['clean', '-fdq']);
}

/** Run acceptance + repo tests with probe capture in `dir` (must be a clean committed checkout). */
async function fullRun(dir: string, cfg: OracleConfig, spec: SpecFile | null, attempts: number): Promise<{ run: StableRun; probe: ResponseRecord[]; malformed: string[] }> {
  installProbe(dir);
  if (spec) writeAcceptance(dir, spec);
  const probeOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-probe-')), 'probe.jsonl');
  const run = await stableRun(dir, cfg, attempts, [], { [PROBE_ENV]: probeOut });
  const probe = readProbe(probeOut);
  const malformed = readMalformed(probeOut);
  fs.rmSync(path.dirname(probeOut), { recursive: true, force: true });
  return { run, probe, malformed };
}

/** Baseline on the base checkout: which tests pass there, base tsc errors, base probe responses. */
export async function baselineReport(baseDir: string, cfg: OracleConfig, spec: SpecFile, heldOut: HeldOut): Promise<BaselineReport> {
  const { run, probe } = await fullRun(baseDir, cfg, spec, cfg.baseAttempts);
  const tsc = await runTsc(baseDir, cfg);
  await resetTree(baseDir);
  const held = heldOut.existingAtBase.length ? await stableRun(baseDir, cfg, cfg.baseAttempts, heldOut.existingAtBase) : null;
  await resetTree(baseDir);
  return { outcomes: run.outcomes, loadErrors: run.loadErrors, heldOutRed: (held?.outcomes ?? []).filter((o) => o.status === 'failed').map(key), tscErrors: tsc?.errors ?? null, probe };
}

/**
 * Evaluate a committed checkout (candidate or reference) against the ladder. Leaves the tree reset to HEAD.
 * Order: pre-merge (repo tests + acceptance + tsc), conformance, shadow substitute; then held-out tests.
 */
export async function evaluateCheckout(opts: {
  dir: string;
  cfg: OracleConfig;
  spec: SpecFile;
  contract: { endpoints: { method: string; path: string; responses: { status: number }[] }[] };
  surface: DeltaSurface;
  baseline: BaselineReport;
  heldOut: HeldOut;
}): Promise<OracleReport> {
  const { dir, cfg, spec, baseline } = opts;
  const { run, probe, malformed } = await fullRun(dir, cfg, spec, cfg.evalAttempts);
  const tsc = await runTsc(dir, cfg);
  await resetTree(dir);

  const isAcceptance = (o: TestOutcome) => o.file.startsWith(`${ACCEPTANCE_DIR}/`);
  const repoOut = run.outcomes.filter((o) => !isAcceptance(o));
  const accOut = run.outcomes.filter(isAcceptance);
  const basePassed = new Set(baseline.outcomes.filter((o) => !isAcceptance(o) && o.status === 'passed').map(key));
  const nowByKey = new Map(repoOut.map((o) => [key(o), o]));
  const regressions = [...basePassed].filter((k) => nowByKey.get(k)?.status === 'failed');
  const missingTests = [...basePassed].filter((k) => !nowByKey.has(k));
  const baseRed = new Set(baseline.outcomes.filter((o) => !isAcceptance(o) && o.status === 'failed').map(key));
  const failedRepoTests = repoOut.filter((o) => o.status === 'failed' && !baseRed.has(key(o))).map(key);
  const acceptance = {
    total: accOut.length,
    passed: accOut.filter((o) => o.status === 'passed').length,
    failed: accOut.filter((o) => o.status !== 'passed').map(key),
  };
  const tscReport = tsc && baseline.tscErrors !== null ? { errors: tsc.errors, baseErrors: baseline.tscErrors } : null;
  const newLoadErrors = run.loadErrors.filter((e) => !baseline.loadErrors.includes(e));
  const loadErrors = [...newLoadErrors];

  // Held-out tests overlay (after the main run; reset again afterwards).
  const heldFiles = Object.keys(opts.heldOut.files);
  const heldOutcomes: Record<string, TestOutcome['status']> = {};
  const heldMessages: Record<string, string> = {};
  if (heldFiles.length) {
    for (const [f, content] of Object.entries(opts.heldOut.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), content);
    }
    const h = await stableRun(dir, cfg, cfg.evalAttempts, heldFiles);
    for (const o of h.outcomes) {
      heldOutcomes[key(o)] = o.status;
      if (o.status === 'failed' && o.message) heldMessages[key(o)] = o.message;
    }
    for (const e of h.loadErrors) {
      loadErrors.push(`held-out: ${e}`);
      heldOutcomes[`${e.split(':')[0]}::<load>`] = 'failed';
    }
    await resetTree(dir);
  }

  const failureMessages: Record<string, string> = {};
  for (const x of run.outcomes) if (x.status === 'failed' && x.message && isAcceptance(x)) failureMessages[key(x)] = x.message;
  const preMerge =
    !run.crashed && !run.timedOut && failedRepoTests.length === 0 && newLoadErrors.length === 0 &&
    acceptance.total > 0 && acceptance.passed === acceptance.total &&
    (tscReport === null || tscReport.errors <= tscReport.baseErrors);

  let conformance: boolean | null = null;
  let conformanceViolations: string[] = [];
  if (opts.contract.endpoints.length && probe.length) {
    const c = checkContract(opts.contract.endpoints, probe);
    conformanceViolations = c.violations;
    conformance = c.checked > 0 ? c.violations.length === 0 : null;
  }
  let shadow: boolean | null = null;
  let shadowViolations: string[] = [];
  if (baseline.probe.length && probe.length) {
    const d = checkDelta(baseline.probe, probe, opts.surface);
    shadowViolations = d.violations.map((v) => `${v.label}: ${v.kind} ${v.detail}`);
    shadow = d.ok;
  }

  return {
    failedRepoTests,
    regressions,
    missingTests,
    acceptance,
    heldOut: { total: Object.keys(heldOutcomes).length, outcomes: heldOutcomes },
    tsc: tscReport,
    loadErrors,
    probeProblems: malformed,
    failureMessages: { ...failureMessages, ...heldMessages },
    probe,
    rungs: { preMerge, conformance, shadow },
    conformanceViolations,
    shadowViolations,
  };
}

/** Run only the given acceptance files on a clean checkout (spec validator: each case must fail on base). The probe is
 *  switched on so record() misuse surfaces now, before any candidate runs. */
export async function runAcceptanceOn(dir: string, cfg: OracleConfig, files: string[]): Promise<{ outcomes: TestOutcome[]; loadErrors: string[]; malformed: string[]; probe: ResponseRecord[] }> {
  installProbe(dir);
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-accprobe-'));
  const probeOut = path.join(probeDir, 'probe.jsonl');
  try {
    const r = await runVitest(dir, cfg, files, { [PROBE_ENV]: probeOut });
    return { outcomes: r.outcomes, loadErrors: r.loadErrors, malformed: readMalformed(probeOut), probe: readProbe(probeOut) };
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

export interface ReferenceCheck {
  total: number;
  failing: { name: string; message?: string }[];
  loadErrors: string[];
  malformed: string[];
  /** The spec's own contract disagrees with what the reference answered (label + detail; detail is human-only). */
  contractViolations: { label: string; detail: string }[];
  /** The spec's declared delta surface does not cover the change the reference makes (label, kind; detail is human-only). */
  deltaViolations: { label: string; kind: string; detail: string }[];
}

/**
 * Spec validator against the REFERENCE: every acceptance case must pass on the real merged change, and the reference's
 * recorded responses must satisfy the spec's own contract and declared delta surface (compared with base), or the spec is
 * wrong (wrong layer, over-specified, a pseudo-route, a surface that omits the real change). Run before any candidate call
 * is spent. The oracle is not weakened: a failing reference is a spec failure.
 */
export async function acceptanceAgainstReference(refDir: string, baseDir: string, cfg: OracleConfig, parsed: ParsedSpec): Promise<ReferenceCheck> {
  const files = writeAcceptance(refDir, parsed.spec);
  installProbe(refDir);
  try {
    const r = await runAcceptanceOn(refDir, cfg, files);
    const out: ReferenceCheck = { total: r.outcomes.length, failing: r.outcomes.filter((o) => o.status !== 'passed').map((o) => ({ name: `${o.file}::${o.name}`, message: o.message })), loadErrors: r.loadErrors, malformed: r.malformed, contractViolations: [], deltaViolations: [] };
    if (out.failing.length === 0 && out.loadErrors.length === 0 && r.probe.length > 0) {
      for (const v of checkContract(parsed.contract.endpoints, r.probe).violations) out.contractViolations.push({ label: v.split(':')[0], detail: v });
      writeAcceptance(baseDir, parsed.spec);
      installProbe(baseDir);
      try {
        const b = await runAcceptanceOn(baseDir, cfg, files);
        if (b.probe.length) for (const v of checkDelta(b.probe, r.probe, parsed.surface).violations) out.deltaViolations.push({ label: v.label, kind: v.kind, detail: v.detail });
      } finally {
        await resetTree(baseDir);
      }
    }
    return out;
  } finally {
    await resetTree(refDir);
  }
}

export { removeAcceptance };

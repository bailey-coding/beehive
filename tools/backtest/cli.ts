// Backtest harness CLI. Run with: node --experimental-strip-types tools/backtest/cli.ts <command>
// Commands: freeze | check | pilot | smoke. Nothing here touches workers/, production, wrangler or the cf remote.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetTracker, BudgetedClient, EXPECTED_CALLS, HARD_STOP_CALLS } from './budget.ts';
import { baseGreen } from './basegreen.ts';
import { ClaudeCliClient } from './client.ts';
import { createPrivateConfig } from './claudeconfig.ts';
import { proveBashSandbox } from './bashsandbox.ts';
import { runCanary } from './canary.ts';
import { checkIndependence, freezeCorpus, loadCorpus } from './corpus.ts';
import { docAtBaseTest } from './leakage.ts';
import { DEFAULT_ORACLE_CONFIG } from './oracles.ts';
import { PILOT_ROWS } from './pilot-rows.ts';
import { runPilot } from './run.ts';
import { diffOf, git } from './git.ts';
import { DEFAULT_SEED, HumanAnswersSchema, loadHumanAnswers, modelJudged, parseAnswers, pickCases, renderSample } from './sample.ts';
import { sanitizeReport } from './publish.ts';
import { buildReport } from './report.ts';
import { computeMetrics } from './metrics.ts';
import type { RowResult, RunMeta } from './results.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(here, '..', '..');
/** Single global ledger: no flag to relocate it, so a new --run name cannot reset the 850 cap. */
export const LEDGER_FILE = path.join(here, '.ledger.json');

function flags(argv: string[]): { cmd: string; f: Record<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const f: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) f[rest[i].slice(2)] = true;
    else {
      f[rest[i].slice(2)] = next;
      i++;
    }
  }
  return { cmd, f };
}

const ALLOWED: Record<string, string[]> = {
  freeze: ['force', 'corpus'],
  check: ['base-green', 'write', 'corpus'],
  smoke: ['release-pilot'],
  canary: ['release-pilot', 'allow-bash'],
  pilot: ['release-pilot', 'run', 'k', 'rows', 'out', 'work', 'keep-work', 'allow-bash', 'expected', 'hard-stop', 'corpus'],
  sample: ['run', 'n', 'seed', 'out', 'ingest', 'template-out', 'corpus'],
  publish: ['run', 'name', 'out'],
  help: [],
};

export function validateFlags(cmd: string, f: Record<string, string | true>): void {
  const ok = ALLOWED[cmd] ?? [];
  for (const k of Object.keys(f)) if (!ok.includes(k)) throw new Error(`unknown flag --${k} for '${cmd}'`);
  if (f['hard-stop'] !== undefined && !(Number(f['hard-stop']) >= 1 && Number(f['hard-stop']) <= HARD_STOP_CALLS)) throw new Error(`--hard-stop must be between 1 and ${HARD_STOP_CALLS} (the plan's cap)`);
}

async function main(): Promise<void> {
  const { cmd, f } = flags(process.argv.slice(2));
  validateFlags(cmd, f);
  const repo = (await git(harnessRoot, ['rev-parse', '--show-toplevel'])).trim();
  const corpusFile = String(f.corpus ?? path.join(repo, 'docs/backtest/corpus.json'));
  const log = (s: string) => console.log(s);

  if (cmd === 'freeze') {
    if (fs.existsSync(corpusFile) && !f.force) throw new Error(`${corpusFile} exists: the corpus is frozen (no swaps). Use --force only before any model run.`);
    fs.mkdirSync(path.dirname(corpusFile), { recursive: true });
    const c = await freezeCorpus(repo, PILOT_ROWS, corpusFile);
    log(`froze ${c.rows.length} rows to ${corpusFile}`);
    return;
  }

  if (cmd === 'check') {
    // No model cost: independence (filter 4), doc-at-base and key-term leakage test 4, optional base-green is `npm test` at each base by hand.
    const c = await loadCorpus(corpusFile, repo);
    const ind = await checkIndependence(repo, c.rows);
    log(ind.length ? `independence: FAIL\n${ind.join('\n')}` : 'independence: ok');
    for (const row of c.rows) {
      const t = await docAtBaseTest(repo, row);
      log(`${row.id} doc-at-base: ${t.passed ? 'ok' : 'FAIL'}${t.detail.map((d) => `\n  - ${d}`).join('')}`);
    }
    if (f['base-green']) {
      // Plan step 1, with the base's own dependencies installed (root and cli/); network use is the harness's npm, not an agent's.
      for (const row of c.rows) {
        const g = await baseGreen(repo, row, DEFAULT_ORACLE_CONFIG);
        row.baseGreen = g;
        log(`${row.id} base ${row.base.slice(0, 7)}: ${g.tests} tests, ${g.red.length} red, ${g.flaky.length} flaky, ${g.loadErrors.length} load error(s) => ${g.verdict.toUpperCase()}${g.red.slice(0, 5).map((x) => `\n  red: ${x}`).join('')}${g.flaky.slice(0, 5).map((x) => `\n  flaky: ${x}`).join('')}`);
      }
      if (f.write) {
        fs.writeFileSync(corpusFile, JSON.stringify(c, null, 2) + '\n');
        log(`wrote base-green results to ${corpusFile}`);
      }
    }
    return;
  }

  if (cmd === 'smoke' || cmd === 'canary') {
    if (!f['release-pilot']) throw new Error(`refusing to make real calls without --release-pilot (${cmd})`);
    // Ledgered in the same global ledger as the pilot. Private config: credentials copy only, deleted at the end.
    const tracker = new BudgetTracker();
    tracker.attach(LEDGER_FILE);
    const config = createPrivateConfig();
    try {
      if (cmd === 'smoke') {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-smoke-'));
        const r = await new BudgetedClient(new ClaudeCliClient({ config }), tracker).run({ role: 'smoke', prompt: 'Create a file named hello.txt containing exactly the word ok, then reply with the single word done.', tools: 'agent', cwd: dir, maxCalls: 6, timeoutMs: 3 * 60_000 });
        const wrote = fs.existsSync(path.join(dir, 'hello.txt')) ? fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8').trim() : null;
        fs.rmSync(dir, { recursive: true, force: true });
        log(JSON.stringify({ stopReason: r.stopReason, calls: r.calls, usage: r.usage, costUsd: r.costUsd, durationMs: r.durationMs, reply: r.text.slice(0, 80), fileWritten: wrote }, null, 2));
      } else {
        // throwOnError=false: the canary inspects failures itself (including the deliberate bad-model call).
        const good = new BudgetedClient(new ClaudeCliClient({ config }), tracker, false);
        const bad = new BudgetedClient(new ClaudeCliClient({ config, model: 'claude-bogus-model-0' }), tracker, false);
        let bashClient: BudgetedClient | undefined;
        if (f['allow-bash']) {
          const proof = await proveBashSandbox();
          log(`bash sandbox probe: ${proof.ok ? 'PASS' : 'FAIL'} - ${proof.detail}`);
          bashClient = new BudgetedClient(new ClaudeCliClient({ config, allowBash: true, bash: proof, log }), tracker, false);
        }
        const { checks } = await runCanary({ client: good, badClient: bad, configDir: config.dir, bashClient });
        for (const k of checks) log(`${k.pass ? 'PASS' : 'FAIL'}  ${k.name}\n      ${k.detail}`);
        log(`global ledger: ${tracker.used}/${tracker.hardStop} calls`);
        if (checks.some((k) => !k.pass)) process.exitCode = 1;
      }
    } finally {
      config.dispose();
    }
    return;
  }

  if (cmd === 'pilot') {
    if (!f['release-pilot']) throw new Error('refusing to run the pilot without --release-pilot (the maintainer releases the spend)');
    // Fails before any spend if --allow-bash is given without an OS sandbox.
    const config = createPrivateConfig();
    let client: ClaudeCliClient;
    try {
      // --allow-bash: bwrap must be on PATH AND the model-independent isolation probe must pass, before any spend.
      const bash = f['allow-bash'] ? await proveBashSandbox() : undefined;
      if (bash) log(`bash sandbox probe: ${bash.ok ? 'PASS' : 'FAIL'} - ${bash.detail}`);
      client = new ClaudeCliClient({ config, allowBash: !!f['allow-bash'], bash, log });
    } catch (e) {
      config.dispose();
      throw e;
    }
    const rows = typeof f.rows === 'string' ? f.rows.split(',') : PILOT_ROWS.map((r) => r.id);
    const corpus = await loadCorpus(corpusFile, repo, rows);
    const runId = String(f.run ?? `pilot-${new Date().toISOString().slice(0, 10)}`);
    const tracker = new BudgetTracker(Number(f.expected ?? EXPECTED_CALLS), Number(f['hard-stop'] ?? HARD_STOP_CALLS));
    const out = await runPilot({
      corpus, repo, harnessRoot, runId,
      ledgerFile: LEDGER_FILE,
      outDir: String(f.out ?? path.join(repo, 'docs/backtest/runs')),
      workRoot: String(f.work ?? path.join(os.tmpdir(), 'beehive-backtest')),
      client, tracker, k: Number(f.k ?? 3), cfg: DEFAULT_ORACLE_CONFIG,
      issueApproval: 'required', // the maintainer reads every issue text; there is no auto-approve flag
      allowBash: !!f['allow-bash'], sandboxDetail: client.sandbox,
      keepWork: !!f['keep-work'], log,
    });
    client.dispose();
    config.dispose();
    log(`report: ${out.reportPath}\ncalls used: ${out.meta.budget.used}/${out.meta.budget.hardStop}${out.meta.aborted ? `\nABORTED: ${out.meta.aborted}` : ''}`);
    return;
  }

  if (cmd === 'sample') {
    const run = String(f.run ?? '');
    if (!run) throw new Error('--run NAME is required');
    const runDir = path.join(String(f.out ?? path.join(repo, 'docs/backtest/runs')), run);
    const seed = Number(f.seed ?? DEFAULT_SEED);
    const corpus = await loadCorpus(corpusFile, repo);
    const { cases, candidates } = modelJudged(runDir);
    const files = { runDir, rows: corpus.rows, referenceDiff: (row: (typeof corpus.rows)[number]) => diffOf(repo, row.sha) };
    if (f.ingest) {
      const mdFile = path.join(runDir, 'human-sample.md');
      const pick = JSON.parse(fs.readFileSync(path.join(runDir, 'human-sample.pick.json'), 'utf8')) as { seed: number };
      const answers = parseAnswers(fs.readFileSync(mdFile, 'utf8'), run, pick.seed);
      fs.writeFileSync(path.join(runDir, 'human-answers.json'), JSON.stringify(HumanAnswersSchema.parse(answers), null, 2) + '\n');
      const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) as { meta: RunMeta; rows: RowResult[] };
      const m = computeMetrics(saved.rows, saved.meta, loadHumanAnswers(runDir));
      fs.writeFileSync(path.join(runDir, 'report.md'), buildReport(saved.meta, corpus, saved.rows, m));
      log(`ingested ${answers.cases.length} answers; human agreement with the model labels: ${m.human?.labelAgree}/${m.human?.answered}; report.md regenerated`);
      return;
    }
    const chosen = pickCases(cases, Number(f.n ?? 2), seed);
    const md = await renderSample({ run, seed, chosen, total: cases.length, files, candidates });
    fs.writeFileSync(path.join(runDir, 'human-sample.md'), md);
    fs.writeFileSync(path.join(runDir, 'human-sample.pick.json'), JSON.stringify({ seed, picked: chosen.map((c) => `${c.rowId}-c${c.k}`), total: cases.length }, null, 2) + '\n');
    log(`wrote ${path.join(runDir, 'human-sample.md')}: ${chosen.map((c) => `${c.rowId}-c${c.k} (${c.label})`).join(', ')} of ${cases.length} model-judged cases, seed ${seed}`);
    if (f['template-out']) {
      fs.mkdirSync(path.dirname(String(f['template-out'])), { recursive: true });
      fs.writeFileSync(String(f['template-out']), await renderSample({ run, seed, chosen, total: cases.length, files, candidates, template: true }));
      log(`wrote template ${String(f['template-out'])} (no candidate source)`);
    }
    return;
  }

  if (cmd === 'publish') {
    const run = String(f.run ?? '');
    if (!run) throw new Error('--run NAME is required');
    const name = String(f.name ?? run);
    const src = path.join(String(f.out ?? path.join(repo, 'docs/backtest/runs')), run, 'report.md');
    const dest = path.join(repo, 'docs/backtest/results', `${name}.md`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, sanitizeReport(fs.readFileSync(src, 'utf8'), { name, home: os.homedir() }));
    log(`wrote ${dest}`);
    return;
  }

  log('usage: cli.ts freeze [--force] | check [--base-green [--write]] | sample --run NAME [--n 2] [--seed S] [--ingest] [--template-out FILE] | publish --run NAME [--name N] | smoke --release-pilot | canary --release-pilot [--allow-bash] | pilot --release-pilot [--run NAME] [--k 3] [--rows A1,A2] [--out DIR] [--work DIR] [--keep-work] [--allow-bash] [--hard-stop N<=850]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

// Backtest harness CLI. Run with: node --experimental-strip-types tools/backtest/cli.ts <command>
// Commands: freeze | check | pilot | smoke. Nothing here touches workers/, production, wrangler or the cf remote.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetTracker, EXPECTED_CALLS, HARD_STOP_CALLS } from './budget.ts';
import { ClaudeCliClient } from './client.ts';
import { checkIndependence, freezeCorpus, loadCorpus } from './corpus.ts';
import { docAtBaseTest } from './leakage.ts';
import { DEFAULT_ORACLE_CONFIG, runVitest } from './oracles.ts';
import { PILOT_ROWS } from './pilot-rows.ts';
import { runPilot } from './run.ts';
import { createScratchRepo, git, linkNodeModules } from './git.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(here, '..', '..');

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

async function main(): Promise<void> {
  const { cmd, f } = flags(process.argv.slice(2));
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
      // Plan step 1: the base's own test run (its own vitest include) must be green; red drops the row.
      for (const row of c.rows) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-green-'));
        const s = await createScratchRepo(repo, row.base, dir, row.scrubDocs);
        linkNodeModules(harnessRoot, s.repo);
        const v = await runVitest(s.repo, DEFAULT_ORACLE_CONFIG);
        const red = v.outcomes.filter((o) => o.status === 'failed');
        log(`${row.id} base ${row.base.slice(0, 7)}: ${v.outcomes.length} tests, ${red.length} red, ${v.loadErrors.length} load error(s)${v.crashed ? ' (CRASHED)' : ''}${red.slice(0, 3).map((o) => `\n  - ${o.file}: ${o.name}`).join('')}`);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    return;
  }

  if (cmd === 'smoke') {
    // Exactly one real call: a trivial prompt, in an empty temp dir. Prints shape and cost only.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-smoke-'));
    const r = await new ClaudeCliClient().run({ role: 'smoke', prompt: 'Create a file named hello.txt containing exactly the word ok, then reply with the single word done.', tools: 'agent', cwd: dir, maxCalls: 6, timeoutMs: 3 * 60_000 });
    const wrote = fs.existsSync(path.join(dir, 'hello.txt')) ? fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8').trim() : null;
    fs.rmSync(dir, { recursive: true, force: true });
    log(JSON.stringify({ stopReason: r.stopReason, calls: r.calls, usage: r.usage, costUsd: r.costUsd, durationMs: r.durationMs, reply: r.text.slice(0, 80), fileWritten: wrote }, null, 2));
    return;
  }

  if (cmd === 'pilot') {
    if (!f['release-pilot']) throw new Error('refusing to run the pilot without --release-pilot (the maintainer releases the spend)');
    const rows = typeof f.rows === 'string' ? f.rows.split(',') : PILOT_ROWS.map((r) => r.id);
    const corpus = await loadCorpus(corpusFile, repo, rows);
    const runId = String(f.run ?? `pilot-${new Date().toISOString().slice(0, 10)}`);
    const tracker = new BudgetTracker(Number(f.expected ?? EXPECTED_CALLS), Number(f['hard-stop'] ?? HARD_STOP_CALLS));
    const out = await runPilot({
      corpus, repo, harnessRoot, runId,
      outDir: String(f.out ?? path.join(repo, 'docs/backtest/runs')),
      workRoot: String(f.work ?? path.join(os.tmpdir(), 'beehive-backtest')),
      client: new ClaudeCliClient(), tracker, k: Number(f.k ?? 3), cfg: DEFAULT_ORACLE_CONFIG,
      issueApproval: f['auto-approve-issues'] ? 'auto' : 'required',
      keepWork: !!f['keep-work'], log,
    });
    log(`report: ${out.reportPath}\ncalls used: ${out.meta.budget.used}/${out.meta.budget.hardStop}${out.meta.aborted ? `\nABORTED: ${out.meta.aborted}` : ''}`);
    return;
  }

  log('usage: cli.ts freeze [--force] | check [--base-green] | smoke | pilot --release-pilot [--run NAME] [--k 3] [--rows A1,A2] [--out DIR] [--work DIR] [--keep-work] [--auto-approve-issues]');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

// Plan step 1: the base must build and its own test run must be green. Dependencies are installed from the base's own
// lockfile (npm ci, or npm install where there is none) in the root and cli/, never borrowed from HEAD. The suite runs
// up to `baseAttempts` times when something fails: red = failed every time (row is dropped), flaky = intermittent (kept, noted).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CorpusRow } from './corpus.ts';
import { createScratchRepo } from './git.ts';
import { stableRun, type OracleConfig } from './oracles.ts';

export interface BaseGreen {
  checkedAt: string;
  tests: number;
  red: string[];
  flaky: string[];
  loadErrors: string[];
  verdict: 'keep' | 'drop';
}

export async function baseGreen(repo: string, row: CorpusRow, cfg: OracleConfig, now = new Date()): Promise<BaseGreen> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-green-'));
  try {
    const s = await createScratchRepo(repo, row.base, dir, row.scrubDocs);
    if (cfg.installDeps) await cfg.installDeps(s.repo);
    const run = await stableRun(s.repo, cfg, cfg.baseAttempts);
    const red = run.outcomes.filter((o) => o.status === 'failed').map((o) => `${o.file}::${o.name}`);
    const bad = red.length > 0 || run.crashed || run.timedOut || run.loadErrors.length > 0;
    return { checkedAt: now.toISOString(), tests: run.outcomes.length, red, flaky: run.flaky, loadErrors: run.loadErrors, verdict: bad ? 'drop' : 'keep' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

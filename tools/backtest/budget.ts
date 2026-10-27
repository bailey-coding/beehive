// Call/token budget (docs/SPEC-BACKTEST-PLAN.md section 6): ~565 expected, hard stop 850.
import fs from 'node:fs';
import path from 'node:path';
import type { ModelClient, ModelRequest, ModelResponse, Role, Usage } from './client.ts';

export const EXPECTED_CALLS = 565;
export const HARD_STOP_CALLS = 850;

export class BudgetExceeded extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

export interface LedgerEntry {
  role: Role;
  rowId?: string;
  calls: number;
  usage: Usage;
  costUsd: number | null;
  durationMs: number;
  stopReason: ModelResponse['stopReason'];
}

export class BudgetTracker {
  readonly ledger: LedgerEntry[] = [];
  private specFailRun = 0;
  private file: string | null = null;
  readonly expected: number;
  readonly hardStop: number;

  /** The hard stop can be lowered, never raised past the plan's 850. */
  constructor(expected = EXPECTED_CALLS, hardStop = HARD_STOP_CALLS) {
    this.hardStop = Math.min(hardStop, HARD_STOP_CALLS);
    this.expected = Math.min(expected, this.hardStop);
  }

  /** Share one cap across invocations (issue pass, then second pass): load prior entries, persist every change. */
  attach(file: string): void {
    this.file = file;
    if (fs.existsSync(file) && this.ledger.length === 0) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { ledger: LedgerEntry[]; specFailRun?: number };
      this.ledger.push(...j.ledger);
      this.specFailRun = j.specFailRun ?? 0;
    }
    this.persist();
  }

  persist(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ expected: this.expected, hardStop: this.hardStop, used: this.used, specFailRun: this.specFailRun, ledger: this.ledger }, null, 2) + '\n');
  }

  get used(): number {
    return this.ledger.reduce((n, e) => n + e.calls, 0);
  }
  get remaining(): number {
    return Math.max(0, this.hardStop - this.used);
  }
  byRole(): Record<string, { calls: number; costUsd: number | null; inputTokens: number; outputTokens: number }> {
    const out: Record<string, { calls: number; costUsd: number | null; inputTokens: number; outputTokens: number }> = {};
    for (const e of this.ledger) {
      const o = (out[e.role] ??= { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
      o.calls += e.calls;
      o.inputTokens += e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheCreationTokens;
      o.outputTokens += e.usage.outputTokens;
      o.costUsd = o.costUsd === null || e.costUsd === null ? null : o.costUsd + e.costUsd;
    }
    return out;
  }

  /** Stop rule: two specs in a row fail validators twice. */
  recordSpecOutcome(passedWithinRetry: boolean): void {
    this.specFailRun = passedWithinRetry ? 0 : this.specFailRun + 1;
    this.persist();
    if (this.specFailRun >= 2) throw new BudgetExceeded('stop rule: two specs in a row failed validators twice');
  }
}

/** Wraps a client: refuses to start past the hard stop, clamps each run's call limit to what remains, records everything. */
export class BudgetedClient implements ModelClient {
  /** throwOnError: a failed call (auth, bad model, crash) aborts the run instead of becoming silent empty text. */
  constructor(private readonly inner: ModelClient, readonly tracker: BudgetTracker, private readonly throwOnError = true) {}
  get name(): string {
    return this.inner.name;
  }
  async run(req: ModelRequest): Promise<ModelResponse> {
    const t = this.tracker;
    if (t.remaining <= 0) throw new BudgetExceeded(`hard stop: ${t.used}/${t.hardStop} calls used`);
    const clamped = req.maxCalls > t.remaining;
    const res = await this.inner.run({ ...req, maxCalls: Math.min(req.maxCalls, t.remaining) });
    t.ledger.push({ role: req.role, rowId: req.rowId, calls: res.calls, usage: res.usage, costUsd: res.costUsd, durationMs: res.durationMs, stopReason: res.stopReason });
    t.persist();
    if (this.throwOnError && res.stopReason === 'error') {
      throw new BudgetExceeded(`model call failed (${req.role}${req.rowId ? ` ${req.rowId}` : ''}): ${res.error ?? `exit code ${res.exitCode}`}`);
    }
    if (clamped && res.stopReason === 'call-limit') {
      // The run was cut by the global limit, not its own: surface it so the caller aborts cleanly.
      throw new BudgetExceeded(`hard stop reached mid-run: ${t.used}/${t.hardStop} calls used`);
    }
    return res;
  }
}

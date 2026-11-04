// Call/token budget (docs/SPEC-BACKTEST-PLAN.md section 6): ~565 expected, hard stop 850.
import fs from 'node:fs';
import path from 'node:path';
import type { ModelClient, ModelRequest, ModelResponse, Role, Usage } from './client.ts';

export const EXPECTED_CALLS = 565;
export const HARD_STOP_CALLS = 850;

export class BudgetExceeded extends Error {
  /** `response`: the call finished and was recorded before the abort (a cap crossed by that very call), so the caller can still keep its result. */
  constructor(public readonly reason: string, public readonly response?: ModelResponse) {
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
  /** Arms runs: who made the call (absent in single-client runs and in older ledgers). */
  runId?: string;
  arm?: string;
  /** Requested model / effort / CLI version, and the model the CLI reported in its init event. */
  model?: string;
  effort?: string;
  cliVersion?: string;
  cliAlias?: string;
  reportedModel?: string;
  /** Grading calls: the model that graded (the arm whose client was used). */
  grader?: string;
  /** What this call counted toward the dollar cap: costUsd, or an upper bound when costUsd is null (costEstimated). */
  chargedUsd?: number;
  costEstimated?: boolean;
}

/** USD per million tokens. */
export interface Rates {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheCreationPerM: number;
}

export function costFromTokens(u: Usage, r: Rates): number {
  return (u.inputTokens * r.inputPerM + u.outputTokens * r.outputPerM + u.cacheReadTokens * r.cacheReadPerM + u.cacheCreationTokens * r.cacheCreationPerM) / 1e6;
}

/** A deliberately generous single API call (observed pilot calls are about a tenth of this); the per-call estimate when nothing else is known. */
export const WORST_CALL: Usage = { inputTokens: 10_000, outputTokens: 6_000, cacheReadTokens: 120_000, cacheCreationTokens: 20_000 };
export const worstCallUsd = (r: Rates): number => costFromTokens(WORST_CALL, r);

export interface Pricing {
  rates: Rates;
  worstCallUsd: number;
}

/**
 * Run-level dollar cap. Spend is read from the ledger entries of this run (chargedUsd), so it survives a resume and no
 * state lives outside the ledger. Entries without a charge (older ledgers, unpriced clients) count as zero.
 */
export class DollarMeter {
  constructor(readonly capUsd: number, private readonly tracker: BudgetTracker, readonly runId: string) {}
  private mine(): LedgerEntry[] {
    return this.tracker.ledger.filter((e) => e.runId === this.runId);
  }
  get chargedUsd(): number {
    return this.mine().reduce((n, e) => n + (e.chargedUsd ?? 0), 0);
  }
  get estimatedUsd(): number {
    return this.mine().filter((e) => e.costEstimated).reduce((n, e) => n + (e.chargedUsd ?? 0), 0);
  }
}

export interface BudgetedOptions {
  ident?: { runId?: string; arm: string; model: string; effort: string; cliVersion: string; cliAlias: string };
  /** With a meter, every call must be priced: no pricing means no per-call estimate, so the run aborts before the call. */
  pricing?: Pricing;
  meter?: DollarMeter;
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
  byRole(only?: (e: LedgerEntry) => boolean): Record<string, { calls: number; costUsd: number | null; inputTokens: number; outputTokens: number }> {
    const out: Record<string, { calls: number; costUsd: number | null; inputTokens: number; outputTokens: number }> = {};
    for (const e of only ? this.ledger.filter(only) : this.ledger) {
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
  constructor(private readonly inner: ModelClient, readonly tracker: BudgetTracker, private readonly throwOnError = true, private readonly opts: BudgetedOptions = {}) {}
  get name(): string {
    return this.inner.name;
  }
  async run(req: ModelRequest): Promise<ModelResponse> {
    const t = this.tracker;
    if (t.remaining <= 0) throw new BudgetExceeded(`hard stop: ${t.used}/${t.hardStop} calls used`);
    const { meter, pricing, ident } = this.opts;
    const maxCalls = Math.min(req.maxCalls, t.remaining);
    if (meter) {
      // Checked before every call: the call's own worst case (maxCalls x the per-call estimate) must still fit under the cap.
      if (!pricing) throw new BudgetExceeded(`dollar cap: no per-call estimate for arm ${ident?.arm ?? '?'}; refusing before its first priced call`);
      const bound = maxCalls * pricing.worstCallUsd;
      if (meter.chargedUsd + bound > meter.capUsd) throw new BudgetExceeded(`dollar cap $${meter.capUsd.toFixed(2)}: $${meter.chargedUsd.toFixed(2)} charged, and the next ${req.role} call could cost up to $${bound.toFixed(2)}`);
    }
    const clamped = req.maxCalls > t.remaining;
    const res = await this.inner.run({ ...req, maxCalls });
    // A null costUsd (a killed run) is charged at an upper bound so a timeout cannot hide spend: tokens seen plus one
    // in-flight call when any were seen, else maxCalls x the per-call estimate. Labelled estimated; never a measurement.
    let chargedUsd: number | undefined;
    let estimated = false;
    if (pricing) {
      if (res.costUsd !== null) chargedUsd = res.costUsd;
      else {
        estimated = true;
        const u = res.usage;
        const seen = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens > 0;
        chargedUsd = seen ? costFromTokens(u, pricing.rates) + pricing.worstCallUsd : maxCalls * pricing.worstCallUsd;
      }
    }
    t.ledger.push({
      role: req.role, rowId: req.rowId, calls: res.calls, usage: res.usage, costUsd: res.costUsd, durationMs: res.durationMs, stopReason: res.stopReason,
      ...(ident ? { runId: ident.runId, arm: ident.arm, model: ident.model, effort: ident.effort, cliVersion: ident.cliVersion, cliAlias: ident.cliAlias, ...(res.model ? { reportedModel: res.model } : {}), ...(req.role === 'grade' ? { grader: ident.arm } : {}) } : {}),
      ...(chargedUsd !== undefined ? { chargedUsd, ...(estimated ? { costEstimated: true } : {}) } : {}),
    });
    t.persist();
    const done = estimated ? { ...res, estimatedUsd: chargedUsd } : res;
    if (meter && meter.chargedUsd > meter.capUsd) throw new BudgetExceeded(`dollar cap $${meter.capUsd.toFixed(2)} exceeded: $${meter.chargedUsd.toFixed(2)} charged`, done);
    if (this.throwOnError && res.stopReason === 'error') {
      throw new BudgetExceeded(`model call failed (${req.role}${req.rowId ? ` ${req.rowId}` : ''}): ${res.error ?? `exit code ${res.exitCode}`}`);
    }
    if (clamped && res.stopReason === 'call-limit') {
      // The run was cut by the global limit, not its own: surface it so the caller aborts cleanly.
      throw new BudgetExceeded(`hard stop reached mid-run: ${t.used}/${t.hardStop} calls used`, done);
    }
    return done;
  }
}

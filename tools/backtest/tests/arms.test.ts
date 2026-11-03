// Arms, the dollar cap and the front-half reuse (fake clients, no model, no network).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARM_TABLE, assertPreflight, pricingOf, preflight, reuseFrontHalf, selectArms, seededOrder, validateArmTable, type ArmSpec } from '../arms.ts';
import { BudgetExceeded, BudgetTracker, BudgetedClient, DollarMeter, costFromTokens, worstCallUsd } from '../budget.ts';
import { validateFlags } from '../cli.ts';
import { FakeClient } from '../client.ts';
import type { CorpusRow } from '../corpus.ts';
import { exec } from '../exec.ts';

const spec = (over: Partial<ArmSpec> = {}): ArmSpec => ({ ...ARM_TABLE[0], ...over });
const req = (maxCalls = 4) => ({ role: 'candidate' as const, rowId: 'A1', prompt: '', tools: 'agent' as const, maxCalls, timeoutMs: 1 });
const ident = (arm: string, runId = 'r1') => ({ runId, arm, model: 'm', effort: 'medium', cliVersion: '1.0', cliAlias: 'm' });

describe('arm table', () => {
  it('validates the shipped table, effort values, ids and rates', () => {
    expect(() => validateArmTable(ARM_TABLE)).not.toThrow();
    expect(() => validateArmTable([spec({ effort: 'extreme' as never })])).toThrow(/effort/);
    expect(() => validateArmTable([spec(), spec()])).toThrow(/duplicate arm id/);
    expect(() => validateArmTable([spec({ id: 'Bad Id' })])).toThrow(/lowercase/);
    expect(() => validateArmTable([spec({ id: 'deps' })])).toThrow(/reserved/);
    expect(() => validateArmTable([spec({ model: '' })])).toThrow(/model/);
    expect(() => validateArmTable([spec({ rates: { ...ARM_TABLE[0].rates, inputPerM: -1 } })])).toThrow(/rate/);
    expect(() => validateArmTable([])).toThrow(/empty/);
  });
  it('selects named arms in order and refuses unknown, repeated or single arms', () => {
    expect(selectArms(ARM_TABLE, ['opus-medium', 'sonnet-medium']).map((a) => a.id)).toEqual(['opus-medium', 'sonnet-medium']);
    expect(() => selectArms(ARM_TABLE, ['sonnet-medium', 'nope'])).toThrow(/unknown arm nope/);
    expect(() => selectArms(ARM_TABLE, ['sonnet-medium', 'sonnet-medium'])).toThrow(/twice/);
    expect(() => selectArms(ARM_TABLE, ['sonnet-medium'])).toThrow(/at least two/);
  });
});

describe('seeded interleaving', () => {
  const ids = ['a', 'b', 'c'];
  it('is deterministic for a seed, row and k, a permutation, and varies across k and seeds', () => {
    expect(seededOrder('s', 'A4', 1, ids)).toEqual(seededOrder('s', 'A4', 1, ids));
    for (let k = 1; k <= 6; k++) expect([...seededOrder('s', 'A4', k, ids)].sort()).toEqual(ids);
    const orders = new Set<string>();
    for (const row of ['A4', 'A5', 'A11']) for (let k = 1; k <= 3; k++) orders.add(seededOrder('s', row, k, ids).join());
    expect(orders.size).toBeGreaterThan(1);
    expect(new Set([1, 2, 3, 4, 5, 6].map((s) => seededOrder(String(s), 'A4', 1, ids).join())).size).toBeGreaterThan(1);
  });
});

describe('pre-flight worst-case check', () => {
  it('counts pending candidates x maxCalls, grading and the canary reserve, and refuses above the remaining ledger', () => {
    const p = preflight({ pendingCandidates: 18, pendingGrades: 36, candidateMaxCalls: 20, remaining: 562 });
    expect(p).toMatchObject({ candidateCalls: 360, gradingCalls: 72, canaryCalls: 6, worstCase: 438, ok: true });
    expect(() => assertPreflight(p)).not.toThrow();
    const over = preflight({ pendingCandidates: 18, pendingGrades: 36, candidateMaxCalls: 40, remaining: 562 });
    expect(over.worstCase).toBe(798);
    expect(() => assertPreflight(over)).toThrow(/exceeds the 562 calls left/);
  });
});

describe('dollar cap and null cost', () => {
  const pricing = pricingOf(ARM_TABLE[1]);
  const mk = (cap: number, inner: FakeClient, runId = 'r1', arm = 'opus-medium', pr: typeof pricing | null = pricing) => {
    const tracker = new BudgetTracker();
    const meter = new DollarMeter(cap, tracker, runId);
    return { tracker, meter, client: new BudgetedClient(inner, tracker, true, { ident: ident(arm, runId), pricing: pr ?? undefined, meter }) };
  };

  it('prices from the rates table and has a per-call estimate', () => {
    expect(costFromTokens({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheCreationTokens: 1e6 }, ARM_TABLE[1].rates)).toBeCloseTo(4 + 20 + 0.2 + 5);
    expect(worstCallUsd(ARM_TABLE[1].rates)).toBeGreaterThan(worstCallUsd(ARM_TABLE[0].rates));
  });

  it('records the measured cost as the charge and stamps the ledger entry with the arm, model, effort, CLI version and reported model', async () => {
    const { tracker, meter, client } = mk(15, new FakeClient(() => ({ text: 'x', costUsd: 0.4, model: 'claude-opus-5-5' })));
    const res = await client.run(req());
    expect(res.estimatedUsd).toBeUndefined();
    expect(meter.chargedUsd).toBeCloseTo(0.4);
    expect(tracker.ledger[0]).toMatchObject({ runId: 'r1', arm: 'opus-medium', model: 'm', effort: 'medium', cliVersion: '1.0', cliAlias: 'm', reportedModel: 'claude-opus-5-5', chargedUsd: 0.4 });
    expect(tracker.ledger[0].costEstimated).toBeUndefined();
  });

  it('a killed candidate (null cost) is charged an upper bound and labelled estimated; the run does not abort', async () => {
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 20_000, cacheCreationTokens: 0 };
    const { tracker, meter, client } = mk(15, new FakeClient((_r, n) => (n === 1 ? { text: '', costUsd: null, stopReason: 'call-limit', calls: 20, usage, usageLowerBound: true } : { text: 'ok', costUsd: 0.1 })));
    const killed = await client.run(req(20));
    expect(killed.costUsd).toBeNull();
    const bound = costFromTokens(usage, ARM_TABLE[1].rates) + pricing.worstCallUsd;
    expect(killed.estimatedUsd).toBeCloseTo(bound);
    expect(tracker.ledger[0]).toMatchObject({ costUsd: null, costEstimated: true });
    expect(tracker.ledger[0].chargedUsd).toBeCloseTo(bound);
    await expect(client.run(req(20))).resolves.toMatchObject({ text: 'ok' }); // a later candidate still runs
    expect(meter.estimatedUsd).toBeCloseTo(bound);
  });

  it('with no tokens seen the charge is maxCalls x the per-call estimate', async () => {
    const { client } = mk(15, new FakeClient(() => ({ text: '', costUsd: null, stopReason: 'timeout', calls: 0, usage: { inputTokens: 0, outputTokens: 0 } })));
    const r = await client.run(req(5));
    expect(r.estimatedUsd).toBeCloseTo(5 * pricing.worstCallUsd);
  });

  it('checks the cap before each call: a call whose worst case would break the cap is refused without being made', async () => {
    const inner = new FakeClient(() => ({ text: 'x', costUsd: 1 }));
    const { client, meter } = mk(2, inner);
    await client.run(req(1)); // 1 x ~0.28 bound fits
    await client.run(req(1));
    expect(meter.chargedUsd).toBeCloseTo(2);
    await expect(client.run(req(1))).rejects.toThrow(/dollar cap \$2\.00/);
    expect(inner.requests).toHaveLength(2);
  });

  it('a call that pushes the charge past the cap aborts the whole run after it is recorded', async () => {
    const { client, tracker } = mk(1, new FakeClient(() => ({ text: 'x', costUsd: 5 })));
    await expect(client.run(req(1))).rejects.toThrow(/exceeded/);
    expect(tracker.ledger).toHaveLength(1);
  });

  it('the spend is read from the ledger by run id, so a resume keeps it and another run does not share it', async () => {
    const tracker = new BudgetTracker();
    const first = new BudgetedClient(new FakeClient(() => ({ text: 'x', costUsd: 1.5 })), tracker, true, { ident: ident('opus-medium', 'r1'), pricing, meter: new DollarMeter(15, tracker, 'r1') });
    await first.run(req(1));
    expect(new DollarMeter(15, tracker, 'r1').chargedUsd).toBeCloseTo(1.5);
    expect(new DollarMeter(15, tracker, 'r2').chargedUsd).toBe(0);
  });

  it('fails closed only when no per-call estimate exists: an unpriced arm aborts before its first call', async () => {
    const inner = new FakeClient(() => ({ text: 'x' }));
    const { client } = mk(15, inner, 'r1', 'mystery', null);
    await expect(client.run(req(1))).rejects.toBeInstanceOf(BudgetExceeded);
    await expect(client.run(req(1))).rejects.toThrow(/no per-call estimate for arm mystery/);
    expect(inner.requests).toHaveLength(0);
  });

  it('without a meter nothing changes: unpriced clients are not charged', async () => {
    const tracker = new BudgetTracker();
    await new BudgetedClient(new FakeClient(() => ({ text: 'x', costUsd: null })), tracker).run(req(1));
    expect(tracker.ledger[0].chargedUsd).toBeUndefined();
  });
});

describe('front-half reuse', () => {
  const row = { id: 'A4', sha: 'abc' } as CorpusRow;
  const harness = { commit: 'deadbeef', dirty: false };
  function source(over: { approved?: boolean; wrong?: unknown } = {}) {
    const from = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-src-'));
    const d = path.join(from, 'rows', 'A4');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'issue.json'), JSON.stringify({ text: 't', approved: over.approved ?? true }));
    fs.writeFileSync(path.join(d, 'spec.json'), '{"name":"s"}');
    fs.writeFileSync(path.join(d, 'reference.json'), '{"ref":1}');
    fs.writeFileSync(path.join(d, 'result.json'), JSON.stringify({ leakage: { wrongIssue: 'wrong' in over ? over.wrong : { ran: true, similarity: 0.1, passed: true, detail: 'x' } } }));
    return from;
  }
  it('copies the files, records their hashes and the leakage-1 result, and never overwrites a different file', () => {
    const from = source();
    const to = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-dst-'));
    const m = reuseFrontHalf({ fromRunDir: from, toRunDir: to, rows: [row], harness });
    expect(m.rows.A4.files['issue.json']).toMatch(/^[0-9a-f]{64}$/);
    expect(m.rows.A4).toMatchObject({ referenceReused: expect.stringMatching(/^[0-9a-f]{64}$/), leakage1: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.parse(fs.readFileSync(path.join(to, 'rows/A4/leakage1.json'), 'utf8')).wrongIssue).toMatchObject({ ran: true });
    expect(fs.existsSync(path.join(to, 'front-half.json'))).toBe(true);
    expect(() => reuseFrontHalf({ fromRunDir: from, toRunDir: to, rows: [row], harness })).not.toThrow(); // idempotent on resume
    fs.writeFileSync(path.join(from, 'rows/A4/spec.json'), '{"name":"changed"}');
    expect(() => reuseFrontHalf({ fromRunDir: from, toRunDir: to, rows: [row], harness })).toThrow(/differs from the reused source/);
  });
  it('refuses an unapproved issue, a missing spec and an absent leakage-1 result', () => {
    const to = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-dst-'));
    expect(() => reuseFrontHalf({ fromRunDir: source({ approved: false }), toRunDir: to(), rows: [row], harness })).toThrow(/not approved/);
    expect(() => reuseFrontHalf({ fromRunDir: source({ wrong: null }), toRunDir: to(), rows: [row], harness })).toThrow(/no wrong-issue result/);
    const s = source();
    fs.rmSync(path.join(s, 'rows/A4/spec.json'));
    expect(() => reuseFrontHalf({ fromRunDir: s, toRunDir: to(), rows: [row], harness })).toThrow(/spec.json is missing/);
  });
});

describe('arms subcommand flags', () => {
  const ok: Record<string, string | true> = { 'release-pilot': true, run: 'cmp-1', arms: 'sonnet-medium,opus-medium', rows: 'A4,A5,A11', 'reuse-from': 'pilot-2' };
  it('accepts the plan\'s invocation, with --candidate-max-calls and a lowered --dollar-cap', () => {
    expect(() => validateFlags('arms', { ...ok, k: '3', 'candidate-max-calls': '20' })).not.toThrow();
    expect(() => validateFlags('arms', { ...ok, 'dollar-cap': '8' })).not.toThrow();
  });
  it('rejects unknown flags, missing required ones, a raised dollar cap and an out-of-range call limit', () => {
    expect(() => validateFlags('arms', { ...ok, 'hard-stop': '100' })).toThrow(/unknown flag --hard-stop/);
    expect(() => validateFlags('arms', { ...ok, 'allow-bash': true })).toThrow(/unknown flag --allow-bash/);
    for (const need of ['run', 'arms', 'rows', 'reuse-from']) expect(() => validateFlags('arms', { ...ok, [need]: true })).toThrow(new RegExp(`--${need}`));
    expect(() => validateFlags('arms', { ...ok, 'dollar-cap': '16' })).toThrow(/between 0 and 15/);
    expect(() => validateFlags('arms', { ...ok, 'candidate-max-calls': '41' })).toThrow(/between 1 and 40/);
    expect(() => validateFlags('arms', { ...ok, 'candidate-max-calls': '2.5' })).toThrow(/integer/);
    expect(() => validateFlags('pilot', { 'candidate-max-calls': '20' })).toThrow(/unknown flag --candidate-max-calls/); // the single-client run keeps its flags
    expect(() => validateFlags('canary', { 'release-pilot': true, arms: 'sonnet-medium,opus-medium' })).not.toThrow();
  });
  it('refuses to spend without --release-pilot, before anything else happens', async () => {
    const root = path.resolve(__dirname, '..', '..', '..');
    const { 'release-pilot': _skip, ...noRelease } = ok;
    const args = Object.entries(noRelease).flatMap(([k, v]) => [`--${k}`, String(v)]);
    const r = await exec('node', ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', 'tools/backtest/cli.ts', 'arms', ...args], { cwd: root, env: { PATH: process.env.PATH } });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--release-pilot/);
  });
});

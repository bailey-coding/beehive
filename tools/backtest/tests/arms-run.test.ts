// The arms run end to end with scripted fake clients on the tiny fixture repo (real git, real vitest subprocesses, no model).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ARM_TABLE, seededOrder, type ArmSpec } from '../arms.ts';
import { BudgetTracker, worstCallUsd } from '../budget.ts';
import { FakeClient, type FakeReply, type ModelRequest } from '../client.ts';
import type { Corpus } from '../corpus.ts';
import { runPilot, type ArmRun, type RunOptions } from '../run.ts';
import { computeArmsMetrics } from '../metrics.ts';
import { gradesOf, type CandidateResult } from '../results.ts';
import { APP_FIXED, APP_PARTIAL, SPEC, cfg, harnessRoot, makeFixture } from './fixture.ts';

const hoisted = vi.hoisted(() => ({ failHistoryAt: null as number | null, historyCalls: 0 }));
vi.mock('../leakage.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../leakage.ts')>();
  return {
    ...m,
    historyTest: async (...a: Parameters<typeof m.historyTest>) => {
      hoisted.historyCalls++;
      if (hoisted.failHistoryAt === hoisted.historyCalls) return { passed: false, detail: ['forced leak in test'] };
      return m.historyTest(...a);
    },
  };
});

interface Step {
  write?: string;
  reply?: Partial<FakeReply>;
}

const ids = ['sonnet-medium', 'opus-medium'];
const specs = ids.map((id) => ARM_TABLE.find((a) => a.id === id)!);
let fx: Awaited<ReturnType<typeof makeFixture>>;
let corpus1: Corpus;
let corpus2: Corpus;
let sourceRun: string;
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = path.join(os.tmpdir(), `bt-arms-${p}-${Date.now()}-${dirs.length}`);
  dirs.push(d);
  return d;
};

/** Shared log of candidate requests across the arms, in global call order. */
type Log = { arm: string; k: number; cwd: string; prompt: string; maxCalls: number }[];
function armClient(arm: string, script: Record<number, Step>, log: Log, over: { model?: string | null; grade?: string; gradeCost?: number; onCandidate?: () => void; modelAt?: (k: number) => string } = {}) {
  let k = 0;
  const model = over.model === null ? undefined : over.model ?? (arm === 'sonnet-medium' ? 'claude-sonnet-5-5' : 'claude-opus-5-5');
  return new FakeClient((req: ModelRequest): FakeReply => {
    if (req.role === 'candidate') {
      k++;
      over.onCandidate?.();
      log.push({ arm, k, cwd: req.cwd!, prompt: req.prompt, maxCalls: req.maxCalls });
      const s = script[k] ?? {};
      if (s.write) fs.writeFileSync(path.join(req.cwd!, 'workers/api/index.ts'), s.write);
      return { text: 'done', calls: 4, costUsd: 0.5, model: over.modelAt ? over.modelAt(k) : model, ...s.reply };
    }
    if (req.role === 'grade') return { text: over.grade ?? '{"label":"spec-gap","rationale":"the spec never says what the page contains"}', calls: 1, costUsd: over.gradeCost ?? 0.04, model };
    throw new Error(`unexpected role ${req.role} for ${arm}`);
  });
}

const armRuns = (clients: FakeClient[], over: { cliVersion?: string; specs?: ArmSpec[] } = {}): ArmRun[] =>
  (over.specs ?? specs).map((spec, i) => ({ spec, client: clients[i], cliVersion: over.cliVersion ?? '9.9.9' }));

const opts = (name: string, corpus: Corpus, over: Partial<RunOptions> = {}): RunOptions => ({
  corpus, repo: fx.source, harnessRoot, cfg,
  outDir: tmp(`out-${name}`), workRoot: tmp(`work-${name}`),
  runId: name, k: 2, issueApproval: 'auto', ledgerFile: path.join(tmp(`ledger-${name}`), 'ledger.json'),
  tracker: new BudgetTracker(), harness: { commit: 'abc1234', dirty: false }, ...over,
});

/** Writes the stored result of an earlier single-client run (the "pilot-2" of these tests) so arms runs can reuse its front half. */
async function singleClientSource(): Promise<string> {
  const o = opts('source', corpus2, { k: 1 });
  const fake = new FakeClient((req) => {
    if (req.role === 'issue') return { text: 'Roadmap page returns 401\n\nOpening the roadmap page without credentials answers 401. It should show the page.' };
    if (req.role === 'spec' || req.role === 'leakage') return { text: '```json\n' + JSON.stringify(SPEC) + '\n```' };
    if (req.role === 'candidate') return { text: 'done', calls: 1 };
    throw new Error(`unexpected role ${req.role}`);
  });
  await runPilot({ ...o, client: fake });
  expect(fake.requests.filter((r) => r.role === 'leakage')).toHaveLength(2);
  // resume of the single-client run: leakage-1 is read back from leakage1.json, not paid for again
  const again = new FakeClient((req) => {
    if (req.role === 'candidate') return { text: 'done', calls: 1 };
    throw new Error(`a resume must not call ${req.role}`);
  });
  await runPilot({ ...o, client: again });
  expect(again.requests).toHaveLength(0);
  return path.join(o.outDir, o.runId);
}

beforeAll(async () => {
  fx = await makeFixture();
  corpus1 = fx.corpus;
  corpus2 = { ...fx.corpus, rows: [fx.corpus.rows[0], { ...fx.corpus.rows[0], id: 'A2' }] };
  sourceRun = await singleClientSource();
}, 280_000);

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(fx.source, { recursive: true, force: true });
});

describe('arms run: two arms, K=2, interleaved, crossed grading', () => {
  let o: RunOptions;
  let log: Log;
  let res: Awaited<ReturnType<typeof runPilot>>;
  let clients: FakeClient[];
  let runDir: string;
  const cand = (arm: string, k: number) => JSON.parse(fs.readFileSync(path.join(runDir, 'rows/A1/candidates', arm, `c${k}.json`), 'utf8')) as CandidateResult;

  beforeAll(async () => {
    log = [];
    // sonnet: k1 is killed by its timeout with no cost reported and changes nothing; k2 is a partial fix (held-out fails: residue).
    // opus: k1 is the full fix; k2 the partial fix. Opus's init event carries no model.
    clients = [
      armClient('sonnet-medium', { 1: { reply: { stopReason: 'timeout', costUsd: null, calls: 3, usage: { inputTokens: 500, outputTokens: 100 }, usageLowerBound: true } }, 2: { write: APP_PARTIAL } }, log),
      armClient('opus-medium', { 1: { write: APP_FIXED }, 2: { write: APP_PARTIAL } }, log, { model: null }),
    ];
    o = opts('arms-a', corpus1, { arms: armRuns(clients), reuseFrom: sourceRun, candidateMaxCalls: 20, seed: 'seed-1', keepWork: false });
    res = await runPilot(o);
    runDir = path.join(o.outDir, o.runId);
  }, 280_000);

  it('runs every arm at every k in the seeded order, one candidate per work dir and branch, with the plan\'s maxCalls', () => {
    expect(log).toHaveLength(4);
    for (const k of [1, 2]) expect(log.filter((l) => l.k === k).map((l) => l.arm)).toEqual(seededOrder('seed-1', 'A1', k, ids));
    expect(log.map((l) => l.k)).toEqual([1, 1, 2, 2]); // interleaved: both arms at k before k+1
    expect(new Set(log.map((l) => l.cwd)).size).toBe(4);
    for (const l of log) expect(l.maxCalls).toBe(20);
    for (const arm of ids) for (const k of [1, 2]) expect(fs.existsSync(path.join(runDir, 'rows/A1/candidates', arm, `c${k}.json`))).toBe(true);
  });

  it('gives both arms the same rendered prompt, and records its hash on every candidate', () => {
    expect(new Set(log.map((l) => l.prompt)).size).toBe(1);
    const hashes = ids.flatMap((a) => [1, 2].map((k) => cand(a, k).promptHash));
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('copies the front half byte for byte from the source run, records hashes, and makes no front-half call', () => {
    for (const f of ['issue.json', 'spec.json', 'spec.generated.json', 'spec.meta.json']) {
      expect(fs.readFileSync(path.join(runDir, 'rows/A1', f))).toEqual(fs.readFileSync(path.join(sourceRun, 'rows/A1', f)));
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'front-half.json'), 'utf8'));
    expect(manifest.harness).toEqual({ commit: 'abc1234', dirty: false });
    expect(manifest.rows.A1.files['spec.json']).toMatch(/^[0-9a-f]{64}$/);
    expect(res.meta.reuse?.manifest).toMatch(/^[0-9a-f]{64}$/);
    expect(clients.flatMap((c) => c.requests).filter((r) => r.role === 'spec' || r.role === 'leakage' || r.role === 'issue')).toHaveLength(0);
    expect(res.rows[0].leakage!.wrongIssue).toMatchObject({ ran: true }); // leakage-1 reused, not run
    expect(res.rows[0].referenceDiffersFromReused).toBe(false); // the reference recomputed at HEAD matches the reused one
  });

  it('records arm, model, effort and CLI version in run.json, every ledger entry and every candidate', () => {
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    expect(run.meta.arms).toEqual(specs.map((a) => ({ id: a.id, model: a.model, effort: a.effort, cliAlias: a.model, family: a.family, rates: a.rates, worstCallUsd: worstCallUsd(a.rates) }))); // rates and the per-call estimate are part of the identity
    expect(run.meta).toMatchObject({ cliVersion: '9.9.9', seed: 'seed-1', candidateMaxCalls: { value: 20, default: 40, deliberateChange: true }, harness: { commit: 'abc1234', dirty: false } });
    expect(run.meta.reportedModels).toEqual({ 'sonnet-medium': 'claude-sonnet-5-5' });
    expect(run.meta.modelNotReported).toEqual(['opus-medium']);
    const mine = run.ledger.filter((e: { runId?: string }) => e.runId === 'arms-a');
    expect(mine.length).toBeGreaterThan(0);
    for (const e of mine) expect(e).toMatchObject({ cliVersion: '9.9.9', effort: 'medium', arm: expect.stringMatching(/-medium$/) });
    expect(mine.find((e: { arm: string; role: string }) => e.arm === 'sonnet-medium' && e.role === 'candidate').model).toBe('claude-sonnet-5-5');
    expect(cand('sonnet-medium', 1).arm).toEqual({ arm: 'sonnet-medium', model: 'claude-sonnet-5-5', modelFromInit: true, effort: 'medium', cliVersion: '9.9.9', cliAlias: 'claude-sonnet-5-5', family: 'claude' });
    expect(cand('opus-medium', 1).arm).toMatchObject({ model: 'claude-opus-5-5', modelFromInit: false }); // fell back to the requested model, flagged
  });

  it('a killed candidate (timeout, null cost) is charged an estimated upper bound and does not abort the run', () => {
    const c = cand('sonnet-medium', 1);
    expect(c.stopReason).toBe('timeout');
    expect(c.cost).toMatchObject({ costUsd: null, killed: true });
    expect(c.cost.estimatedUsd).toBeGreaterThan(0);
    expect(res.meta.aborted).toBeNull();
    expect(res.rows[0].status).toBe('complete');
    expect(res.meta.dollar!.estimatedUsd).toBeCloseTo(c.cost.estimatedUsd!);
  });

  it('grades the residue of all arms with both graders, and the grader prompt never names an arm or a model', () => {
    const residue = ids.flatMap((a) => [1, 2].map((k) => cand(a, k))).filter((c) => c.label === null);
    expect(residue.length).toBe(2); // each arm's partial fix; sonnet's killed run and opus's full fix are decided deterministically
    for (const c of residue) {
      expect(c.grades!.map((g) => g.tag.grader).sort()).toEqual([...ids].sort());
      for (const g of c.grades!) expect(g.tag).toEqual({ grader: g.tag.grader, family: 'claude', sameFamilyAsCandidate: true });
      expect(gradesOf(c)).toHaveLength(2);
    }
    const prompts = clients.flatMap((c) => c.requests).filter((r) => r.role === 'grade').map((r) => r.prompt);
    expect(prompts).toHaveLength(residue.length * 2);
    for (const p of prompts) expect(p).not.toMatch(/sonnet|opus|medium|claude-/i);
    expect(res.rows[0].graderCalls).toBe(residue.length * 2);
  });

  it('keeps status, grader calls and leakage test 3 per arm', () => {
    const pa = res.rows[0].perArm!;
    expect(Object.keys(pa).sort()).toEqual([...ids].sort());
    for (const a of ids) expect(pa[a]).toMatchObject({ blocked: [], leakageHistory: { passed: true } });
    expect(pa['sonnet-medium'].graderCalls + pa['opus-medium'].graderCalls).toBe(res.rows[0].graderCalls);
  });

  it('deletes each candidate\'s agent root right after its eval clone', () => {
    for (const l of log) expect(fs.existsSync(path.dirname(l.cwd)), l.cwd).toBe(false);
  });

  it('resume: the grading pass is rebuilt from stored results and covers every arm\'s residue; no candidate is rerun', async () => {
    for (const a of ids) for (const k of [1, 2]) {
      const f = path.join(runDir, 'rows/A1/candidates', a, `c${k}.json`);
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      delete c.grades;
      fs.writeFileSync(f, JSON.stringify(c));
    }
    const log2: Log = [];
    const c2 = [armClient('sonnet-medium', {}, log2), armClient('opus-medium', {}, log2, { model: null })];
    const r2 = await runPilot({ ...o, arms: armRuns(c2), tracker: new BudgetTracker() });
    expect(log2).toHaveLength(0);
    const residue = ids.flatMap((a) => [1, 2].map((k) => cand(a, k))).filter((c) => c.label === null);
    for (const c of residue) expect(c.grades).toHaveLength(2);
    expect(c2.flatMap((c) => c.requests).filter((r) => r.role === 'grade')).toHaveLength(residue.length * 2);
    expect(r2.rows[0].candidates).toHaveLength(4);
  }, 280_000);

  it('resume refuses a changed arm table, model, effort, CLI version or candidate maxCalls', async () => {
    const same = () => [armClient('sonnet-medium', {}, []), armClient('opus-medium', {}, [])];
    const t = () => new BudgetTracker();
    await expect(runPilot({ ...o, arms: armRuns(same(), { specs: [specs[0], { ...specs[1], model: 'claude-opus-4-1' }] }), tracker: t() })).rejects.toThrow(/refusing to continue it/);
    await expect(runPilot({ ...o, arms: armRuns(same(), { specs: [specs[0], { ...specs[1], effort: 'high' }] }), tracker: t() })).rejects.toThrow(/refusing to continue it/);
    await expect(runPilot({ ...o, arms: armRuns(same(), { specs: [specs[1], specs[0]] }), tracker: t() })).rejects.toThrow(/refusing to continue it/); // the arm table includes its order
    await expect(runPilot({ ...o, arms: armRuns(same(), { cliVersion: '9.9.10' }), tracker: t() })).rejects.toThrow(/refusing to continue it/);
    await expect(runPilot({ ...o, arms: armRuns(same(), { specs: [specs[0], { ...specs[1], id: 'opus-high' }] }), tracker: t() })).rejects.toThrow(/refusing to continue it/);
    await expect(runPilot({ ...o, arms: armRuns(same()), tracker: t(), candidateMaxCalls: 40 })).rejects.toThrow(/candidate maxCalls 20/);
    await expect(runPilot({ ...o, arms: undefined, client: new FakeClient(() => ({ text: '' })), tracker: t() })).rejects.toThrow(/single client/);
  }, 120_000);
});

describe('arms run: leak-blocked arm, dollar cap, pre-flight, reported model', () => {
  it('a leak-blocked candidate drops that arm/k only: the other arm and the row go on, and the row is unpaired', async () => {
    const log: Log = [];
    const clients = [armClient('sonnet-medium', { 1: { write: APP_FIXED } }, log), armClient('opus-medium', { 1: { write: APP_FIXED } }, log)];
    const o = opts('arms-leak', corpus1, { k: 1, arms: armRuns(clients), reuseFrom: sourceRun, candidateMaxCalls: 20, seed: 's' });
    // a reused reference that no longer matches HEAD's is flagged, not ignored
    const stale = path.join(o.outDir, o.runId, 'rows/A1');
    fs.mkdirSync(stale, { recursive: true });
    const reused = JSON.parse(fs.readFileSync(path.join(sourceRun, 'rows/A1/reference.json'), 'utf8'));
    reused.report.acceptance.passed -= 1;
    fs.writeFileSync(path.join(stale, 'reference.reused.json'), JSON.stringify(reused));
    hoisted.historyCalls = 0;
    hoisted.failHistoryAt = 1; // the first candidate scheduled (whichever arm the seeded order puts first)
    let r;
    try {
      r = await runPilot(o);
    } finally {
      hoisted.failHistoryAt = null;
    }
    const [first, second] = seededOrder('s', 'A1', 1, ids);
    expect(r.rows[0].status).toBe('complete');
    expect(log.map((l) => l.arm)).toEqual([second]); // the blocked arm never reached the model
    expect(r.rows[0].perArm![first].blocked).toEqual([{ k: 1, note: expect.stringContaining('forced leak in test') }]);
    expect(r.rows[0].perArm![second].blocked).toEqual([]);
    expect(r.rows[0].candidates.map((c) => c.arm!.arm)).toEqual([second]);
    expect(r.rows[0].leakage!.history!.passed).toBe(false);
    expect(r.rows[0].referenceDiffersFromReused).toBe(true);
    expect(r.rows[0].note).toMatch(/differs from the reused earlier reference/);
    expect(fs.readFileSync(r.reportPath, 'utf8')).toMatch(/Reference differs from the reused one\*\* for A1/);
  }, 200_000);

  it('hitting the run-level dollar cap aborts the whole run, keeps partial results and writes the report', async () => {
    const log: Log = [];
    const costly = { reply: { costUsd: 20 } };
    const clients = [armClient('sonnet-medium', { 1: costly, 2: costly }, log), armClient('opus-medium', { 1: costly, 2: costly }, log)];
    const o = opts('arms-cap', corpus1, { arms: armRuns(clients), reuseFrom: sourceRun, candidateMaxCalls: 20, seed: 's', dollarCapUsd: 30 });
    const r = await runPilot(o);
    expect(r.meta.aborted).toMatch(/dollar cap \$30\.00 exceeded: \$40\.00 charged/);
    expect(log).toHaveLength(2); // the second call pushed the charge past the cap; nothing after it ran
    expect(r.rows[0].status).toBe('aborted');
    // the candidate whose call crossed the cap is stored too (marked), so the per-arm tables and the meter agree
    expect(r.rows[0].candidates.map((c) => c.stopReason)).toEqual(['done', 'cap-abort']);
    const stored = r.rows[0].candidates.find((c) => c.stopReason === 'cap-abort')!;
    expect(stored.error).toMatch(/dollar cap \$30\.00 exceeded/);
    expect(stored.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(stored.report).not.toBeNull();
    expect(fs.existsSync(path.join(o.outDir, o.runId, 'rows/A1/candidates', stored.arm!.arm, 'c1.json'))).toBe(true);
    expect(fs.existsSync(r.reportPath)).toBe(true);
    expect(r.meta.dollar).toMatchObject({ capUsd: 30, chargedUsd: 40 });
    const tableCost = r.rows[0].candidates.reduce((n, c) => n + (c.cost.costUsd ?? 0), 0);
    expect(tableCost).toBeCloseTo(r.meta.dollar!.chargedUsd);
  }, 200_000);

  it('pre-flight refuses a run whose worst case exceeds the remaining ledger, before any call', async () => {
    const log: Log = [];
    const clients = [armClient('sonnet-medium', {}, log), armClient('opus-medium', {}, log)];
    const o = opts('arms-pre', corpus1, { arms: armRuns(clients), reuseFrom: sourceRun, candidateMaxCalls: 40, tracker: new BudgetTracker(100, 100) });
    await expect(runPilot(o)).rejects.toThrow(/pre-flight: worst case \d+ calls .* exceeds the 100 calls left/);
    expect(log).toHaveLength(0);
    expect(clients.flatMap((c) => c.requests)).toHaveLength(0);
  });

  it('an arm that reports a different model than its earlier candidates (across rows or resumes) aborts the whole run', async () => {
    const mk = (modelAt: (k: number) => string) => [armClient('sonnet-medium', {}, [], { modelAt }), armClient('opus-medium', {}, [])];
    // across rows: sonnet's 2nd candidate (row A2) reports another model than its 1st (row A1)
    const o = opts('arms-model', corpus2, { k: 1, arms: armRuns(mk((k) => (k === 1 ? 'claude-sonnet-5-5' : 'claude-sonnet-5-5-b'))), reuseFrom: sourceRun, candidateMaxCalls: 20, seed: 's' });
    const r = await runPilot(o);
    expect(r.meta.aborted).toMatch(/arm sonnet-medium reported model claude-sonnet-5-5-b, but an earlier candidate of this run reported claude-sonnet-5-5/);
    expect(r.rows.map((x) => x.status)).toEqual(['complete', 'aborted']);
    expect(r.meta.reportedModels).toEqual({ 'sonnet-medium': 'claude-sonnet-5-5', 'opus-medium': 'claude-opus-5-5' }); // the run-wide map, not the offending model
    expect(r.rows[1].candidates.some((c) => c.arm?.arm === 'sonnet-medium')).toBe(false); // the offender is not stored
  }, 250_000);

  it('a reported model that is not the requested one aborts the run; a dated form of the requested id is accepted', async () => {
    const wrong = [armClient('sonnet-medium', {}, [], { model: 'claude-sonnet-5-6' }), armClient('opus-medium', {}, [])];
    const r = await runPilot(opts('arms-model2', corpus1, { k: 1, arms: armRuns(wrong), reuseFrom: sourceRun, candidateMaxCalls: 20, seed: 's' }));
    expect(r.meta.aborted).toMatch(/reported model claude-sonnet-5-6, but claude-sonnet-5-5 was requested/);
    const dated = [armClient('sonnet-medium', {}, [], { model: 'claude-sonnet-5-5-20261001' }), armClient('opus-medium', {}, [])];
    const ok = await runPilot(opts('arms-model3', corpus1, { k: 1, arms: armRuns(dated), reuseFrom: sourceRun, candidateMaxCalls: 20, seed: 's' }));
    expect(ok.meta.aborted).toBeNull();
    expect(ok.meta.reportedModels!['sonnet-medium']).toBe('claude-sonnet-5-5-20261001');
  }, 250_000);
});

describe('arms run: resume after a crash (no clean exit, no final run.json)', () => {
  let o: RunOptions;
  let runDir: string;
  let stub: { meta: Record<string, any> };

  beforeAll(async () => {
    const hook = () => {
      stub ??= JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    };
    const clients = [armClient('sonnet-medium', { 1: { write: APP_FIXED } }, [], { onCandidate: hook }), armClient('opus-medium', { 1: { write: APP_FIXED } }, [], { onCandidate: hook })];
    o = opts('arms-crash', corpus1, { k: 1, arms: armRuns(clients), reuseFrom: sourceRun, candidateMaxCalls: 20, seed: 's' });
    runDir = path.join(o.outDir, o.runId);
    await runPilot(o);
  }, 250_000);

  const fresh = () => [armClient('sonnet-medium', {}, []), armClient('opus-medium', {}, [])];
  const again = (over: Partial<RunOptions>, cs = fresh()) => runPilot({ ...o, tracker: new BudgetTracker(), arms: armRuns(cs), ...over });

  it('writes the meta stub (arms, rates, per-call estimates, CLI version, maxCalls, seed, front-half hash) before the first model call', () => {
    expect(stub.meta).toMatchObject({ inProgress: true, cliVersion: '9.9.9', seed: 's', candidateMaxCalls: { value: 20 }, reuse: { manifest: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(stub.meta.arms.map((a: { id: string }) => a.id)).toEqual(ids);
    for (const a of stub.meta.arms) expect(a).toMatchObject({ rates: { inputPerM: expect.any(Number), cacheReadPerM: expect.any(Number) }, worstCallUsd: expect.any(Number) });
  });

  it('after a crash that left only the stub, a changed CLI version, arm table or rate is refused and an unchanged resume works', async () => {
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ meta: stub.meta, ledger: [], rows: [] }));
    await expect(again({ arms: armRuns(fresh(), { cliVersion: '9.9.10' }) })).rejects.toThrow(/refusing to continue it/);
    await expect(again({ arms: armRuns(fresh(), { specs: [specs[0], { ...specs[1], effort: 'high' }] }) })).rejects.toThrow(/refusing to continue it/);
    await expect(again({ arms: armRuns(fresh(), { specs: [specs[0], { ...specs[1], rates: { ...specs[1].rates, outputPerM: 99 } }] }) })).rejects.toThrow(/rates/);
    await expect(again({ seed: 'other' })).rejects.toThrow(/seed s/);
    const cs = fresh();
    const r = await again({}, cs);
    expect(cs.flatMap((c) => c.requests).filter((q) => q.role === 'candidate')).toHaveLength(0);
    expect(r.rows[0].candidates).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).meta.inProgress).toBeUndefined(); // the clean exit replaced the stub
  }, 250_000);

  it('with no run.json at all, stored candidates from another setup still refuse the resume (read-back check); the same setup resumes', async () => {
    fs.rmSync(path.join(runDir, 'run.json'));
    await expect(again({ arms: armRuns(fresh(), { cliVersion: '9.9.10' }) })).rejects.toThrow(/stored candidate A1\/\S+\/c1 was produced by arm \S+: .*CLI 9\.9\.9; refusing to continue it/);
    await expect(again({ arms: armRuns(fresh(), { specs: [specs[0], { ...specs[1], effort: 'high' }] }) })).rejects.toThrow(/stored candidate .* effort medium.*refusing to continue it with arm opus-medium: effort high/);
    const cs = fresh();
    await again({}, cs);
    expect(cs.flatMap((c) => c.requests).filter((q) => q.role === 'candidate')).toHaveLength(0);
    expect(fs.existsSync(path.join(runDir, 'run.json'))).toBe(true);
  }, 250_000);
});

describe('arms run: a cap abort during grading does not drop the row', () => {
  it('every candidate was stored, so the row stays in the paired set although its status is aborted', async () => {
    const log: Log = [];
    const partial = { write: APP_PARTIAL };
    const clients = [armClient('sonnet-medium', { 1: partial }, log, { gradeCost: 40 }), armClient('opus-medium', { 1: partial }, log, { gradeCost: 40 })];
    const o = opts('arms-gradecap', corpus1, { k: 1, arms: armRuns(clients), reuseFrom: sourceRun, candidateMaxCalls: 20, seed: 's', dollarCapUsd: 30 });
    const r = await runPilot(o);
    expect(r.meta.aborted).toMatch(/dollar cap \$30\.00 exceeded/);
    expect(r.rows[0].status).toBe('aborted');
    expect(r.rows[0].candidates).toHaveLength(2);
    expect(computeArmsMetrics(r.rows, r.meta).pairedRows).toEqual(['A1']);
    expect(fs.readFileSync(r.reportPath, 'utf8')).toMatch(/Paired set: .*candidates alone decide.*: A1\./);
  }, 200_000);
});

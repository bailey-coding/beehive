// Arms: which model/effort produced a candidate (docs/plans/model-comparison-plan.md section 2). An arm is a table entry plus a client.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { worstCallUsd, type Pricing, type Rates } from './budget.ts';
import { EFFORTS, type Effort, type ModelClient } from './client.ts';
import type { CorpusRow } from './corpus.ts';
import { exec } from './exec.ts';
import { prng } from './sample.ts';
import type { ArmIdent } from './results.ts';

export interface ArmSpec {
  id: string;
  model: string;
  effort: Effort;
  /** Model family, for the grader tag (sameFamilyAsCandidate). */
  family: string;
  /** USD per million tokens. Assumed list prices: re-state at the run gate against the vendor's own price page. */
  rates: Rates;
}

export interface Arm extends ArmSpec {
  client: ModelClient;
}

/** Ids that name directories next to the arm work dirs. */
const RESERVED_IDS = ['deps', 'reference', 'rows', 'candidates'];

// Rates are USD per million tokens and every one is re-verified against the vendors' pricing pages at the run gate. The CLI's
// measured costUsd always takes precedence; these only price a killed run (no costUsd) and the per-call estimate behind the
// pre-call cap check. Cache-write rates assume the 5-minute cache TTL (1.25x input).
export const ARM_TABLE: ArmSpec[] = [
  // Sonnet 5.5: $2 in / $10 out / $0.20 cache read per the Claude API price table (cached 2026-10-06).
  { id: 'sonnet-medium', model: 'claude-sonnet-5-5', effort: 'medium', family: 'claude', rates: { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheCreationPerM: 2.5 } },
  { id: 'opus-medium', model: 'claude-opus-5-5', effort: 'medium', family: 'claude', rates: { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheCreationPerM: 5 } },
];

export const pricingOf = (a: ArmSpec): Pricing => ({ rates: a.rates, worstCallUsd: worstCallUsd(a.rates) });

export function validateArmTable(table: ArmSpec[]): void {
  if (!table.length) throw new Error('arm table is empty');
  const seen = new Set<string>();
  for (const a of table) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(a.id)) throw new Error(`arm id ${JSON.stringify(a.id)} must be lowercase letters, digits and hyphens`);
    if (RESERVED_IDS.includes(a.id)) throw new Error(`arm id ${a.id} is reserved (it names a work directory)`);
    if (seen.has(a.id)) throw new Error(`duplicate arm id ${a.id}`);
    seen.add(a.id);
    if (!a.model) throw new Error(`arm ${a.id}: model is empty`);
    if (!EFFORTS.includes(a.effort)) throw new Error(`arm ${a.id}: effort ${JSON.stringify(a.effort)} is not one of ${EFFORTS.join(', ')}`);
    for (const [k, v] of Object.entries(a.rates)) if (!(typeof v === 'number' && v >= 0)) throw new Error(`arm ${a.id}: rate ${k} must be a number >= 0`);
  }
}

/** The arms named on the command line, in the order given, from a validated table. */
export function selectArms(table: ArmSpec[], ids: string[]): ArmSpec[] {
  validateArmTable(table);
  if (ids.length < 2) throw new Error('--arms needs at least two arm ids');
  if (new Set(ids).size !== ids.length) throw new Error('--arms lists an arm twice');
  return ids.map((id) => {
    const a = table.find((x) => x.id === id);
    if (!a) throw new Error(`unknown arm ${id} (known: ${table.map((x) => x.id).join(', ')})`);
    return a;
  });
}

/** Deterministic arm order for one row and k, so provider load, time of day and cache warmth are spread over the arms. */
export function seededOrder(seed: string, rowId: string, k: number, armIds: string[]): string[] {
  const h = crypto.createHash('sha256').update(`${seed}|${rowId}|${k}`).digest();
  const rnd = prng(h.readUInt32BE(0));
  const out = [...armIds];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const sha256 = (x: string | Buffer): string => crypto.createHash('sha256').update(x).digest('hex');

export const armIdent = (a: ArmSpec, cliVersion: string, reportedModel?: string): ArmIdent => ({
  arm: a.id, model: reportedModel ?? a.model, modelFromInit: reportedModel !== undefined, effort: a.effort, cliVersion, cliAlias: a.model, family: a.family,
});

/** What run.json records per arm: the table entry plus the per-call estimate derived from its rates. */
export interface ArmMeta {
  id: string;
  model: string;
  effort: string;
  cliAlias: string;
  family: string;
  rates: Rates;
  worstCallUsd: number;
}

export const armMeta = (a: ArmSpec): ArmMeta => ({ id: a.id, model: a.model, effort: a.effort, cliAlias: a.model, family: a.family, rates: a.rates, worstCallUsd: worstCallUsd(a.rates) });

/** The identity the resume guard compares: arm table (order included), models, efforts, rates, per-call estimates and CLI version. */
export function runIdentity(arms: Pick<ArmMeta, 'id' | 'model' | 'effort' | 'rates' | 'worstCallUsd'>[], cliVersion: string): string {
  return JSON.stringify({ cliVersion, arms: arms.map((a) => ({ id: a.id, model: a.model, effort: a.effort, rates: a.rates, worstCallUsd: a.worstCallUsd })) });
}

/** A run that must not continue (changed setup, or stored results from another setup): refused before anything is spent. */
export class RunRefused extends Error {}

/** The reported model is the requested one, or a dated/suffixed form of it (claude-x-5-5 -> claude-x-5-5-20261001, claude-x-5-5[1m]). */
export function modelMatches(requested: string, reported: string): boolean {
  return reported === requested || reported.startsWith(`${requested}-`) || reported.startsWith(`${requested}[`);
}

/** A stored candidate must have been produced by the arm that is about to continue the run. Model: see the run-wide map in run.ts. */
export function assertStoredCandidate(runId: string, spec: ArmSpec, cliVersion: string, c: { k: number; arm?: ArmIdent }, where: string): void {
  const a = c.arm;
  const now = `arm ${spec.id}: effort ${spec.effort}, alias ${spec.model}, CLI ${cliVersion}`;
  if (!a) throw new RunRefused(`run ${runId}: stored candidate ${where} has no arm record; refusing to continue it (results of two setups are never mixed): use a new --run name`);
  if (a.arm !== spec.id || a.effort !== spec.effort || a.cliAlias !== spec.model || a.cliVersion !== cliVersion) {
    throw new RunRefused(`run ${runId}: stored candidate ${where} was produced by arm ${a.arm}: effort ${a.effort}, alias ${a.cliAlias}, CLI ${a.cliVersion}; refusing to continue it with ${now} (results of two setups are never mixed): use a new --run name`);
  }
  if (a.modelFromInit && !modelMatches(spec.model, a.model)) throw new RunRefused(`run ${runId}: stored candidate ${where} reports model ${a.model}, not the requested ${spec.model}; refusing to continue it: use a new --run name`);
}

/** `claude --version`: no model call. */
export async function claudeCliVersion(bin = 'claude'): Promise<string> {
  const r = await exec(bin, ['--version'], { timeoutMs: 20_000 });
  const v = r.stdout.trim();
  if (r.code !== 0 || !v) throw new Error(`${bin} --version failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
  return v;
}

// ---------------------------------------------------------------- pre-flight

export const GRADE_MAX_CALLS = 2;
/** Run-level dollar cap for an arms run (plan M2): --dollar-cap can only lower it. */
export const ARMS_DOLLAR_CAP_USD = 15;
/** Candidate maxCalls of an arms run (plan 2.2: the observed maximum is 11; the single-client default is 40). */
export const ARMS_CANDIDATE_MAX_CALLS = 20;
/** Reserve for the canary on both clients (3-6 calls, plan 2.2). */
export const CANARY_RESERVE_CALLS = 6;

export interface Preflight {
  candidateCalls: number;
  gradingCalls: number;
  canaryCalls: number;
  worstCase: number;
  remaining: number;
  ok: boolean;
}

/**
 * Worst case in calls: every pending candidate runs to maxCalls, every pending grader run uses its 2 calls, plus the
 * canary reserve. Leakage-1 and the front half are reused, so they have no term. Refuses above the remaining ledger.
 */
export function preflight(o: { pendingCandidates: number; pendingGrades: number; candidateMaxCalls: number; remaining: number; canaryCalls?: number }): Preflight {
  const candidateCalls = o.pendingCandidates * o.candidateMaxCalls;
  const gradingCalls = o.pendingGrades * GRADE_MAX_CALLS;
  const canaryCalls = o.canaryCalls ?? CANARY_RESERVE_CALLS;
  const worstCase = candidateCalls + gradingCalls + canaryCalls;
  return { candidateCalls, gradingCalls, canaryCalls, worstCase, remaining: o.remaining, ok: worstCase <= o.remaining };
}

export function assertPreflight(p: Preflight): void {
  if (!p.ok) throw new Error(`pre-flight: worst case ${p.worstCase} calls (candidates ${p.candidateCalls} + grading ${p.gradingCalls} + canary ${p.canaryCalls}) exceeds the ${p.remaining} calls left in the ledger; lower --candidate-max-calls, --k or the rows`);
}

// ---------------------------------------------------------------- reused front half

/** Files of one row copied from an earlier run, hash-recorded. spec.generated/meta are informative, issue and spec are required. */
const FRONT_FILES = ['issue.json', 'spec.json', 'spec.generated.json', 'spec.meta.json'];

export interface FrontHalfManifest {
  from: string;
  harness: { commit: string; dirty: boolean };
  rows: Record<string, { files: Record<string, string>; leakage1: string; referenceReused: string | null; corpusEntry: string }>;
}

const readIf = (f: string): Buffer | null => (fs.existsSync(f) ? fs.readFileSync(f) : null);

/**
 * Copy issue.json, spec.json, spec.generated.json, spec.meta.json and the leakage-1 result of each row from an earlier run
 * into this run's directory (never overwriting a different file), and record sha256 of each plus of the earlier
 * reference.json, the corpus entry and the harness commit. Zero model calls.
 */
export function reuseFrontHalf(o: { fromRunDir: string; toRunDir: string; rows: CorpusRow[]; harness: { commit: string; dirty: boolean } }): FrontHalfManifest {
  const manifest: FrontHalfManifest = { from: o.fromRunDir, harness: o.harness, rows: {} };
  for (const row of o.rows) {
    const src = path.join(o.fromRunDir, 'rows', row.id);
    const dst = path.join(o.toRunDir, 'rows', row.id);
    fs.mkdirSync(dst, { recursive: true });
    const files: Record<string, string> = {};
    for (const f of FRONT_FILES) {
      const b = readIf(path.join(src, f));
      if (!b) {
        if (f === 'issue.json' || f === 'spec.json') throw new Error(`cannot reuse the front half of ${row.id}: ${path.join(src, f)} is missing`);
        continue;
      }
      const have = readIf(path.join(dst, f));
      if (have && !have.equals(b)) throw new Error(`${path.join(dst, f)} differs from the reused source; refusing to overwrite (use a new --run name)`);
      if (!have) fs.writeFileSync(path.join(dst, f), b);
      files[f] = sha256(b);
    }
    if ((JSON.parse(fs.readFileSync(path.join(dst, 'issue.json'), 'utf8')) as { approved?: boolean }).approved !== true) throw new Error(`${row.id}: the reused issue.json is not approved`);
    // Leakage-1 is not resumable and its pairing depends on the row set: reuse the earlier result and skip the test.
    const res = readIf(path.join(src, 'result.json'));
    const wrong = res ? (JSON.parse(res.toString('utf8')) as { leakage?: { wrongIssue?: unknown } }).leakage?.wrongIssue ?? null : null;
    const dstLeak = path.join(dst, 'leakage1.json');
    if (!wrong && !fs.existsSync(dstLeak)) throw new Error(`cannot reuse leakage-1 for ${row.id}: ${path.join(src, 'result.json')} holds no wrong-issue result`);
    const leakBytes = Buffer.from(JSON.stringify({ wrongIssue: wrong, reusedFrom: o.fromRunDir }, null, 2) + '\n');
    const haveLeak = readIf(dstLeak);
    if (!haveLeak) fs.writeFileSync(dstLeak, leakBytes);
    const ref = readIf(path.join(src, 'reference.json'));
    if (ref && !fs.existsSync(path.join(dst, 'reference.reused.json'))) fs.writeFileSync(path.join(dst, 'reference.reused.json'), ref);
    manifest.rows[row.id] = { files, leakage1: sha256(haveLeak ?? leakBytes), referenceReused: ref ? sha256(ref) : null, corpusEntry: sha256(JSON.stringify(row)) };
  }
  fs.writeFileSync(path.join(o.toRunDir, 'front-half.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

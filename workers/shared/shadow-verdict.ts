/**
 * Shadow samples and the shadow verdict: the contract between the scientist comparator, the edge and the Spec DO.
 *
 * The comparator scores each mirrored request per candidate and posts one sample. The Spec DO sums them
 * (`shadow_scores`, schema m15) and derives the shadow verdict in the same transaction. One module owns the
 * schemas and the thresholds so the writer and the reader cannot drift.
 *
 * Spec: docs/plans/promotion-gaps-plan.md sections 3.1-3.2, 11 (B1-B5) and 12 (V5-V9).
 */

import { z } from 'zod';

/** Verdict is `pending` below this many samples. One constant behind a helper (plan V7); no policy key exists in code yet. */
export const SHADOW_MIN_SAMPLES = 20;
/** Average score (0-100) at or above which a shadow run passes: today's "good" band, not the old 40 */
export const SHADOW_PASS_SCORE = 80;
/** Samples kept per candidate; over the cap the route answers `capped: true` and records nothing (plan V9, in the DO) */
export const SHADOW_MAX_SAMPLES = 1000;
/** Samples in one request body; a body under an Idempotency-Key must hold exactly one (the key is per request and candidate) */
export const SHADOW_MAX_SAMPLES_PER_POST = 100;
export const SHADOW_MAX_DIFFS_PER_SAMPLE = 50;

/** Error string of the coded 404 for an unknown or tombstoned candidate (the USER_TOKEN_NOT_FOUND pattern, plan B5/V8) */
export const CANDIDATE_NOT_FOUND = 'candidate_not_found';

/** The reserved service actor that decides shadow verdicts; created lazily by the route (an actors FK needs a row) */
export const SCIENTIST_COMPARATOR_ACTOR = 'scientist-comparator';

export function shadowMinSamples(): number {
  return SHADOW_MIN_SAMPLES;
}

/** Production samples needed before a production-only verdict or tournament score exists. Its own helper so the flip can raise or qualify it without touching the all-sample rule. */
export function shadowMinProductionSamples(): number {
  return SHADOW_MIN_SAMPLES;
}

/**
 * The default-off D2-prep switches (SHADOW_VERDICT_SOURCE on the Spec DO, TOURNAMENT_SHADOW_SOURCE on the promotion worker): true only for
 * `production` (trimmed, any case). An unrecognized non-empty value is off and warns once per value, so a typo is visible, not silent.
 * Set by the maintainer in `[vars]` of the deploy repo, never in this repo's configs (tests/unit/shadow-source-vars-not-enabled.test.ts).
 */
const warnedSourceValues = new Set<string>();
export function isProductionSource(name: string, raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return false;
  if (v === 'production') return true;
  if (!warnedSourceValues.has(`${name}=${v}`)) {
    warnedSourceValues.add(`${name}=${v}`);
    console.warn(`[Shadow] ${name}='${raw}' is not 'production'; the switch is off`);
  }
  return false;
}

/** What a sample was scored against: the shadow router's placeholder 200, or a real production response */
export const ShadowBaselineSchema = z.enum(['placeholder', 'production']);

export const ShadowSampleSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    score: z.number().min(0).max(100),
    matched: z.boolean(),
    diffs: z
      .array(
        z
          .object({
            // The comparator's four diff kinds: an open string would let one caller grow byType without bound (review S5)
            type: z.enum(['status', 'header', 'body', 'performance']),
            severity: z.enum(['error', 'warning', 'info']),
          })
          .strict()
      )
      .max(SHADOW_MAX_DIFFS_PER_SAMPLE)
      .default([]),
    // Optional so a sender that does not know the field is read as the conservative value
    baseline: ShadowBaselineSchema.default('placeholder'),
  })
  .strict();

export const ShadowSamplesRequestSchema = z
  .object({ samples: z.array(ShadowSampleSchema).min(1).max(SHADOW_MAX_SAMPLES_PER_POST) })
  .strict();

export const ShadowVerdictStatusSchema = z.enum(['pending', 'pass', 'fail']);

export const ShadowSamplesResultSchema = z
  .object({
    sampleCount: z.number().int().nonnegative(),
    productionCount: z.number().int().nonnegative(),
    averageScore: z.number(),
    productionAverageScore: z.number().nullable(),
    matchedCount: z.number().int().nonnegative(),
    verdict: ShadowVerdictStatusSchema,
    capped: z.boolean(),
  })
  .strict();

export type ShadowSample = z.infer<typeof ShadowSampleSchema>;
export type ShadowSamplesRequest = z.infer<typeof ShadowSamplesRequestSchema>;
export type ShadowVerdictStatus = z.infer<typeof ShadowVerdictStatusSchema>;
export type ShadowSamplesResult = z.infer<typeof ShadowSamplesResultSchema>;

/** `pending` below the minimum sample count, else `pass` at or above the pass score, else `fail`. Pure. */
export function shadowVerdict(sampleCount: number, averageScore: number, minSamples: number = shadowMinSamples()): ShadowVerdictStatus {
  if (sampleCount < minSamples) return 'pending';
  return averageScore >= SHADOW_PASS_SCORE ? 'pass' : 'fail';
}

export const SHADOW_SAMPLES_PATH = (candidateId: string) => `/api/candidates/${encodeURIComponent(candidateId)}/shadow-samples`;

/**
 * Near-miss records (ADR 0005; docs/M5A-2-GOVERNANCE-PLAN.md PR-B). A losing candidate is not discarded: the loss is kept as a
 * fact with its evidence, written by the Spec DO in the same transaction as the write that records the loss.
 *
 * `near_misses.reason` is free text in the schema (a CHECK could not be widened later without a rebuild, which the rollback floor
 * forbids), so this list is the one place the allowed values live: the writer validates against it and the read route filters
 * with it. A typo would otherwise store an unreadable fact and defeat the redelivery dedupe, whose unique key includes `reason`.
 */
import { z } from 'zod';

export const NEAR_MISS_REASONS = ['trial_loss', 'gate_fail', 'train_drop', 'slo_rollback', 'tournament_loss'] as const;
export const NearMissReasonSchema = z.enum(NEAR_MISS_REASONS);
export type NearMissReason = z.infer<typeof NearMissReasonSchema>;

/** Evidence above this many characters (serialised) is replaced by a marker, never stored truncated mid-JSON. */
export const MAX_NEAR_MISS_EVIDENCE_CHARS = 8192;

export interface NearMiss {
  id: string;
  specId: string;
  candidateId: string;
  reason: NearMissReason;
  rung: string | null;
  lostToCandidateId: string | null;
  trialId: string | null;
  /** The trial, gate run, tournament, merge train or deploy ref the loss came from */
  sourceRef: string;
  evidence: unknown;
  complexityDelta: number | null;
  createdAt: number;
}

export const NearMissQuerySchema = z
  .object({
    specId: z.string().min(1).max(128).optional(),
    candidateId: z.string().min(1).max(128).optional(),
    reason: NearMissReasonSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

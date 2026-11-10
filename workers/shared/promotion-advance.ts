/**
 * `advance`: the one place a candidate moves up the oracle ladder (Spec DO route POST /api/candidates/:id/advance).
 *
 * Stage reading (docs/GOVERNANCE-STATE-MACHINES.md table (c)): `candidates.stage = passed_X` means "passed rung X". A candidate at `pending`
 * is running the pre-merge rung, at `passed_premerge` the shadow rung, and so on. `advance(toRung)` leaves the rung the candidate is on,
 * so it needs the evidence for THAT rung, and writes the stage of the rung just passed. This module is pure: the Spec DO computes the
 * decision inside the write transaction, a client reads the same constants, so the rules cannot drift.
 *
 * Spec: docs/plans/promotion-gaps-plan.md sections 3.4, 11 (B1, B5), 12 (V3, V12, V13 and flip-readiness).
 */

import { z } from 'zod';

export const RungSchema = z.enum(['pre-merge', 'shadow', 'train', 'canary', 'full']);
export type Rung = z.infer<typeof RungSchema>;

/** The rungs a candidate can move INTO: pre-merge is where every candidate starts */
export const AdvanceToRungSchema = z.enum(['shadow', 'train', 'canary', 'full']);
export type AdvanceToRung = z.infer<typeof AdvanceToRungSchema>;

export const AdvanceRequestSchema = z
  .object({
    toRung: AdvanceToRungSchema,
    /** The rung the caller believes the candidate is on; a mismatch is a 409 `stale_from_rung` */
    fromRung: RungSchema.optional(),
    /** Check everything, write nothing (no stage, no history, no governance event) */
    dryRun: z.boolean().optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();
export type AdvanceRequest = z.infer<typeof AdvanceRequestSchema>;

/** Ladder order of the stages that mean "still moving up" */
export const ADVANCE_STAGE_ORDER = ['pending', 'passed_premerge', 'passed_shadow', 'passed_train', 'passed_canary', 'promoted'] as const;
export type AdvanceStage = (typeof ADVANCE_STAGE_ORDER)[number];

/** The stage a candidate has after `advance(toRung)`: the rung before it was passed (`full` ends at `promoted`) */
export const TARGET_STAGE: Record<AdvanceToRung, AdvanceStage> = {
  shadow: 'passed_premerge',
  train: 'passed_shadow',
  canary: 'passed_train',
  full: 'promoted',
};

/** The rung a candidate leaves by moving to `toRung`: its evidence is what `advance` checks */
export const LEAVING_RUNG: Record<AdvanceToRung, EvidenceRung> = {
  shadow: 'pre-merge',
  train: 'shadow',
  canary: 'train',
  full: 'canary',
};

export type EvidenceRung = 'pre-merge' | 'shadow' | 'train' | 'canary';
export type EvidenceMode = 'enforce' | 'log';

/**
 * Whether missing evidence refuses the move (`enforce`) or is only recorded as a governance event (`log`). Flipping a rung to
 * enforce is a one-line change here and nothing else (plan section 12, flip-readiness):
 * - shadow: log until the shadow router mirrors shadow-rung candidates against a real production baseline (OPEN-QUESTIONS 2026-11-10);
 * - train: log until a tournament-mode writer of train evidence exists (maintainer decision 5).
 */
export const EVIDENCE_MODE: Record<EvidenceRung, EvidenceMode> = {
  'pre-merge': 'enforce',
  shadow: 'log',
  train: 'log',
  canary: 'enforce',
};

export type EvidenceStatus = 'met' | 'missing' | 'failed';

export interface EvidenceResult {
  rung: EvidenceRung;
  status: EvidenceStatus;
  mode: EvidenceMode;
  /** What was found or what is needed, for the 409 body and the governance event */
  detail?: string;
}

/** 409 codes. `candidate_not_found` is the coded 404 (the old-Spec-DO-vs-unknown-candidate split, plan B5) */
export const ADVANCE_CODES = ['stale_from_rung', 'not_next_rung', 'evidence_missing'] as const;
export type AdvanceCode = (typeof ADVANCE_CODES)[number];

/** The rung a candidate is on, from its stage; null for a stage that cannot move (`failed`, `rolled_back`) */
export function currentRungOf(stage: string): Rung | null {
  switch (stage) {
    case 'pending':
      return 'pre-merge';
    case 'passed_premerge':
      return 'shadow';
    case 'passed_shadow':
      return 'train';
    case 'passed_train':
      return 'canary';
    case 'passed_canary':
    case 'promoted':
      return 'full';
    default:
      return null;
  }
}

export type AdvanceDecision =
  | { kind: 'noop' }
  | { kind: 'refuse'; code: Exclude<AdvanceCode, 'evidence_missing'>; message: string }
  | { kind: 'go'; leaving: EvidenceRung; writes: AdvanceStage[] };

/**
 * Pure step 2-4 of the route (the DO adds the 404 first and the evidence check after). Order matters: a redelivery of a move that already
 * happened is a no-op BEFORE the fromRung check, because after the move the candidate's rung differs from the caller's `fromRung`.
 */
export function decideAdvance(stage: string, toRung: AdvanceToRung, fromRung?: Rung): AdvanceDecision {
  const target = TARGET_STAGE[toRung];
  if (stage === target) return { kind: 'noop' };

  const current = currentRungOf(stage);
  if (current === null) {
    return { kind: 'refuse', code: 'not_next_rung', message: `Candidate is ${stage}: a failed or rolled-back candidate must pass the rungs again with a new commit` };
  }
  // `passed_canary` is on rung `full` by the stage reading, but a caller promoting a canary says `canary`: that is the rung being left, not stale
  const leavingCanary = stage === 'passed_canary' && toRung === 'full' && fromRung === 'canary';
  if (fromRung !== undefined && fromRung !== current && !leavingCanary) {
    return { kind: 'refuse', code: 'stale_from_rung', message: `Candidate is on rung ${current} (stage ${stage}), not ${fromRung}` };
  }

  const at = ADVANCE_STAGE_ORDER.indexOf(stage as AdvanceStage);
  const legalFrom: AdvanceStage[] =
    toRung === 'full' ? ['passed_train', 'passed_canary'] : [ADVANCE_STAGE_ORDER[ADVANCE_STAGE_ORDER.indexOf(target) - 1]];
  if (!legalFrom.includes(ADVANCE_STAGE_ORDER[at])) {
    const direction = at >= ADVANCE_STAGE_ORDER.indexOf(target) ? 'backwards' : 'ahead';
    return { kind: 'refuse', code: 'not_next_rung', message: `Cannot move to ${toRung} from stage ${stage}: that is ${direction}, not the next rung` };
  }

  // `full` writes passed_canary (if it is not there yet) and then promoted: promoted is reachable only from passed_canary
  const writes: AdvanceStage[] = toRung === 'full' && stage === 'passed_train' ? ['passed_canary', 'promoted'] : [target];
  return { kind: 'go', leaving: LEAVING_RUNG[toRung], writes };
}

/** Not strict on purpose: a response field added later must not make a not-yet-updated reader reject a successful advance (AGENTS.md mixed-version rule) */
export const AdvanceResultSchema = z
  .object({
    /** The rung the candidate was on before this call */
    fromRung: RungSchema.nullable(),
    toRung: AdvanceToRungSchema,
    /** The stage after this call (the unchanged stage on a no-op or a dry run) */
    stage: z.string(),
    previousStage: z.string(),
    noop: z.boolean(),
    dryRun: z.boolean(),
    /** Stages written, or that a dry run would write */
    writes: z.array(z.string()),
    evidence: z.array(
      z.object({ rung: z.enum(['pre-merge', 'shadow', 'train', 'canary']), status: z.enum(['met', 'missing', 'failed']), mode: z.enum(['enforce', 'log']), detail: z.string().optional() })
    ),
  });
export type AdvanceResult = z.infer<typeof AdvanceResultSchema>;

export const ADVANCE_PATH = (candidateId: string) => `/api/candidates/${encodeURIComponent(candidateId)}/advance`;

/** governance_events.event for log-mode evidence that is missing (never refuses; one row per candidate, rung and hour) */
export const EVIDENCE_MISSING_EVENT = 'evidence_missing';

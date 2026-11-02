/**
 * Tournament state machine and optimistic-concurrency vocabulary for the promotion ledger.
 *
 * Pure functions shared by the Spec DO (which enforces them in the same transaction as the
 * write) and its clients, so the rules cannot drift.
 *
 *   pending -> in_progress   needs at least 2 competing candidates
 *   in_progress -> completed needs a winner (one of the candidates) and completedAt
 *   in_progress -> failed    needs failureReason; the DO counts the failure in `attempts`
 *   failed -> in_progress    retry, while attempts < MAX_TOURNAMENT_ATTEMPTS
 *   failed -> pending        reset (the candidate set changed, or a human intervened): attempts return to 0
 *   completed                terminal
 * Writing the current status again is always allowed (idempotent).
 *
 * Spec: AGENTS.md#state-management (train state lives in the Spec DO)
 */

import type { PromotionState, TournamentRecord } from './promotion-ledger';

export const MAX_TOURNAMENT_ATTEMPTS = 3;

/** Request header carrying the version the caller last read; the write applies only if it still matches. */
export const EXPECTED_VERSION_HEADER = 'X-Expected-Version';

/** `code` values on a 409 body. */
export const VERSION_CONFLICT = 'version_conflict';
export const VERSION_REQUIRED = 'version_required';
export const INVALID_TRANSITION = 'invalid_transition';
export const RETRIES_EXHAUSTED = 'retries_exhausted';

type Status = TournamentRecord['status'];

const ALLOWED: Record<Status, readonly Status[]> = {
  pending: ['pending', 'in_progress'],
  in_progress: ['in_progress', 'completed', 'failed'],
  completed: ['completed'],
  failed: ['failed', 'in_progress', 'pending'],
};

export interface TransitionViolation {
  code: typeof INVALID_TRANSITION | typeof RETRIES_EXHAUSTED;
  message: string;
}

/**
 * Null when `next` may be written over `prev` (null = the record does not exist yet).
 * `attempts` is the failure count stored on `prev`.
 */
export function checkTournamentTransition(
  prev: TournamentRecord | null,
  next: TournamentRecord,
  attempts: number
): TransitionViolation | null {
  const violation = (message: string): TransitionViolation => ({ code: INVALID_TRANSITION, message });

  if (prev === null) {
    return next.status === 'pending' ? null : violation(`a new tournament starts 'pending', not '${next.status}'`);
  }
  if (!ALLOWED[prev.status].includes(next.status)) {
    return violation(`tournament cannot go from '${prev.status}' to '${next.status}'`);
  }
  if (next.status === prev.status) return null;

  switch (next.status) {
    case 'in_progress': {
      if (prev.status === 'failed' && attempts >= MAX_TOURNAMENT_ATTEMPTS) {
        return {
          code: RETRIES_EXHAUSTED,
          message: `tournament failed ${attempts} times (limit ${MAX_TOURNAMENT_ATTEMPTS}); reset it to 'pending' to start over`,
        };
      }
      const competing = next.candidates.filter((c) => c.status === 'competing').length;
      return competing >= 2 ? null : violation(`needs at least 2 competing candidates to start (has ${competing})`);
    }
    case 'completed': {
      if (!next.winner) return violation("'completed' needs a winner");
      if (!next.candidates.some((c) => c.candidateId === next.winner)) {
        return violation(`winner '${next.winner}' is not a candidate of this tournament`);
      }
      return next.completedAt ? null : violation("'completed' needs completedAt");
    }
    case 'failed':
      return next.failureReason ? null : violation("'failed' needs failureReason");
    default:
      return null;
  }
}

// ============================================================================
// Promotion-state status (docs/GOVERNANCE-STATE-MACHINES.md table (d)). Log-only since PR-S:
// the Spec DO computes this on every promotion-state write and records a violation in
// governance_events instead of refusing (docs/plans/pr-s-state-machine-plan.md).
//
//   pending -> in_progress | cancelled
//   in_progress -> completed | failed | rolled_back | cancelled
//   failed -> in_progress | pending
//   completed, rolled_back, cancelled  terminal
// A new record starts 'pending'. Writing the current status again is always allowed.
// ============================================================================

/**
 * A transition-table violation: a superset of TransitionViolation, so a later enforce step can
 * answer it as the same coded 409. `enforceable` is false for edges that must never be refused
 * (into rolled_back or failed: AGENTS.md rule 7, failures and rollbacks always land).
 */
export interface GovernanceViolation extends TransitionViolation {
  code: typeof INVALID_TRANSITION;
  machine: 'candidate_stage' | 'promotion_state';
  rule: string;
  /** null = the record is being created */
  from: string | null;
  to: string;
  enforceable: boolean;
}

/**
 * Whether an enforce step may ever refuse a write into `to`, for both the candidate-stage and the
 * promotion-state machines. Never for rolled_back or failed, from any state (terminal ones included,
 * e.g. completed -> failed, cancelled -> rolled_back): rollbacks and failures always land (AGENTS.md
 * rule 7, rollback is a ref operation as cheap as promotion), so those edges stay log-only permanently.
 * Same-state writes are never violations at all.
 */
export function isEnforceable(to: string): boolean {
  return to !== 'rolled_back' && to !== 'failed';
}

type PromotionStatus = PromotionState['status'];

/** Exported as test data (the drift test compares it with the zod enum); the module is reachable from the Spec DO. */
export const PROMOTION_STATUSES: readonly PromotionStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'rolled_back', 'cancelled'];

const PROMOTION_ALLOWED: Record<PromotionStatus, readonly PromotionStatus[]> = {
  pending: ['pending', 'in_progress', 'cancelled'],
  in_progress: ['in_progress', 'completed', 'failed', 'rolled_back', 'cancelled'],
  failed: ['failed', 'in_progress', 'pending'],
  completed: ['completed'],
  rolled_back: ['rolled_back'],
  cancelled: ['cancelled'],
};

const PROMOTION_TERMINAL: readonly string[] = ['completed', 'rolled_back', 'cancelled'];

export type PromotionStateRule = 'initial_not_pending' | 'terminal' | 'not_allowed';

/** Null when `next` may be written over `prev` (null = create). Never throws. */
export function checkPromotionStateTransition(prev: string | null, next: string): GovernanceViolation | null {
  const violation = (rule: PromotionStateRule, message: string): GovernanceViolation => ({
    code: INVALID_TRANSITION,
    machine: 'promotion_state',
    rule,
    from: prev,
    to: next,
    enforceable: isEnforceable(next),
    message,
  });
  if (prev === null) {
    return next === 'pending' ? null : violation('initial_not_pending', `a new promotion state starts 'pending', not '${next}'`);
  }
  if (prev === next) return null;
  const allowed = (PROMOTION_ALLOWED as Record<string, readonly string[] | undefined>)[prev];
  if (allowed?.includes(next)) return null;
  if (PROMOTION_TERMINAL.includes(prev)) return violation('terminal', `promotion state '${prev}' is terminal; cannot go to '${next}'`);
  return violation('not_allowed', `promotion state cannot go from '${prev}' to '${next}'`);
}

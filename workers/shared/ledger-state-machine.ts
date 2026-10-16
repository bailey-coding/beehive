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

import type { TournamentRecord } from './promotion-ledger';

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

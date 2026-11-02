/**
 * Governance state machines (docs/GOVERNANCE-STATE-MACHINES.md). Pure functions shared by the Spec DO,
 * which computes them in the same transaction as the write, and its clients, so the rules cannot drift.
 *
 * PR-S ships table (c), candidate stage, as LOG-ONLY: the DO records a violation as an
 * `invalid_transition` row in governance_events and never refuses (docs/plans/pr-s-state-machine-plan.md).
 * Table (d), promotion-state status, lives beside the tournament machine in ledger-state-machine.ts.
 * Tables (a) approvals, (b) policy mode and (e) intent land with the PRs that add their writers
 * (PR-D, PR-F, PR-G), so no helper here is reachable only from tests.
 *
 *   pending          -> passed_premerge | failed
 *   passed_premerge  -> passed_shadow | failed
 *   passed_shadow    -> passed_train | failed
 *   passed_train     -> passed_canary | failed | rolled_back
 *   passed_canary    -> promoted | failed | rolled_back
 *   promoted         -> rolled_back
 *   failed           -> passed_premerge (sandbox execute only)
 *   rolled_back      -> passed_premerge (sandbox execute only) | failed
 * Writing the current stage again is always allowed (idempotent).
 *
 * Spec: docs/M5A-2-GOVERNANCE-PLAN.md PR-S; AGENTS.md rule 7 (rollback is never gated)
 */

import { INVALID_TRANSITION, type GovernanceViolation } from './ledger-state-machine';

export { INVALID_TRANSITION, checkPromotionStateTransition, type GovernanceViolation } from './ledger-state-machine';

/** governance_events.event for a transition-table violation (frozen name, M5A-2 plan rev 3 S9) */
export const INVALID_TRANSITION_EVENT = 'invalid_transition';
/** Flood control: at most one row per (subject, reason) per window ... */
export const INVALID_TRANSITION_WINDOW_MS = 60 * 60 * 1000;
/** ... and at most this many invalid_transition rows per window overall (the table is never purged). */
export const INVALID_TRANSITION_CAP_PER_WINDOW = 100;
/** UTF-8 bytes of governance_events.detail; a larger detail is replaced by a truncation marker. */
export const MAX_GOVERNANCE_DETAIL_BYTES = 2048;

export const CANDIDATE_STAGES = [
  'pending', 'passed_premerge', 'passed_shadow', 'passed_train', 'passed_canary', 'promoted', 'failed', 'rolled_back',
] as const;
export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

/** Ladder order, for skip-ahead and backward detection. failed and rolled_back are off the ladder. */
export const CANDIDATE_LADDER: readonly CandidateStage[] = [
  'pending', 'passed_premerge', 'passed_shadow', 'passed_train', 'passed_canary', 'promoted',
];

/** What caused the write. A stage PATCH carries no rung or commit, so it is 'stage_patch'. */
export type CandidateWriteSource = 'stage_patch' | 'execute_pass' | 'execute_error';
export interface CandidateTransitionContext {
  source: CandidateWriteSource;
}

export type CandidateRule =
  | 'unknown_stage' // from or to outside CANDIDATE_STAGES (an enforce step must check before the UPDATE)
  | 'promoted_exit' // out of promoted to anything but rolled_back (re-execute included)
  | 'promote_not_from_canary' // into promoted from anything but passed_canary
  | 'rollback_before_train' // into rolled_back from a stage below passed_train, or from failed
  | 'reset_needs_execute' // failed/rolled_back -> passed_premerge not through sandbox execute
  | 'skip_ahead' // forward by more than one ladder step
  | 'backward' // to a lower ladder stage
  | 'not_allowed'; // any other edge (e.g. failed -> passed_shadow)

export const CANDIDATE_RULES: readonly CandidateRule[] = [
  'unknown_stage', 'promoted_exit', 'promote_not_from_canary', 'rollback_before_train',
  'reset_needs_execute', 'skip_ahead', 'backward', 'not_allowed',
];

const ALLOWED: Record<CandidateStage, readonly CandidateStage[]> = {
  pending: ['passed_premerge', 'failed'],
  passed_premerge: ['passed_shadow', 'failed'],
  passed_shadow: ['passed_train', 'failed'],
  passed_train: ['passed_canary', 'failed', 'rolled_back'],
  passed_canary: ['promoted', 'failed', 'rolled_back'],
  promoted: ['rolled_back'],
  failed: [],
  rolled_back: ['failed'],
};

/** Edges allowed only when the write is a sandbox-execute pass (a re-execute with a new run). */
const EXECUTE_ONLY: Partial<Record<CandidateStage, readonly CandidateStage[]>> = {
  failed: ['passed_premerge'],
  rolled_back: ['passed_premerge'],
};

const isStage = (s: string): s is CandidateStage => (CANDIDATE_STAGES as readonly string[]).includes(s);

/**
 * Whether an enforce step may ever refuse a write into `to`. Never for rolled_back or failed:
 * rollbacks and failures always land (AGENTS.md rule 7); they stay log-only permanently.
 * Same-state writes are never violations at all.
 */
export function isEnforceable(to: string): boolean {
  return to !== 'rolled_back' && to !== 'failed';
}

function ruleFor(from: CandidateStage, to: CandidateStage): CandidateRule {
  if (from === 'promoted') return 'promoted_exit';
  if (to === 'promoted') return 'promote_not_from_canary';
  if (to === 'rolled_back') return 'rollback_before_train';
  if (to === 'passed_premerge' && EXECUTE_ONLY[from]?.includes(to)) return 'reset_needs_execute';
  const a = CANDIDATE_LADDER.indexOf(from);
  const b = CANDIDATE_LADDER.indexOf(to);
  if (a >= 0 && b >= 0) {
    if (b > a + 1) return 'skip_ahead';
    if (b < a) return 'backward';
  }
  return 'not_allowed';
}

/**
 * Null when `to` may be written over `from`. Same-state is always null. Pure, and never throws:
 * an unknown stage yields 'unknown_stage'.
 */
export function checkCandidateTransition(
  from: string,
  to: string,
  ctx: CandidateTransitionContext
): GovernanceViolation | null {
  if (from === to) return null;
  const violation = (rule: CandidateRule, message: string): GovernanceViolation => ({
    code: INVALID_TRANSITION,
    machine: 'candidate_stage',
    rule,
    from,
    to,
    enforceable: isEnforceable(to),
    message,
  });
  if (!isStage(from) || !isStage(to)) {
    return violation('unknown_stage', `unknown candidate stage in '${from}' -> '${to}'`);
  }
  if (ALLOWED[from].includes(to)) return null;
  if (ctx.source === 'execute_pass' && EXECUTE_ONLY[from]?.includes(to)) return null;
  return violation(ruleFor(from, to), `candidate cannot go from '${from}' to '${to}' (${ctx.source})`);
}

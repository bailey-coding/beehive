/**
 * Pure transition tables: candidate stage (docs/GOVERNANCE-STATE-MACHINES.md table (c)) and promotion-state status
 * (table (d)). The expected matrices below are written from the doc, independent of the module's ALLOWED data, so a
 * typo in either side fails.
 *
 * Task: pr-s | Spec: docs/plans/pr-s-state-machine-plan.md sections 3 and 8
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANDIDATE_STAGES,
  CANDIDATE_RULES,
  checkCandidateTransition,
  checkPromotionStateTransition,
  isEnforceable,
  INVALID_TRANSITION,
  type CandidateWriteSource,
} from '../../shared/governance-state-machine';
import { PROMOTION_STATUSES } from '../../shared/ledger-state-machine';
import { CandidateStageSchema } from '../../shared/schemas';
import { PromotionStateSchema } from '../../shared/promotion-ledger';

// Columns, in order: pending, passed_premerge, passed_shadow, passed_train, passed_canary, promoted, failed, rolled_back.
// '.' = allowed; otherwise the rule. RNE cells are allowed only for a sandbox-execute pass.
const COLS = ['pending', 'passed_premerge', 'passed_shadow', 'passed_train', 'passed_canary', 'promoted', 'failed', 'rolled_back'];
const A = '.', SKIP = 'skip_ahead', BACK = 'backward', PNFC = 'promote_not_from_canary', EXIT = 'promoted_exit',
  RBT = 'rollback_before_train', RNE = 'reset_needs_execute', NA = 'not_allowed';
const MATRIX: Record<string, string[]> = {
  pending:         [A,    A,    SKIP, SKIP, SKIP, PNFC, A,    RBT],
  passed_premerge: [BACK, A,    A,    SKIP, SKIP, PNFC, A,    RBT],
  passed_shadow:   [BACK, BACK, A,    A,    SKIP, PNFC, A,    RBT],
  passed_train:    [BACK, BACK, BACK, A,    A,    PNFC, A,    A],
  passed_canary:   [BACK, BACK, BACK, BACK, A,    A,    A,    A],
  promoted:        [EXIT, EXIT, EXIT, EXIT, EXIT, A,    EXIT, A],
  failed:          [NA,   RNE,  NA,   NA,   NA,   PNFC, A,    RBT],
  rolled_back:     [NA,   RNE,  NA,   NA,   NA,   PNFC, A,    A],
};
const SOURCES: CandidateWriteSource[] = ['stage_patch', 'execute_pass', 'execute_error'];

describe('candidate stage table (c)', () => {
  const cells = Object.entries(MATRIX).flatMap(([from, row]) =>
    row.flatMap((cell, i) => SOURCES.map((source) => ({ from, to: COLS[i], source, cell })))
  );

  it.each(cells)('$from -> $to ($source): $cell', ({ from, to, source, cell }) => {
    const v = checkCandidateTransition(from, to, { source });
    const expected = cell === RNE && source === 'execute_pass' ? A : cell;
    if (expected === A) {
      expect(v).toBeNull();
    } else {
      expect(v).toMatchObject({ code: INVALID_TRANSITION, machine: 'candidate_stage', rule: expected, from, to });
      expect(typeof v!.message).toBe('string');
    }
  });

  it('every cell of the 8x8 matrix has a defined outcome from the closed rule set', () => {
    for (const from of CANDIDATE_STAGES) for (const to of CANDIDATE_STAGES) {
      const v = checkCandidateTransition(from, to, { source: 'stage_patch' });
      if (v) expect(CANDIDATE_RULES).toContain(v.rule);
    }
  });

  it('same-state writes are always allowed, for every stage and source', () => {
    for (const s of CANDIDATE_STAGES) for (const source of SOURCES) expect(checkCandidateTransition(s, s, { source })).toBeNull();
  });

  it('enforceable is false for every edge into rolled_back or failed and true otherwise (rule 7: rollbacks and failures always land)', () => {
    for (const from of CANDIDATE_STAGES) for (const to of CANDIDATE_STAGES) for (const source of SOURCES) {
      const v = checkCandidateTransition(from, to, { source });
      if (v) expect(v.enforceable, `${from}->${to}`).toBe(to !== 'rolled_back' && to !== 'failed');
    }
    expect(checkCandidateTransition('promoted', 'failed', { source: 'execute_error' })).toMatchObject({ rule: EXIT, enforceable: false });
    expect(checkCandidateTransition('pending', 'rolled_back', { source: 'stage_patch' })).toMatchObject({ rule: RBT, enforceable: false });
    expect(checkCandidateTransition('pending', 'passed_train', { source: 'stage_patch' })).toMatchObject({ enforceable: true });
    expect(isEnforceable('rolled_back')).toBe(false);
    expect(isEnforceable('failed')).toBe(false);
    expect(isEnforceable('promoted')).toBe(true);
  });

  it('unknown stages give unknown_stage and never throw', () => {
    expect(checkCandidateTransition('pending', 'bogus', { source: 'stage_patch' })).toMatchObject({ rule: 'unknown_stage' });
    expect(checkCandidateTransition('bogus', 'pending', { source: 'stage_patch' })).toMatchObject({ rule: 'unknown_stage' });
    expect(() => checkCandidateTransition(undefined as never, null as never, { source: 'stage_patch' })).not.toThrow();
  });

  it('CANDIDATE_STAGES equals the zod enum and the schema CHECK (no drift)', () => {
    expect([...CANDIDATE_STAGES]).toEqual(CandidateStageSchema.options);
    const sql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
    const check = sql.match(/CREATE TABLE IF NOT EXISTS candidates[\s\S]*?stage TEXT DEFAULT 'pending' CHECK\(stage IN \(([\s\S]*?)\)\)/);
    expect(check).not.toBeNull();
    expect(check![1].match(/'([a-z_]+)'/g)!.map((s) => s.slice(1, -1))).toEqual([...CANDIDATE_STAGES]);
  });
});

// Columns: pending, in_progress, completed, failed, rolled_back, cancelled
const PCOLS = ['pending', 'in_progress', 'completed', 'failed', 'rolled_back', 'cancelled'];
const T = 'terminal', I = 'initial_not_pending';
const PMATRIX: Record<string, string[]> = {
  none:        [A,  I,  I,  I,  I,  I],
  pending:     [A,  A,  NA, NA, NA, A],
  in_progress: [NA, A,  A,  A,  A,  A],
  failed:      [A,  A,  NA, A,  NA, NA],
  completed:   [T,  T,  A,  T,  T,  T],
  rolled_back: [T,  T,  T,  T,  A,  T],
  cancelled:   [T,  T,  T,  T,  T,  A],
};

describe('promotion-state status table (d)', () => {
  const cells = Object.entries(PMATRIX).flatMap(([from, row]) => row.map((cell, i) => ({ from, to: PCOLS[i], cell })));

  it.each(cells)('$from -> $to: $cell', ({ from, to, cell }) => {
    const prev = from === 'none' ? null : from;
    const v = checkPromotionStateTransition(prev, to);
    if (cell === A) expect(v).toBeNull();
    else expect(v).toMatchObject({ code: INVALID_TRANSITION, machine: 'promotion_state', rule: cell, from: prev, to, enforceable: to !== 'rolled_back' && to !== 'failed' });
  });

  it('PROMOTION_STATUSES is the zod enum, cancelled included', () => {
    expect([...PROMOTION_STATUSES]).toEqual(PromotionStateSchema.shape.status.options);
  });

  it('never throws on unknown input', () => {
    expect(checkPromotionStateTransition('bogus', 'pending')).toMatchObject({ rule: 'not_allowed' });
  });
});

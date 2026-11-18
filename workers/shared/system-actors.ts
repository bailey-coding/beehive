/**
 * Reserved system actors (docs/plans/wave-1-plan.md part B, reviews b1 M2 and b2 M1). Workers write gate verdicts under these fixed
 * ids, and gate_verdicts.decided_by references actors(id), so the Spec DO creates the row lazily, inside the write, the first time an
 * id is used. The ids are fixed strings that createActor (UUIDs) can never produce. The rows are agents with no promotion authority,
 * and the Spec DO refuses to give them a role or authority.
 *
 * No imports: the Spec DO and every worker can import this without the shared postinstall.
 */
export const SYSTEM_ACTORS: Readonly<Record<string, string>> = Object.freeze({
  'queue-consumer': 'queue consumer (service)',
  'promotion-worker': 'promotion worker (service)',
  'scientist-comparator': 'scientist comparator (service)',
});

export function isSystemActor(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(SYSTEM_ACTORS, id);
}

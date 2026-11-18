/**
 * Reserved system actors (docs/plans/wave-1-plan.md part B, reviews b1 M2, b2 M1): a gate verdict decided by queue-consumer or
 * promotion-worker gets its actor row on first use, in the same transaction as the verdict, on a ledger without the dev seed; any other
 * unknown decided_by is still refused by the foreign key; a system actor cannot be given a role or promotion authority.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import type { SpecDO } from '../index';
import { isSystemActor, SYSTEM_ACTORS } from '../../shared/system-actors';

let store: SqliteState;
let spec: SpecDO;
let candidateId: string;
let agent: string;

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  agent = spec.createActor('agent', 'a').id;
  const org = spec.createOrganization('acme', 'artifacts');
  const repo = spec.createRepository('r', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'acme');
  const s = spec.createSpec('s', 'd', '{}', [], org.id, agent);
  candidateId = spec.createCandidate(s.id, repo.id, 'c'.repeat(40), 'base', agent).id;
});

const actorRows = (id: string) => store.raw.prepare('SELECT id, type, promotion_authority, role FROM actors WHERE id = ?').all(id) as Record<string, unknown>[];
const verdictRows = () => (store.raw.prepare('SELECT COUNT(*) AS n FROM gate_verdicts').get() as { n: number }).n;

function postVerdict(decidedBy: string, opts: { key?: string; candidate?: string } = {}) {
  return spec.fetch(
    new Request('https://spec-do.internal/api/gate-verdicts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': decidedBy, ...(opts.key ? { 'Idempotency-Key': opts.key } : {}) },
      body: JSON.stringify({ candidateId: opts.candidate ?? candidateId, gate: 'pre-merge', status: 'pass', score: 90, complexityDelta: 0, decidedBy }),
    })
  );
}

describe('gate verdicts decided by a reserved system actor', () => {
  it.each([['queue-consumer'], ['promotion-worker']])('%s: 201 on a ledger with no such actor, one agent row with no authority, created once', async (id) => {
    expect(actorRows(id)).toHaveLength(0);
    expect((await postVerdict(id)).status).toBe(201);
    expect(actorRows(id)).toEqual([{ id, type: 'agent', promotion_authority: 0, role: null }]);
    expect((await postVerdict(id, { key: 'k2' })).status).toBe(201);
    expect(actorRows(id)).toHaveLength(1);
    expect(verdictRows()).toBe(1); // one row per (candidate, gate): the second write updates it
  });

  it('an unknown decided_by that is not a system actor is still refused, and writes nothing', async () => {
    const res = await postVerdict('not-an-actor');
    expect(res.ok).toBe(false);
    expect(actorRows('not-an-actor')).toHaveLength(0);
    expect(verdictRows()).toBe(0);
  });

  it('without an Idempotency-Key the actor row and the verdict commit together: a verdict that fails leaves no actor row', async () => {
    // An unknown candidate fails the verdict insert (candidate_id foreign key) after the actor row was inserted
    const res = await postVerdict('promotion-worker', { candidate: 'no-such-candidate' });
    expect(res.ok).toBe(false);
    expect(actorRows('promotion-worker')).toHaveLength(0);
  });
});

describe('a reserved system actor holds no role and no promotion authority', () => {
  beforeEach(async () => {
    expect((await postVerdict('queue-consumer')).status).toBe(201);
  });

  it('PATCH promotion-authority is a 403 and changes nothing', async () => {
    const res = await spec.fetch(new Request('https://spec-do.internal/api/actors/queue-consumer/promotion-authority', { method: 'PATCH' }));
    expect(res.status).toBe(403);
    expect(actorRows('queue-consumer')[0].promotion_authority).toBe(0);
  });

  it('a role grant is a 403, including the bootstrap self-grant while no maintainer exists', async () => {
    const res = await spec.fetch(
      new Request('https://spec-do.internal/internal/actors/queue-consumer/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Actor-ID': 'queue-consumer' },
        body: JSON.stringify({ role: 'maintainer' }),
      })
    );
    expect(res.status).toBe(403);
    expect(actorRows('queue-consumer')[0].role).toBeNull();
  });
});

describe('isSystemActor', () => {
  it('is true only for the reserved ids, never for another string or an inherited property name', () => {
    for (const id of Object.keys(SYSTEM_ACTORS)) expect(isSystemActor(id)).toBe(true);
    for (const id of ['not-an-actor', 'master', 'constructor', 'toString', '__proto__', '', 'Queue-Consumer']) expect(isSystemActor(id)).toBe(false);
    expect(isSystemActor(undefined)).toBe(false);
  });
});

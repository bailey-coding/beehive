/**
 * SpecDO trials: createTrial must satisfy the NOT NULL decided_at column.
 * Real SQL (node:sqlite, FKs on) through the real router.
 *
 * Task: ci-docs-tests | Spec: AGENTS.md#state-management
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';

let store: SqliteState;
let spec: SpecDO;
let agent: string;

async function setup() {
  const org = spec.createOrganization('trial-org', 'artifacts');
  const repo = spec.createRepository('trial-repo', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
  const s = spec.createSpec('trial-spec', 'd', 'contract', [], org.id, agent);
  const c1 = spec.createCandidate(s.id, repo.id, 'sha1', 'base', agent);
  const c2 = spec.createCandidate(s.id, repo.id, 'sha2', 'base', agent);
  return { s, c1, c2 };
}

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  agent = spec.createActor('agent', 'agent-1').id;
});

describe('createTrial', () => {
  it('inserts a pending trial (decided_at is NOT NULL)', async () => {
    const { s, c1, c2 } = await setup();
    const trial = spec.createTrial(s.id, c1.id, c2.id, agent);
    expect(trial.stage).toBe('pending');
    const row = store.raw.prepare('SELECT stage, decided_at, winner_id FROM trials WHERE id = ?').get(trial.id) as {
      stage: string;
      decided_at: number;
      winner_id: string | null;
    };
    expect(row.stage).toBe('pending');
    expect(row.decided_at).toBe(0);
    expect(row.winner_id).toBeNull();
  });

  it('POST /api/trials returns 201', async () => {
    const { s, c1, c2 } = await setup();
    const res = await spec.fetch(
      new Request('https://spec-do.internal/api/trials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Actor-ID': agent },
        body: JSON.stringify({ specId: s.id, candidateAId: c1.id, candidateBId: c2.id }),
      })
    );
    expect(res.status).toBe(201);
  });

  it('decideTrial sets a real decided_at', async () => {
    const { s, c1, c2 } = await setup();
    const trial = spec.createTrial(s.id, c1.id, c2.id, agent);
    spec.decideTrial(trial.id, c1.id, { score: 1 }, agent);
    const row = store.raw.prepare('SELECT stage, decided_at FROM trials WHERE id = ?').get(trial.id) as {
      stage: string;
      decided_at: number;
    };
    expect(row.stage).toBe('decided');
    expect(row.decided_at).toBeGreaterThan(0);
  });
});

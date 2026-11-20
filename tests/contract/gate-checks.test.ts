/**
 * The simulated pre-merge gate over a real Spec DO (wave-2a-plan part C; review b2-S4, b1-S8): it refuses a spec that is not the candidate's,
 * an unknown or tombstoned candidate and a commit that is not a sha, before it runs anything, and its verdict says it was simulated and which
 * commit it was for. Real handlers (tests/contract/wire.ts): no mocked peer.
 *
 * Task: wave-2a part C | Spec: docs/plans/wave-2a-plan.md part C
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wire, API_TOKEN } from './wire';
import { GATE_WORKFLOW_ORIGIN, GATE_PRE_MERGE_PATH } from '../../workers/shared/schemas';

let w: ReturnType<typeof wire>;
let agent: string;
let orgId: string;
let n = 0;

const SHA = 'c'.repeat(40);

beforeEach(async () => {
  w = wire();
  await w.spec.init();
  n += 1;
  agent = w.spec.createActor('agent', `gate-agent-${n}`).id;
  orgId = w.spec.createOrganization(`gateorg${n}`, 'artifacts').id;
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // the simulated conformance warning is random
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

let k = 0;
function candidate(commitSha = SHA) {
  k += 1;
  const repo = w.spec.createRepository(`r${k}`, orgId, 'baseline', undefined, undefined, 'https://example.invalid/r.git', `gateorg${n}`);
  const spec = w.spec.createSpec(`s${k}`, 'd', '{}', [], orgId, agent);
  return { spec, c: w.spec.createCandidate(spec.id, repo.id, commitSha, 'b'.repeat(40), agent) };
}

const gate = (body: Record<string, unknown>) =>
  w.GATE_WORKFLOW.fetch(`${GATE_WORKFLOW_ORIGIN}${GATE_PRE_MERGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ baseCommitSha: 'b'.repeat(40), actorId: agent, ...body }),
  });
const verdicts = (candidateId: string) =>
  w.store.raw.prepare('SELECT * FROM gate_verdicts WHERE candidate_id = ?').all(candidateId) as Record<string, any>[];

describe('the gate refuses before it runs', () => {
  it.fails('a spec that is not the candidate\'s: 400 spec_mismatch, no verdict', async () => {
    const { c } = candidate();
    const other = candidate();
    const res = await gate({ candidateId: c.id, specId: other.spec.id, commitSha: SHA });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('spec_mismatch');
    expect(verdicts(c.id)).toEqual([]);
  });

  it.fails('an unknown candidate: 404, no verdict', async () => {
    const { spec } = candidate();
    const res = await gate({ candidateId: '00000000-0000-4000-8000-000000000000', specId: spec.id, commitSha: SHA });
    expect(res.status).toBe(404);
  });

  it.fails('a tombstoned candidate: 404, no verdict', async () => {
    const { spec, c } = candidate();
    w.store.raw.prepare('UPDATE candidates SET deleted_at = 1 WHERE id = ?').run(c.id);
    const res = await gate({ candidateId: c.id, specId: spec.id, commitSha: SHA });
    expect(res.status).toBe(404);
    expect(verdicts(c.id)).toEqual([]);
  });

  it.fails('a commit that is not 40 lowercase hex: 400, no verdict', async () => {
    const { spec, c } = candidate();
    for (const commitSha of ['not-a-sha', 'abc123', 'C'.repeat(40), `${SHA}0`]) {
      const res = await gate({ candidateId: c.id, specId: spec.id, commitSha });
      expect(res.status, commitSha).toBe(400);
    }
    expect(verdicts(c.id)).toEqual([]);
  });
});

describe('the gate runs', () => {
  it.fails('records a verdict marked simulated, for the commit it ran on, with [simulated] notes', async () => {
    const { spec, c } = candidate();
    const res = await gate({ candidateId: c.id, specId: spec.id, commitSha: SHA });
    expect(res.status).toBe(201);
    const [v] = verdicts(c.id);
    expect(v).toMatchObject({ gate: 'pre-merge', commit_sha: SHA, simulated: 1 });
    expect(v.notes).toMatch(/^\[simulated\] /);
  });

  it.fails('accepts a non-hex commit equal to the candidate\'s stored one (older candidates; the merge train sends the stored sha)', async () => {
    const { spec, c } = candidate('sha1');
    const res = await gate({ candidateId: c.id, specId: spec.id, commitSha: 'sha1' });
    expect(res.status).toBe(201);
    expect(verdicts(c.id)[0]).toMatchObject({ commit_sha: 'sha1', simulated: 1 });
  });
});

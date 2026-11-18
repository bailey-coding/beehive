/**
 * Contract tests for the three pipelines the whole-repo review found broken (docs/plans/wave-1-plan.md part A; reviews b1 M2, b2 M1/S1,
 * c M1/S7). Real handlers over one real Spec DO (tests/contract/wire.ts): a unit test with a mocked peer passed while each of these failed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wire, batch, drainingCtx, API_TOKEN } from './wire';
import { PromotionWorker } from '../../workers/promotion-worker/promotion';
import queueConsumer from '../../workers/queue-consumer/index';
import comparator from '../../workers/scientist-comparator/index';
import shadowRouter from '../../workers/shadow-router/index';
import { resetLiveRefsCache } from '../../workers/shadow-router/live-refs-cache';

let w: ReturnType<typeof wire>;
let agent: string;
let orgId: string;
let orgName: string;
let n = 0;

beforeEach(async () => {
  w = wire();
  await w.spec.init();
  n += 1;
  agent = w.spec.createActor('agent', `agent-${n}`).id;
  orgName = `acme${n}`;
  orgId = w.spec.createOrganization(orgName, 'artifacts').id;
  // The simulated gate draws a 10% conformance warning at random; pin it (plan review S6)
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetLiveRefsCache();
});

const stageOf = (id: string) => (w.store.raw.prepare('SELECT stage FROM candidates WHERE id = ?').get(id) as { stage: string }).stage;

/** A repository and candidate shaped the way claimSpec writes them: remote_url is the full Artifacts git URL */
function claimedCandidate(stage = 'pending') {
  const name = `candidate-${n}`;
  const repo = w.spec.createRepository(name, orgId, 'candidate', undefined, agent, `https://acct.artifacts.cloudflare.net/git/${orgName}/${name}.git`, orgName);
  const spec = w.spec.createSpec(`spec-${n}`, 'd', '{}', [], orgId, agent);
  const sha = `${'a'.repeat(39)}${n % 10}`;
  const candidate = w.spec.createCandidate(spec.id, repo.id, sha, 'base', agent);
  if (stage !== 'pending') w.store.raw.prepare('UPDATE candidates SET stage = ? WHERE id = ?').run(stage, candidate.id);
  return { repo, spec, candidate, name, sha };
}

describe('contract 1: promotion-worker (merge train) -> gate-workflow -> Spec DO', () => {
  // it.fails until part B (wave-1-plan): today the gate answers 500, the verdict's decided_by 'promotion-worker' is not an actor
  it.fails('a passed_shadow candidate promoted train -> canary rides a car that merges, and the gate verdict is recorded', async () => {
    const { candidate, spec } = claimedCandidate('passed_shadow');
    const worker = new PromotionWorker({
      ...w.base,
      GATE_WORKFLOW: w.GATE_WORKFLOW,
      PREVIEW_MANAGER: w.PREVIEW_MANAGER,
      ANALYTICS: { writeDataPoint: () => {} },
      PROMOTION_MODE: 'merge-train',
      MAX_CONCURRENT_CANDIDATES: '10',
    } as never);
    const res = await worker.promoteCandidate({ candidateId: candidate.id, specId: spec.id, actorId: agent, fromRung: 'train', toRung: 'canary' } as never);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.outcome).toBe('moved');
    expect(stageOf(candidate.id)).toBe('passed_train');
    expect(w.spec.listMergeTrains(spec.id)[0].candidates).toEqual([expect.objectContaining({ candidateId: candidate.id, status: 'merged' })]);
    expect(w.count(`SELECT COUNT(*) AS n FROM gate_verdicts WHERE candidate_id = ? AND decided_by = 'promotion-worker'`, candidate.id)).toBe(1);
  });
});

describe('contract 2: queue-consumer -> gate-workflow -> Spec DO', () => {
  // it.fails until parts B and D: today 'no repository found' (remote_url is the full git URL), then the same foreign key
  it.fails('a push for a claimSpec-shaped repository is acked, with one verdict by queue-consumer and one push_received history row', async () => {
    const { candidate, name, sha } = claimedCandidate();
    const b = batch('beehive-artifacts-push', [{
      event: {
        id: `evt-${n}-${Date.now()}`,
        type: 'push',
        repository: { name, namespace: orgName, full_name: `${orgName}/${name}` },
        commit: { sha },
        ref: 'refs/heads/main',
        created_at: new Date().toISOString(),
      },
      received_at: Date.now(),
    }]);
    await queueConsumer.queue(b as never, { ...w.base, GATE_WORKFLOW: w.GATE_WORKFLOW, PREVIEW_MANAGER: w.PREVIEW_MANAGER } as never, w.ctx);
    expect(b.messages[0].retry).not.toHaveBeenCalled();
    expect(b.messages[0].ack).toHaveBeenCalled();
    expect(w.count(`SELECT COUNT(*) AS n FROM gate_verdicts WHERE candidate_id = ? AND decided_by = 'queue-consumer'`, candidate.id)).toBe(1);
    expect(w.count(`SELECT COUNT(*) AS n FROM entity_history WHERE entity_id = ? AND stage = 'push_received'`, candidate.id)).toBe(1);
  });
});

const comparatorEnv = () => ({ ...w.base, ANALYTICS: { writeDataPoint: () => {} } });
const scored = (id: string) => w.count('SELECT COUNT(*) AS n FROM shadow_scores WHERE candidate_id = ?', id);

describe('contract 3: scientist-comparator -> Spec DO', () => {
  // it.fails until part C: today 'Delta surface must be an object, got undefined', acked and dropped
  it.fails.each([[[]], [['/price']]])('a candidate whose spec was stored through POST /api/specs (surface %j) gets a shadow sample', async (surface) => {
    const res = await w.direct.fetch(
      new Request('https://spec-do.internal/api/specs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Actor-ID': agent },
        body: JSON.stringify({ name: `s-${n}`, contract: '{}', declaredDeltaSurface: surface, organizationId: orgId }),
      })
    );
    expect(res.status).toBe(201);
    const specId = ((await res.json()) as { data: { id: string } }).data.id;
    const repo = w.spec.createRepository(`r-${n}`, orgId, 'baseline', undefined, undefined, 'https://example.invalid/r.git', orgName);
    const candidate = w.spec.createCandidate(specId, repo.id, 'b'.repeat(40), 'base', agent);
    const b = batch('beehive-scientist-comparisons', [{
      requestId: `req-${n}`,
      timestamp: Date.now(),
      path: '/api/:id',
      method: 'GET',
      headers: {},
      baseline: { candidateId: 'production', specId: '', status: 200, headers: {}, latencyMs: 40, kind: 'production' },
      candidates: [{ candidateId: candidate.id, specId: '', status: 200, headers: {}, latencyMs: 45 }],
    }]);
    await comparator.queue(b as never, comparatorEnv() as never, w.ctx);
    expect(b.messages[0].retry).not.toHaveBeenCalled();
    expect(scored(candidate.id)).toBe(1);
  });
});

describe('contract 4: shadow-router /mirror -> queue message -> scientist-comparator', () => {
  // it.fails until part C (the comparator drops it, as in contract 3)
  it.fails('the message the real router enqueues for a live canary is accepted by the real comparator and scored', async () => {
    const { candidate, spec, sha } = claimedCandidate('passed_train');
    const deploy = await w.direct.fetch(
      new Request('https://spec-do.internal/canary-deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Actor-ID': 'canary-worker' },
        body: JSON.stringify({
          candidateId: candidate.id, specId: spec.id, url: `https://cand-${n}.bz23711.workers.dev`, workerVersionId: `v-${n}`,
          commitSha: sha, trafficPercentage: 100, holdoutPercentage: 0,
        }),
      })
    );
    expect(deploy.status).toBe(201);
    // Candidate and baseline fetches leave the platform: the only stubbed network
    vi.stubGlobal('fetch', async () => new Response('ok', { status: 200 }));
    const sent: unknown[] = [];
    const routerEnv = {
      ...w.base,
      LIVE_REFS_CACHE_TTL_MS: '0',
      WORKERS_SUBDOMAIN: 'bz23711',
      SCIENTIST_QUEUE: { send: async (m: unknown) => void sent.push(m) },
    };
    const { ctx, drain } = drainingCtx();
    const res = await shadowRouter.fetch(
      new Request('http://router/mirror', {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, method: 'GET', path: '/api/:id' }),
      }),
      routerEnv as never,
      ctx
    );
    expect(res.status).toBe(202);
    // Stop once the comparison is queued: the canary recorder's 10 s tail flush is not part of this contract
    await drain(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    const b = batch('beehive-scientist-comparisons', [sent[0]]);
    await comparator.queue(b as never, comparatorEnv() as never, w.ctx);
    expect(b.messages[0].retry).not.toHaveBeenCalled();
    expect(scored(candidate.id)).toBe(1);
  });
});

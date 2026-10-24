/**
 * SpecDO deploy refs + canary deployments (m6 -> m7): the traffic pointer per
 * (spec, rung), canary deploy = promote move, rollback = move to the previous
 * target, both one transaction; live refs block tombstones; the migration.
 * Real SQL (node:sqlite, FKs on) through the real router.
 *
 * Task: canary-rollback | Spec: AGENTS.md#non-negotiable-architectural-rules (rule 7)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import type { CanaryDeployment, CanaryMoveResult, DeployRef, LiveRef } from '../../shared/deploy-refs';

let store: SqliteState;
let spec: SpecDO;

function call(path: string, method = 'GET', body?: unknown, actorId = 'canary-worker'): Promise<Response> {
  return spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actorId },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function deploy(candidateId: string, specId = 'spec-a', extra: Record<string, unknown> = {}): Promise<CanaryMoveResult> {
  const res = await call('/canary-deployments', 'POST', {
    candidateId,
    specId,
    url: `https://${candidateId}.example.workers.dev`,
    workerVersionId: `ver-${candidateId}`,
    commitSha: `sha-${candidateId}`,
    trafficPercentage: 10,
    holdoutPercentage: 5,
    ...extra,
  });
  expect(res.status).toBe(201);
  return data<CanaryMoveResult>(res);
}

const head = async (specId = 'spec-a') => data<DeployRef>(await call(`/deploy-refs/head?specId=${specId}&rung=canary`));
const rollbackRef = (specId = 'spec-a') =>
  call('/deploy-refs/rollback', 'POST', { specId, rung: 'canary', reason: 'manual' }, 'operator');
const deployment = async (id: string) => data<CanaryDeployment>(await call(`/canary-deployments/${id}`));
const count = (sql: string, ...params: string[]) => (store.raw.prepare(sql).get(...params) as { n: number }).n;

/** A real org -> repo -> spec -> candidate row chain, for the tombstone checks */
function seedCandidate() {
  const actor = spec.createActor('human', 'maint').id;
  const org = spec.createOrganization('org', 'artifacts');
  const repo = spec.createRepository('repo', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
  const s = spec.createSpec('spec', 'd', 'contract', [], org.id, actor);
  return { actor, spec: s, candidate: spec.createCandidate(s.id, repo.id, 'sha', 'base', actor) };
}

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
});

describe('canary deploy (promote move)', () => {
  it('records the deployment and makes it the head of the spec canary ref', async () => {
    const { deployment: d, ref } = await deploy('cand-a');
    expect(d).toMatchObject({ candidateId: 'cand-a', specId: 'spec-a', status: 'deployed', workerVersionId: 'ver-cand-a', trafficPercentage: 10, holdoutPercentage: 5, autoRollback: true, deployRefId: ref.id });
    expect(ref).toMatchObject({ specId: 'spec-a', rung: 'canary', candidateId: 'cand-a', commitSha: 'sha-cand-a', prevRefId: null, action: 'promote', movedBy: 'canary-worker' });
    expect(await head()).toEqual(ref);
  });

  it('a second canary points back at the first and supersedes it', async () => {
    const a = await deploy('cand-a');
    const b = await deploy('cand-b');
    expect(b.ref.prevRefId).toBe(a.ref.id);
    expect((await deployment(a.deployment.id)).status).toBe('superseded');
    expect((await deployment(b.deployment.id)).status).toBe('deployed');
    const chain = await data<DeployRef[]>(await call('/deploy-refs?specId=spec-a&rung=canary'));
    expect(chain.map((r) => r.candidateId)).toEqual(['cand-b', 'cand-a']);
  });

  it('keeps specs independent', async () => {
    await deploy('cand-a', 'spec-a');
    const other = await deploy('cand-x', 'spec-b');
    expect(other.ref.prevRefId).toBeNull();
    expect((await head('spec-a')).candidateId).toBe('cand-a');
  });

  it('rejects an invalid body (400) and a tombstoned candidate (404), writing nothing', async () => {
    expect((await call('/canary-deployments', 'POST', { candidateId: 'c', specId: 's', url: 'u', workerVersionId: 'v', trafficPercentage: 150, holdoutPercentage: 0 })).status).toBe(400);
    const { candidate } = seedCandidate();
    store.raw.prepare('UPDATE candidates SET deleted_at = 1 WHERE id = ?').run(candidate.id);
    const res = await call('/canary-deployments', 'POST', { candidateId: candidate.id, specId: 's', url: 'u', workerVersionId: 'v', trafficPercentage: 5, holdoutPercentage: 0 });
    expect(res.status).toBe(404);
    expect(count('SELECT COUNT(*) AS n FROM deploy_refs')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM canary_deployments')).toBe(0);
  });
});

describe('rollback (pointer move to prev_ref_id)', () => {
  it('moves the head back to the previous canary and restores its deployment', async () => {
    const a = await deploy('cand-a');
    const b = await deploy('cand-b');
    const res = await call(`/canary-deployments/${b.deployment.id}/rollback`, 'POST', { reason: 'slo_violation' });
    expect(res.status).toBe(200);
    const { deployment: rolled, ref } = await data<CanaryMoveResult>(res);
    expect(rolled).toMatchObject({ status: 'rolled_back', rollbackReason: 'slo_violation' });
    expect(ref).toMatchObject({ candidateId: 'cand-a', workerVersionId: 'ver-cand-a', prevRefId: b.ref.id, action: 'rollback' });
    expect(await head()).toEqual(ref);
    expect((await deployment(a.deployment.id)).status).toBe('deployed');
  });

  it('rolling back twice toggles the pointer back (promotion and demotion are the same move)', async () => {
    await deploy('cand-a');
    const b = await deploy('cand-b');
    expect((await rollbackRef()).status).toBe(200);
    expect((await head()).candidateId).toBe('cand-a');
    expect((await rollbackRef()).status).toBe(200);
    const back = await head();
    expect(back).toMatchObject({ candidateId: 'cand-b', workerVersionId: 'ver-cand-b', action: 'rollback' });
    expect((await deployment(b.deployment.id)).status).toBe('deployed');
    // History is append-only and linear: 4 moves, one head
    expect(count('SELECT COUNT(*) AS n FROM deploy_refs')).toBe(4);
    expect((await data<DeployRef[]>(await call('/deploy-refs?specId=spec-a&rung=canary'))).length).toBe(4);
  });

  it('rolling back the first canary moves to the empty ref: no live canary', async () => {
    const a = await deploy('cand-a');
    await call(`/canary-deployments/${a.deployment.id}/rollback`, 'POST', { reason: 'manual' });
    expect(await head()).toMatchObject({ candidateId: null, workerVersionId: null, prevRefId: a.ref.id });
    expect(await data<LiveRef[]>(await call('/deploy-refs/live?rung=canary'))).toEqual([]);
  });

  it('marks the candidate active canary promotion rolled_back in the same transaction', async () => {
    const b = await deploy('cand-b');
    store.raw.exec('PRAGMA foreign_keys = OFF');
    store.raw.exec(`INSERT INTO promotions (id, candidate_id, from_rung, to_rung, promoted_at, promoted_by, stage)
                    VALUES ('p1', 'cand-b', 'train', 'canary', 1, 'a', 'active'), ('p2', 'cand-b', 'shadow', 'train', 1, 'a', 'active')`);
    store.raw.exec('PRAGMA foreign_keys = ON');
    const before = store.transactions.count;
    await call(`/canary-deployments/${b.deployment.id}/rollback`, 'POST', { reason: 'latency' });
    expect(store.transactions.count - before).toBe(1);
    expect(store.raw.prepare("SELECT stage, rollback_reason FROM promotions WHERE id = 'p1'").get()).toEqual({ stage: 'rolled_back', rollback_reason: 'latency' });
    // Only the promotion onto the rolled-back rung
    expect(store.raw.prepare("SELECT stage FROM promotions WHERE id = 'p2'").get()).toEqual({ stage: 'active' });
  });

  it('refuses (409) to roll back a canary that is not live, and moves nothing', async () => {
    const a = await deploy('cand-a');
    await deploy('cand-b');
    const res = await call(`/canary-deployments/${a.deployment.id}/rollback`, 'POST', { reason: 'manual' });
    expect(res.status).toBe(409);
    expect((await head()).candidateId).toBe('cand-b');
    expect(count('SELECT COUNT(*) AS n FROM deploy_refs')).toBe(2);
  });

  it('404s an unknown deployment or a spec with no ref', async () => {
    expect((await call('/canary-deployments/nope/rollback', 'POST', { reason: 'manual' })).status).toBe(404);
    expect((await rollbackRef('no-such-spec')).status).toBe(404);
    const res = await call('/deploy-refs/head?specId=no-such-spec&rung=canary');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('record_not_found');
  });

  it('the unique prev_ref_id index forbids a fork in the chain', async () => {
    const a = await deploy('cand-a');
    await deploy('cand-b');
    expect(() =>
      store.raw.exec(`INSERT INTO deploy_refs (id, spec_id, rung, prev_ref_id, action, moved_by, moved_at)
                      VALUES ('fork', 'spec-a', 'canary', '${a.ref.id}', 'promote', 'x', 1)`)
    ).toThrow(/UNIQUE/);
  });
});

describe('reads', () => {
  it('lists live canary refs with the deployment they serve', async () => {
    await deploy('cand-a', 'spec-a');
    const b = await deploy('cand-b', 'spec-b');
    const live = await data<LiveRef[]>(await call('/deploy-refs/live?rung=canary'));
    expect(live.map((l) => l.ref.candidateId).sort()).toEqual(['cand-a', 'cand-b']);
    expect(live.find((l) => l.ref.specId === 'spec-b')?.deployment).toEqual(b.deployment);
  });

  it('lists a candidate deployments newest first and patches autoRollback', async () => {
    const first = await deploy('cand-a');
    const second = await deploy('cand-a');
    const list = await data<CanaryDeployment[]>(await call('/canary-deployments?candidateId=cand-a'));
    expect(list.map((d) => d.id)).toEqual([second.deployment.id, first.deployment.id]);
    const patched = await call(`/canary-deployments/${second.deployment.id}`, 'PATCH', { autoRollback: false });
    expect((await data<CanaryDeployment>(patched)).autoRollback).toBe(false);
    expect((await call('/canary-deployments/nope', 'PATCH', { autoRollback: true })).status).toBe(404);
  });
});

describe('lifecycle guard', () => {
  it('a live deploy ref blocks tombstoning its candidate; after rollback it does not', async () => {
    const { actor: maint, spec: s, candidate: c } = seedCandidate();
    const { deployment: d } = await deploy(c.id, s.id);

    const tomb = () => call('/internal/tombstone', 'POST', { entityType: 'candidate', id: c.id }, maint);
    const refused = await tomb();
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain(c.id);

    await call(`/canary-deployments/${d.id}/rollback`, 'POST', { reason: 'manual' });
    expect((await tomb()).status).toBe(200);
  });
});

describe('m6 -> m7 migration', () => {
  it('adds deploy_refs and canary_deployments to an m6 ledger, idempotently', async () => {
    store.raw.exec('DROP TABLE deploy_refs');
    store.raw.exec('DROP TABLE canary_deployments');
    store.raw.exec("UPDATE metadata SET value = 'm6' WHERE key = 'schema_version'");
    spec.createOrganization('existing-org', 'github');

    for (let i = 0; i < 2; i++) {
      const restarted = makeSqliteState(store.raw, store.kv);
      spec = makeSpecDo(restarted);
      await spec.init();
    }
    const version = store.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string };
    expect(version.value).toBe('m11');
    expect(count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('deploy_refs', 'canary_deployments')")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM organizations WHERE name = 'existing-org'")).toBe(1);
    await deploy('cand-a');
  });
});

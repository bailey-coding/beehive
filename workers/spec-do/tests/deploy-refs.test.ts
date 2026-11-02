/**
 * SpecDO deploy refs + canary deployments (m6 -> m7): the traffic pointer per
 * (spec, rung), canary deploy = promote move, rollback = move to the nearest earlier
 * target not rolled back since; both one transaction; live refs block tombstones; the migration.
 * Real SQL (node:sqlite, FKs on) through the real router.
 *
 * Task: canary-rollback | Spec: AGENTS.md#non-negotiable-architectural-rules (rule 7)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { LATEST_VERSION } from './legacy-ledger';
import { authedDo, TEST_DO_TOKENS } from './do-tokens';
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
    const res = await call('/canary-deployments', 'POST', { candidateId: candidate.id, specId: 's', url: 'https://u.acct.workers.dev', workerVersionId: 'v', trafficPercentage: 5, holdoutPercentage: 0 });
    expect(res.status).toBe(404);
    expect(count('SELECT COUNT(*) AS n FROM deploy_refs')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM canary_deployments')).toBe(0);
  });
});

describe('canary deploy request validation (trust boundary for the shadow router)', () => {
  const body = (over: Record<string, unknown>) => ({
    candidateId: 'cand-ok', specId: 's', url: 'https://c.acct.workers.dev', workerVersionId: 'v', trafficPercentage: 5, holdoutPercentage: 0, ...over,
  });

  it('refuses a candidate id that could take the place of a static mirror target or is not a plain token, writing nothing', async () => {
    for (const candidateId of ['beehive-main', 'beehive-gate', 'Beehive-Main', 'beehive-anything', 'a b', 'a/b', '../x', '-x', 'x'.repeat(129)]) {
      const res = await call('/canary-deployments', 'POST', body({ candidateId }));
      expect(res.status, candidateId).toBe(400);
    }
    expect(count('SELECT COUNT(*) AS n FROM deploy_refs')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM canary_deployments')).toBe(0);
  });

  it('refuses a url that is not an https workers.dev Worker without credentials, writing nothing', async () => {
    for (const url of ['http://c.acct.workers.dev', 'https://evil.example', 'https://workers.dev', 'https://user:pw@c.acct.workers.dev', 'https://c.acct.workers.dev.evil.example', 'ftp://c.acct.workers.dev', 'https://c.acct.workers.dev:8443', 'https://.workers.dev', 'https://..workers.dev', 'u', 'https://localhost:8787']) {
      const res = await call('/canary-deployments', 'POST', body({ url }));
      expect(res.status, url).toBe(400);
    }
    expect(count('SELECT COUNT(*) AS n FROM deploy_refs')).toBe(0);
  });

  it('accepts a UUID candidate id with a workers.dev url', async () => {
    const res = await call('/canary-deployments', 'POST', body({ candidateId: '0f1e2d3c-4b5a-4968-8777-665544332211' }));
    expect(res.status).toBe(201);
  });
});

describe('canary url pinned to the account subdomain (WORKERS_SUBDOMAIN)', () => {
  const post = (target: SpecDO, url: string) => target.fetch(new Request('https://spec-do.internal/canary-deployments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Actor-ID': 'canary-worker' },
    body: JSON.stringify({ candidateId: 'cand-pin', specId: 's', url, workerVersionId: 'v', trafficPercentage: 5, holdoutPercentage: 0 }),
  }));

  it('accepts only Workers of the configured subdomain, and any workers.dev host when it is unset', async () => {
    const pinnedState = makeSqliteState();
    const pinned = new SpecDO(pinnedState.state as never, { ...TEST_DO_TOKENS, WORKERS_SUBDOMAIN: 'bz23711' } as never);
    const authed = authedDo(pinned);
    await authed.init();
    for (const url of ['https://x.evil.workers.dev', 'https://bz23711.workers.dev', 'https://x.bz237110.workers.dev', 'https://x.bz23711.workers.dev.evil.example', 'https://x.other.workers.dev']) {
      expect((await post(authed, url)).status, url).toBe(400);
    }
    expect((await post(authed, 'https://aa11-beehive-candidate-x.bz23711.workers.dev')).status).toBe(201);
    expect((await post(spec, 'https://x.evil.workers.dev')).status).toBe(201); // the default fixture has no pin
  });
});

describe('rollback (pointer move to the nearest earlier target not rolled back since)', () => {
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

  it('two distinct rollbacks (no key) end at the empty ref, not back at the rolled-back canary (D2)', async () => {
    const a = await deploy('cand-a');
    const b = await deploy('cand-b');
    expect((await rollbackRef()).status).toBe(200);
    expect((await head()).candidateId).toBe('cand-a');
    expect((await rollbackRef()).status).toBe(200);
    expect(await head()).toMatchObject({ candidateId: null, workerVersionId: null, action: 'rollback' });
    expect((await deployment(a.deployment.id)).status).toBe('rolled_back');
    expect((await deployment(b.deployment.id)).status).toBe('rolled_back');
    expect(await data<LiveRef[]>(await call('/deploy-refs/live?rung=canary'))).toEqual([]);
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
    // Only the deploy-ref CAS carries a code; this 409 stays code-less
    expect(((await res.json()) as { code?: string }).code).toBeUndefined();
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
    expect(version.value).toBe(LATEST_VERSION);
    expect(count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('deploy_refs', 'canary_deployments')")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM organizations WHERE name = 'existing-org'")).toBe(1);
    await deploy('cand-a');
  });
});

describe('ref rollback idempotency (Idempotency-Key) and X-Expected-Head', () => {
  // docs/plans/rollback-idempotency-plan.md section 5
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, actorId = 'operator') =>
    spec.fetch(
      new Request(`https://spec-do.internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actorId, ...headers },
        body: JSON.stringify(body),
      })
    );
  const rb = (headers: Record<string, string> = {}, reason = 'manual', specId = 'spec-a', actorId = 'operator') =>
    post('/deploy-refs/rollback', { specId, rung: 'canary', reason }, headers, actorId);
  const refs = () => count('SELECT COUNT(*) AS n FROM deploy_refs');
  const nearMisses = () => count('SELECT COUNT(*) AS n FROM near_misses');
  const keys = () => count('SELECT COUNT(*) AS n FROM idempotency_keys');

  it('a redelivered rollback with the same key replays and does not roll back twice', async () => {
    await deploy('cand-a');
    await deploy('cand-b');
    const first = await rb({ 'Idempotency-Key': 'k1' });
    expect(first.status).toBe(200);
    expect(first.headers.get('Idempotent-Replay')).toBeNull();
    const again = await rb({ 'Idempotency-Key': 'k1' });
    expect(again.status).toBe(200);
    expect(again.headers.get('Idempotent-Replay')).toBe('true');
    expect((await data<DeployRef>(again)).id).toBe((await data<DeployRef>(first)).id);
    expect((await head()).candidateId).toBe('cand-a');
    expect(refs()).toBe(3);
    expect(nearMisses()).toBe(1);
  });

  it('the same key with a different body is a 409 and moves nothing', async () => {
    await deploy('cand-a');
    await deploy('cand-b');
    expect((await rb({ 'Idempotency-Key': 'k1' }, 'manual')).status).toBe(200);
    expect((await rb({ 'Idempotency-Key': 'k1' }, 'latency')).status).toBe(409);
    expect((await head()).candidateId).toBe('cand-a');
    expect(refs()).toBe(3);
  });

  it('a failed keyed rollback stores no key: the same key later runs once, then replays', async () => {
    expect((await rb({ 'Idempotency-Key': 'k2' })).status).toBe(404);
    expect(keys()).toBe(0);
    await deploy('cand-a');
    await deploy('cand-b');
    const ran = await rb({ 'Idempotency-Key': 'k2' });
    expect(ran.status).toBe(200);
    expect(ran.headers.get('Idempotent-Replay')).toBeNull();
    expect((await head()).candidateId).toBe('cand-a');
    const replay = await rb({ 'Idempotency-Key': 'k2' });
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    expect((await head()).candidateId).toBe('cand-a');
    expect(refs()).toBe(3);
  });

  it('a key over 255 characters is a 400 and moves nothing', async () => {
    await deploy('cand-a');
    expect((await rb({ 'Idempotency-Key': 'k'.repeat(256) })).status).toBe(400);
    expect(refs()).toBe(1);
  });

  it('a replay after the head moved returns the original answer and moves nothing', async () => {
    await deploy('cand-a');
    await deploy('cand-b');
    const first = await data<DeployRef>(await rb({ 'Idempotency-Key': 'k1' }));
    await deploy('cand-c');
    const replay = await rb({ 'Idempotency-Key': 'k1' });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    expect((await data<DeployRef>(replay)).id).toBe(first.id);
    expect((await head()).candidateId).toBe('cand-c');
    expect(refs()).toBe(4);
    expect(nearMisses()).toBe(1);
  });

  // A key is not a compare-and-set: distinct decisions are distinct rollbacks, which walk down the chain (D2)
  it('two different fresh keys are two rollbacks: the second ends at the empty ref, never back at cand-b', async () => {
    await deploy('cand-a');
    await deploy('cand-b');
    expect((await rb({ 'Idempotency-Key': 'k1' })).status).toBe(200);
    expect((await rb({ 'Idempotency-Key': 'k2' })).status).toBe(200);
    expect((await head()).candidateId).toBeNull();
  });

  it('a keyed and an unkeyed rollback are each one transaction', async () => {
    await deploy('cand-a');
    await deploy('cand-b');
    let before = store.transactions.count;
    expect((await rb({ 'Idempotency-Key': 'k1' })).status).toBe(200);
    expect(store.transactions.count - before).toBe(1);
    before = store.transactions.count;
    expect((await rb()).status).toBe(200);
    expect(store.transactions.count - before).toBe(1);
  });

  it('the key is scoped by actor: the same key from another actor is a new request', async () => {
    await deploy('cand-a');
    await deploy('cand-b');
    expect((await rb({ 'Idempotency-Key': 'k1' }, 'manual', 'spec-a', 'operator')).status).toBe(200);
    const other = await rb({ 'Idempotency-Key': 'k1' }, 'manual', 'spec-a', 'someone-else');
    expect(other.headers.get('Idempotent-Replay')).toBeNull();
    // a new request, so a second rollback: cand-a is the head after the first, the empty ref after this one
    expect((await head()).candidateId).toBeNull();
  });

  it('other deploy routes ignore the key', async () => {
    const body = (c: string) => ({ candidateId: c, specId: 'spec-a', url: `https://${c}.example.workers.dev`, workerVersionId: `ver-${c}`, trafficPercentage: 10, holdoutPercentage: 5 });
    expect((await post('/canary-deployments', body('cand-a'), { 'Idempotency-Key': 'k1' })).status).toBe(201);
    expect((await post('/canary-deployments', body('cand-a'), { 'Idempotency-Key': 'k1' })).status).toBe(201);
    expect(count('SELECT COUNT(*) AS n FROM canary_deployments')).toBe(2);
    expect(keys()).toBe(0);
  });

  it('the canary route is not keyed: a keyed then unkeyed repeat is a 409 and stores no key', async () => {
    await deploy('cand-a');
    const b = await deploy('cand-b');
    const path = `/canary-deployments/${b.deployment.id}/rollback`;
    expect((await post(path, { reason: 'manual' }, { 'Idempotency-Key': 'k1' })).status).toBe(200);
    expect((await post(path, { reason: 'manual' }, { 'Idempotency-Key': 'k1' })).status).toBe(409);
    expect((await post(path, { reason: 'manual' })).status).toBe(409);
    expect(keys()).toBe(0);
    expect((await head()).candidateId).toBe('cand-a');
  });

  it('the canary route ignores X-Expected-Head (its liveness check is its CAS)', async () => {
    await deploy('cand-a');
    const b = await deploy('cand-b');
    const res = await post(`/canary-deployments/${b.deployment.id}/rollback`, { reason: 'manual' }, { 'X-Expected-Head': 'stale' });
    expect(res.status).toBe(200);
    expect((await head()).candidateId).toBe('cand-a');
  });

  it('a keyed request refused by X-Expected-Head stores no key, so the retry with the same key after re-reading runs', async () => {
    await deploy('cand-a');
    const b = await deploy('cand-b');
    const refused = await rb({ 'Idempotency-Key': 'k9', 'X-Expected-Head': 'stale' });
    expect(refused.status).toBe(409);
    expect(keys()).toBe(0);
    expect(refs()).toBe(2);
    expect(nearMisses()).toBe(0);
    const retried = await rb({ 'Idempotency-Key': 'k9', 'X-Expected-Head': b.ref.id });
    expect(retried.status).toBe(200);
    expect(retried.headers.get('Idempotent-Replay')).toBeNull();
    expect((await head()).candidateId).toBe('cand-a');
    expect(keys()).toBe(1);
  });

  it('X-Expected-Head: the current head moves; a stale one is a 409 version_conflict that writes nothing', async () => {
    await deploy('cand-a');
    const b = await deploy('cand-b');
    const stale = await rb({ 'X-Expected-Head': 'not-the-head' });
    expect(stale.status).toBe(409);
    const err = (await stale.json()) as { code?: string; error: string };
    expect(err.code).toBe('version_conflict');
    expect(err.error).toContain(b.ref.id);
    expect((await head()).candidateId).toBe('cand-b');
    expect(refs()).toBe(2);
    expect(nearMisses()).toBe(0);

    const ok = await rb({ 'X-Expected-Head': b.ref.id, 'Idempotency-Key': 'k1' });
    expect(ok.status).toBe(200);
    expect((await head()).candidateId).toBe('cand-a');
    // b's ref is no longer the head, so the header alone is now a 409; with the key the replay comes first
    const replay = await rb({ 'X-Expected-Head': b.ref.id, 'Idempotency-Key': 'k1' });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replay')).toBe('true');
    expect((await rb({ 'X-Expected-Head': b.ref.id })).status).toBe(409);
    expect((await head()).candidateId).toBe('cand-a');
    expect(refs()).toBe(3);
    expect(nearMisses()).toBe(1);
  });

  it('an empty X-Expected-Head is a 400, never fail open', async () => {
    await deploy('cand-a');
    await deploy('cand-b');
    const res = await rb({ 'X-Expected-Head': '' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Invalid X-Expected-Head');
    expect(refs()).toBe(2);
  });
});

describe('rollback never re-promotes a rolled-back identity (D2, docs/plans/d2-canary-ping-pong-plan.md)', () => {
  const rungRb = (rung = 'canary', specId = 'spec-a') => call('/deploy-refs/rollback', 'POST', { specId, rung, reason: 'manual' }, 'operator');
  const headOf = async (rung = 'canary', specId = 'spec-a') => data<DeployRef>(await call(`/deploy-refs/head?specId=${specId}&rung=${rung}`));
  /** Roll back n times, returning the head candidate after each (null = the empty ref) */
  async function rollBack(n: number, rung = 'canary'): Promise<(string | null)[]> {
    const seen: (string | null)[] = [];
    for (let i = 0; i < n; i++) {
      expect((await rungRb(rung)).status).toBe(200);
      seen.push((await headOf(rung)).candidateId);
    }
    return seen;
  }
  let seq = 0;
  /** Seed a ref row directly (only deployCanary moves refs in production); no FKs on deploy_refs */
  function seedRef(rung: string, candidateId: string | null, versionId: string | null, action: 'promote' | 'rollback', prev: string | null): string {
    const id = `seed-${++seq}`;
    store.raw.prepare(
      'INSERT INTO deploy_refs (id, spec_id, rung, candidate_id, commit_sha, worker_version_id, prev_ref_id, action, moved_by, moved_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)'
    ).run(id, 'spec-a', rung, candidateId, versionId, prev, action, 'seed', seq);
    return id;
  }

  it('A,B,C: c->b, b->a, a->empty, then stays empty', async () => {
    await deploy('cand-a'); await deploy('cand-b'); await deploy('cand-c');
    expect(await rollBack(5)).toEqual(['cand-b', 'cand-a', null, null, null]);
  });

  it('A,B,C,D walks down to empty without revisiting', async () => {
    for (const c of ['cand-a', 'cand-b', 'cand-c', 'cand-d']) await deploy(c);
    expect(await rollBack(5)).toEqual(['cand-c', 'cand-b', 'cand-a', null, null]);
  });

  it('A,B,A (redeploy of the first version): a->b, b->empty', async () => {
    await deploy('cand-a'); await deploy('cand-b'); await deploy('cand-a');
    expect(await rollBack(3)).toEqual(['cand-b', null, null]);
  });

  it('the same version deployed twice (Z,A,A): a->z, z->empty', async () => {
    await deploy('cand-z'); await deploy('cand-a'); await deploy('cand-a');
    expect(await rollBack(3)).toEqual(['cand-z', null, null]);
  });

  it('a redeploy after a rollback stays eligible: A,B,roll back,B,C: c->b, b->a, a->empty', async () => {
    await deploy('cand-a'); await deploy('cand-b');
    expect(await rollBack(1)).toEqual(['cand-a']);
    await deploy('cand-b'); await deploy('cand-c');
    expect(await rollBack(4)).toEqual(['cand-b', 'cand-a', null, null]);
  });

  it('near-misses: one per rolled-back head, none for the empty head', async () => {
    await deploy('cand-a'); await deploy('cand-b'); await deploy('cand-c');
    await rollBack(5);
    const rows = store.raw.prepare("SELECT candidate_id FROM near_misses WHERE reason = 'slo_rollback' ORDER BY rowid").all() as { candidate_id: string }[];
    expect(rows.map((r) => r.candidate_id)).toEqual(['cand-c', 'cand-b', 'cand-a']);
  });

  it('exactly one deployed canary matches the head throughout, and a rolled_back row never returns', async () => {
    const a = await deploy('cand-a'); const b = await deploy('cand-b');
    await rollBack(3);
    const statuses = [a, b].map((d) => store.raw.prepare('SELECT status FROM canary_deployments WHERE id = ?').get(d.deployment.id));
    expect(statuses).toEqual([{ status: 'rolled_back' }, { status: 'rolled_back' }]);
  });

  it('an empty head stays empty (A,B then five rollbacks)', async () => {
    await deploy('cand-a'); await deploy('cand-b');
    expect(await rollBack(5)).toEqual(['cand-a', null, null, null, null]);
  });

  it('a legacy toggled chain (A,B plus four rollback rows) ends at the empty ref', async () => {
    const r1 = seedRef('canary', 'cand-a', 'ver-a', 'promote', null);
    const r2 = seedRef('canary', 'cand-b', 'ver-b', 'promote', r1);
    const r3 = seedRef('canary', 'cand-a', 'ver-a', 'rollback', r2);
    const r4 = seedRef('canary', 'cand-b', 'ver-b', 'rollback', r3);
    const r5 = seedRef('canary', 'cand-a', 'ver-a', 'rollback', r4);
    seedRef('canary', 'cand-b', 'ver-b', 'rollback', r5);
    expect(await rollBack(3)).toEqual([null, null, null]);
  });

  it('a rollback copy is never a target: V,W + three rollback rows (V live), deploy X, roll back X -> empty', async () => {
    const r1 = seedRef('canary', 'cand-v', 'ver-v', 'promote', null);
    const r2 = seedRef('canary', 'cand-w', 'ver-w', 'promote', r1);
    const r3 = seedRef('canary', 'cand-v', 'ver-v', 'rollback', r2);
    const r4 = seedRef('canary', 'cand-w', 'ver-w', 'rollback', r3);
    seedRef('canary', 'cand-v', 'ver-v', 'rollback', r4);
    await deploy('cand-x');
    expect(await rollBack(2)).toEqual([null, null]);
  });

  it('full rung with null versions keys on the candidate: A,B,C -> b, a, empty, empty, empty', async () => {
    const r1 = seedRef('full', 'cand-a', null, 'promote', null);
    const r2 = seedRef('full', 'cand-b', null, 'promote', r1);
    seedRef('full', 'cand-c', null, 'promote', r2);
    expect(await rollBack(5, 'full')).toEqual(['cand-b', 'cand-a', null, null, null]);
  });

  it('keys are namespaced: a candidate id never collides with a version id', async () => {
    const r1 = seedRef('full', 'x', null, 'promote', null);
    seedRef('full', 'y', 'x', 'promote', r1);
    expect(await rollBack(1, 'full')).toEqual(['x']);
  });

  it('identity is the version: one candidate on two versions rolls back to the earlier version', async () => {
    const r1 = seedRef('canary', 'cand-a', 'v1', 'promote', null);
    seedRef('canary', 'cand-a', 'v2', 'promote', r1);
    expect(await rollBack(1)).toEqual(['cand-a']);
    expect((await headOf()).workerVersionId).toBe('v1');
    expect(await rollBack(1)).toEqual([null]);
  });

  it('two candidates on one version: rollback goes to the empty ref, liveRefs agrees with the head', async () => {
    const r1 = seedRef('canary', 'cand-a', 'shared', 'promote', null);
    seedRef('canary', 'cand-b', 'shared', 'promote', r1);
    expect(await rollBack(1)).toEqual([null]);
  });

  it('a dangling prev_ref_id ends the chain at the empty ref without throwing', async () => {
    seedRef('canary', 'cand-a', 'ver-a', 'promote', 'missing');
    expect(await rollBack(2)).toEqual([null, null]);
  });
});

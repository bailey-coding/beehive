/**
 * Local test of the ledger purge with candidate Worker cleanup: the real Spec DO (node:sqlite, FKs on) behind the real
 * edge lifecycle route, with a fake PREVIEW_MANAGER service binding that records what the ledger looked like at each delete.
 * Complements the mocked-DO tests in workers/api/tests/lifecycle.test.ts and the DO-only tests in ledger-lifecycle.test.ts.
 *
 * Task: purge-local-test | Spec: docs/CLEANUP-PLAN-2026-10-25.md C
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { SpecDO } from '../index';
import { authedDo, TEST_DO_TOKENS } from './do-tokens';
import { handleLifecycleRoutes } from '../../api/lifecycle';
import { createCandidateWorkerCleanup } from '../../api/purge-cleanup';
import type { Principal } from '../../shared/principal';

let store: SqliteState;
let spec: SpecDO;
let maintainerId: string;
let agentId: string;

type Reply = (candidateId: string) => Response | Promise<Response>;
const ok = (deleted: boolean) => new Response(JSON.stringify({ success: true, deleted }));
const fail = (status: number, error = 'nope') => new Response(JSON.stringify({ success: false, error }), { status });

const count = (table: string) => (store.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Fake PREVIEW_MANAGER: records each DELETE with the number of candidate rows still in the ledger at that moment. */
function previewManager(reply: Reply) {
  const calls: { id: string; method?: string; auth: string | null; candidateRowsAtDelete: number }[] = [];
  return {
    calls,
    binding: {
      fetch: async (url: string, init?: RequestInit) => {
        const id = url.split('/').pop()!;
        expect(url).toBe(`https://preview-manager.internal/api/preview/canary/${id}`);
        calls.push({ id, method: init?.method, auth: new Headers(init?.headers).get('Authorization'), candidateRowsAtDelete: count('candidates') });
        return reply(id);
      },
    },
  };
}

async function purge(body: unknown, binding: ReturnType<typeof previewManager>['binding'] | null = null, principal?: Partial<Principal>) {
  const master: Principal = { kind: 'master', actorId: maintainerId, scopes: ['read', 'write'], promotionAuthority: true, organizationId: null, ...principal } as Principal;
  const url = new URL('https://beehive.test/api/admin/purge');
  const stub = { fetch: (req: Request) => spec.fetch(req) } as unknown as DurableObjectStub;
  const cleanup = binding ? createCandidateWorkerCleanup(binding, 'tok') : null;
  const res = await handleLifecycleRoutes(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, master, stub, cleanup);
  const json = (await res!.json()) as { success?: boolean; data?: Record<string, any>; error?: string };
  return { status: res!.status, json };
}

/** org -> repo -> spec -> two candidates (+ a verdict), tombstoned and aged past the default 24h */
async function seedTombstoned(name: string, ageHours = 25) {
  const org = spec.createOrganization(name, 'artifacts');
  const repo = spec.createRepository(`${name}-repo`, org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
  const s = spec.createSpec(`${name}-spec`, 'd', 'contract', [], org.id, agentId);
  const c1 = spec.createCandidate(s.id, repo.id, 'sha1', 'base', agentId);
  const c2 = spec.createCandidate(s.id, repo.id, 'sha2', 'base', agentId);
  spec.createGateVerdict(c1.id, 'pre-merge', 'pass', 90, 0, agentId);
  const res = await spec.fetch(new Request('https://spec-do.internal/internal/tombstone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Actor-ID': maintainerId },
    body: JSON.stringify({ entityType: 'organization', id: org.id }),
  }));
  expect(res.status).toBe(200);
  age(ageHours);
  return { org, c1, c2 };
}

function age(hours: number) {
  const at = Date.now() - hours * 3_600_000;
  for (const t of ['organizations', 'repositories', 'specs', 'candidates', 'issues']) {
    store.raw.prepare(`UPDATE ${t} SET deleted_at = ? WHERE deleted_at IS NOT NULL`).run(at);
  }
}

const real = (total: number, extra: object = {}) => ({ orgNamePrefix: 'org-', dryRun: false, confirm: total, ...extra });

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  maintainerId = spec.createActor('human', 'maint').id;
  agentId = spec.createActor('agent', 'agent-1').id;
  store.raw.prepare(`UPDATE actors SET role = 'maintainer' WHERE id = ?`).run(maintainerId);
});

describe('purge with candidate Worker cleanup (real Spec DO + edge route)', () => {
  it('order: every candidate Worker is deleted while its ledger rows still exist, then the rows go', async () => {
    const a = await seedTombstoned('org-a');
    const pm = previewManager(() => ok(true));
    const dry = await purge({ orgNamePrefix: 'org-' }, pm.binding);
    const total = dry.json.data!.total as number;
    expect(total).toBeGreaterThan(0);
    const res = await purge(real(total), pm.binding);
    expect(res.status).toBe(200);
    expect(pm.calls.map((c) => c.id).sort()).toEqual([a.c1.id, a.c2.id].sort());
    for (const c of pm.calls) {
      expect(c).toMatchObject({ method: 'DELETE', auth: 'Bearer tok', candidateRowsAtDelete: 2 });
    }
    expect(res.json.data!.workerCleanup).toEqual({ status: 'done', deleted: expect.any(Array), absent: [] });
    expect(res.json.data!.candidateIds).toBeUndefined(); // internal field is stripped from the response
    expect(count('candidates')).toBe(0);
    expect(count('organizations')).toBe(0);
  });

  it('partial failure: a failed Worker delete (409 live canary / 502) purges no ledger rows, and the re-run succeeds', async () => {
    const a = await seedTombstoned('org-a');
    const before = { c: count('candidates'), o: count('organizations'), v: count('gate_verdicts') };
    const total = (await purge({ orgNamePrefix: 'org-' })).json.data!.total as number;
    for (const [status, expected] of [[409, 409], [500, 502]] as const) {
      const pm = previewManager((id) => (id === a.c2.id ? fail(status) : ok(true)));
      const res = await purge(real(total), pm.binding);
      expect(res.status).toBe(expected);
      expect(res.json.error).toContain(a.c2.id);
      expect({ c: count('candidates'), o: count('organizations'), v: count('gate_verdicts') }).toEqual(before);
    }
    // idempotent re-run: c1's Worker is already gone ("absent"), c2 now deletes, and the purge completes
    const pm = previewManager((id) => ok(id === a.c2.id));
    const res = await purge(real(total), pm.binding);
    expect(res.status).toBe(200);
    expect(res.json.data!.workerCleanup).toEqual({ status: 'done', deleted: [a.c2.id], absent: [a.c1.id] });
    expect(count('organizations')).toBe(0);
    // and a run after the purge is a no-op: nothing to plan, nothing deleted
    const again = previewManager(() => ok(true));
    const third = await purge(real(0), again.binding);
    expect(third.status).toBe(200);
    expect(again.calls).toEqual([]);
  });

  it('a 404 from the delete route (preview manager older than the route) is an error, not "already gone"; only {deleted:false} is absent', async () => {
    const a = await seedTombstoned('org-a');
    const total = (await purge({ orgNamePrefix: 'org-' })).json.data!.total as number;
    const pm = previewManager(() => new Response('Not found', { status: 404 }));
    const res = await purge(real(total), pm.binding);
    expect(res.status).toBe(502);
    expect(res.json.error).toContain('HTTP 404');
    expect(count('candidates')).toBe(2);
    expect(a.c1.id).toBeTruthy();
  });

  it('a thrown fetch (binding unreachable) aborts without purging', async () => {
    await seedTombstoned('org-a');
    const total = (await purge({ orgNamePrefix: 'org-' })).json.data!.total as number;
    const pm = previewManager(() => { throw new Error('binding down'); });
    const res = await purge(real(total), pm.binding);
    expect(res.status).toBe(502);
    expect(count('organizations')).toBe(1);
  });

  // FINDING (documented, not fixed): workers/api/purge-cleanup.ts:47 treats ANY 501 as "no candidate Worker was ever uploaded" and
  // lets the purge proceed. The preview manager also answers 501 when WORKER_VERSIONS_MODE=api but CLOUDFLARE_API_TOKEN /
  // CLOUDFLARE_ACCOUNT_ID / WORKERS_SUBDOMAIN / the bundle source is missing (workers/preview-manager/versions.ts:264-266), i.e. a
  // misconfigured prod that did upload Workers earlier. The purge then removes the only record of them. Pinned here so a change is deliberate.
  it('PINNED: a 501 from the preview manager skips the cleanup and still purges the ledger (orphans any real Workers)', async () => {
    await seedTombstoned('org-a');
    const total = (await purge({ orgNamePrefix: 'org-' })).json.data!.total as number;
    const pm = previewManager(() => fail(501, 'Workers Versions client not enabled'));
    const res = await purge(real(total), pm.binding);
    expect(res.status).toBe(200);
    expect(res.json.data!.workerCleanup).toMatchObject({ status: 'skipped' });
    expect(count('organizations')).toBe(0);
  });

  it('dry run deletes nothing: no Worker calls, no ledger rows removed', async () => {
    await seedTombstoned('org-a');
    const pm = previewManager(() => ok(true));
    const res = await purge({ orgNamePrefix: 'org-' }, pm.binding);
    expect(res.status).toBe(200);
    expect(res.json.data!.dryRun).toBe(true);
    expect(pm.calls).toEqual([]);
    expect(count('candidates')).toBe(2);
  });

  it('age rule: a tombstone younger than 24 h is skipped and its Workers are left alone; at 25 h it is purged', async () => {
    const a = await seedTombstoned('org-a', 23);
    const pm = previewManager(() => ok(true));
    const dry = await purge({ orgNamePrefix: 'org-' }, pm.binding);
    expect(dry.json.data).toMatchObject({ minAgeHours: 24, total: 0, skipped: [{ orgId: a.org.id, reason: 'too_recent' }] });
    const res = await purge(real(0), pm.binding);
    expect(res.status).toBe(200);
    expect(pm.calls).toEqual([]);
    expect(count('organizations')).toBe(1);
    age(25);
    const total = (await purge({ orgNamePrefix: 'org-' }, pm.binding)).json.data!.total as number;
    expect((await purge(real(total), pm.binding)).status).toBe(200);
    expect(pm.calls).toHaveLength(2);
  });

  it('age rule boundary: PURGE_MIN_AGE_HOURS=0 purges a fresh tombstone; an invalid value falls back to 24', async () => {
    for (const [env, minAge, purged] of [['0', 0, true], ['abc', 24, false], ['-5', 24, false]] as const) {
      store = makeSqliteState();
      spec = authedDo(new SpecDO(store.state as never, { ...TEST_DO_TOKENS, PURGE_MIN_AGE_HOURS: env } as never));
      await spec.init();
      maintainerId = spec.createActor('human', 'maint').id;
      agentId = spec.createActor('agent', 'agent-1').id;
      store.raw.prepare(`UPDATE actors SET role = 'maintainer' WHERE id = ?`).run(maintainerId);
      await seedTombstoned('org-a', 0);
      const pm = previewManager(() => ok(true));
      const dry = await purge({ orgNamePrefix: 'org-' }, pm.binding);
      expect(dry.json.data!.minAgeHours).toBe(minAge);
      expect(dry.json.data!.total > 0).toBe(purged);
    }
  });

  it('non-tombstoned orgs are refused (skipped not_tombstoned), by prefix and by id, and their Workers are never touched', async () => {
    const org = spec.createOrganization('org-live', 'artifacts');
    const repo = spec.createRepository('r', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
    const s = spec.createSpec('s', 'd', 'contract', [], org.id, agentId);
    spec.createCandidate(s.id, repo.id, 'sha1', 'base', agentId);
    const pm = previewManager(() => ok(true));
    for (const selector of [{ orgNamePrefix: 'org-' }, { orgIds: [org.id] }]) {
      const dry = await purge(selector, pm.binding);
      expect(dry.json.data).toMatchObject({ total: 0, orgIds: [], skipped: [{ orgId: org.id, reason: 'not_tombstoned' }] });
      const res = await purge({ ...selector, dryRun: false, confirm: 0 }, pm.binding);
      expect(res.status).toBe(200);
    }
    expect(pm.calls).toEqual([]);
    expect(count('organizations')).toBe(1);
    expect(count('candidates')).toBe(1);
  });

  it('a mixed selection purges only the tombstoned, aged org and deletes only its Workers', async () => {
    const a = await seedTombstoned('org-a');
    const org = spec.createOrganization('org-live', 'artifacts');
    const repo = spec.createRepository('r', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
    const s = spec.createSpec('s', 'd', 'contract', [], org.id, agentId);
    const live = spec.createCandidate(s.id, repo.id, 'sha1', 'base', agentId);
    const pm = previewManager(() => ok(true));
    const total = (await purge({ orgNamePrefix: 'org-' }, pm.binding)).json.data!.total as number;
    expect((await purge(real(total), pm.binding)).status).toBe(200);
    expect(pm.calls.map((c) => c.id).sort()).toEqual([a.c1.id, a.c2.id].sort());
    expect(pm.calls.map((c) => c.id)).not.toContain(live.id);
    expect(count('organizations')).toBe(1);
  });

  it('refusals come before any Worker delete: non-maintainer (403), wrong confirm (409), active promotion (409)', async () => {
    const a = await seedTombstoned('org-a');
    const pm = previewManager(() => ok(true));
    const total = (await purge({ orgNamePrefix: 'org-' }, pm.binding)).json.data!.total as number;
    expect((await purge(real(total), pm.binding, { actorId: agentId })).status).toBe(403);
    expect((await purge(real(total + 1), pm.binding)).status).toBe(409);
    spec.createPromotion(a.c1.id, 'pre-merge', 'shadow', agentId);
    const blocked = await purge(real(total), pm.binding);
    expect(blocked.status).toBe(409);
    expect(pm.calls).toEqual([]);
    expect(count('candidates')).toBe(2);
  });
});

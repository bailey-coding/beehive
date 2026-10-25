/**
 * Edge lifecycle routes: master-only gating, actor attribution, payload checks
 * and pass-through of DO status codes. The DO side is in
 * workers/spec-do/tests/ledger-lifecycle.test.ts.
 *
 * Task: spine-item3-ledger-lifecycle | Spec: AGENTS.md#state-management
 */
import { describe, it, expect } from 'vitest';
import { handleLifecycleRoutes } from '../lifecycle';
import { createCandidateWorkerCleanup } from '../purge-cleanup';
import type { Principal } from '../../shared/principal';

const master: Principal = { kind: 'master', actorId: 'maint-1', scopes: ['read', 'write'], promotionAuthority: true, organizationId: null };
const service: Principal = { kind: 'service', actorId: 'svc-actor', scopes: ['read'], promotionAuthority: false, organizationId: null, serviceAccountId: 'sa-1' };

function fakeStub(reply: (req: Request) => Response = () => new Response(JSON.stringify({ success: true, data: {} }))) {
  const seen: Request[] = [];
  const stub = {
    fetch: async (req: Request) => {
      seen.push(req);
      return reply(req);
    },
  } as unknown as DurableObjectStub;
  return { stub, seen };
}

function run(principal: Principal, method: string, path: string, body?: unknown, stubReply?: (req: Request) => Response) {
  const { stub, seen } = fakeStub(stubReply);
  const url = new URL(`https://beehive.test${path}`);
  const request = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return handleLifecycleRoutes(request, url, principal, stub).then((res) => ({ res, seen }));
}

describe('handleLifecycleRoutes', () => {
  it('ignores unrelated routes', async () => {
    expect((await run(master, 'GET', '/api/organizations')).res).toBeNull();
    expect((await run(master, 'DELETE', '/api/issues/x')).res).toBeNull();
  });

  it('service principals get 403 on every lifecycle route, including include_deleted reads', async () => {
    for (const [method, path] of [
      ['DELETE', '/api/organizations/o1'],
      ['POST', '/api/admin/purge'],
      ['POST', '/api/admin/actors/a1/role'],
      ['GET', '/api/specs?include_deleted=1'],
    ] as const) {
      const { res, seen } = await run(service, method, path, method === 'POST' ? { orgNamePrefix: 'x' } : undefined);
      expect(res?.status).toBe(403);
      expect(seen).toHaveLength(0);
    }
  });

  it('DELETE forwards a tombstone with the actor and optional reason', async () => {
    const { res, seen } = await run(master, 'DELETE', '/api/specs/s1', { reason: 'cleanup' }, () =>
      new Response(JSON.stringify({ success: true, data: { entityType: 'spec', id: 's1', deletedAt: 1, counts: { specs: 1 } } }))
    );
    expect(res?.status).toBe(200);
    expect(new URL(seen[0].url).pathname).toBe('/internal/tombstone');
    expect(seen[0].headers.get('X-Actor-ID')).toBe('maint-1');
    expect(await seen[0].json()).toEqual({ entityType: 'spec', id: 's1', reason: 'cleanup' });
  });

  it('requires an X-Actor-ID for writes', async () => {
    const anon = { ...master, actorId: 'unknown' };
    expect((await run(anon, 'DELETE', '/api/specs/s1')).res?.status).toBe(400);
    expect((await run(anon, 'POST', '/api/admin/purge', { orgNamePrefix: 'x' })).res?.status).toBe(400);
  });

  it('validates the purge payload before calling the DO', async () => {
    const { res, seen } = await run(master, 'POST', '/api/admin/purge', { orgNamePrefix: 'x', dryRun: false });
    expect(res?.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('relays DO 409 / 403 as-is', async () => {
    const conflict = () => new Response(JSON.stringify({ success: false, error: 'confirm mismatch' }), { status: 409 });
    const { res } = await run(master, 'POST', '/api/admin/purge', { orgNamePrefix: 'x', dryRun: false, confirm: 1 }, conflict);
    expect(res?.status).toBe(409);
    expect(((await res!.json()) as { error: string }).error).toBe('confirm mismatch');
  });

  it('include_deleted reads forward the query and actor to the DO', async () => {
    const { seen } = await run(master, 'GET', '/api/candidates?include_deleted=1&specId=s1');
    expect(seen[0].url).toBe('https://spec-do.internal/api/candidates?include_deleted=1&specId=s1');
    expect(seen[0].headers.get('X-Actor-ID')).toBe('maint-1');
  });

  it('refuses to tombstone or purge the reserved beehive-system org at the edge, without calling the DO', async () => {
    const t = await run(master, 'DELETE', '/api/organizations/beehive-system');
    expect(t.res?.status).toBe(403);
    expect(t.seen).toHaveLength(0);
    const p = await run(master, 'POST', '/api/admin/purge', { orgIds: ['o1', 'beehive-system'] });
    expect(p.res?.status).toBe(403);
    expect(p.seen).toHaveLength(0);
  });
});

describe('real purge deletes candidate Workers first (docs/CLEANUP-PLAN-2026-10-25.md C)', () => {
  const C1 = '0f1e2d3c-4b5a-4968-8777-665544332211';
  const C2 = '1f1e2d3c-4b5a-4968-8777-665544332212';
  const real = { orgNamePrefix: 'x', dryRun: false, confirm: 3 };
  const planBody = (extra: object = {}) => ({ success: true, data: { purgeId: 'p', dryRun: true, minAgeHours: 24, orgIds: ['o1'], skipped: [], counts: {}, total: 3, batches: 0, candidateIds: [C1, C2, 'not-a-uuid'], ...extra } });
  const doReply = (log: string[], opts: { plan?: Response; purge?: Response } = {}) => (req: Request) => {
    return req.clone().json().then((b: { dryRun?: boolean; withCandidateIds?: boolean }) => {
      log.push(`do:${b.dryRun ? 'plan' : 'purge'}${b.withCandidateIds ? '+ids' : ''}`);
      if (b.dryRun) return opts.plan ?? new Response(JSON.stringify(planBody()));
      return opts.purge ?? new Response(JSON.stringify({ success: true, data: { ...planBody().data, dryRun: false, batches: 1, candidateIds: [C1, C2] } }));
    }) as unknown as Response;
  };
  const cleanupWith = (log: string[], answer: (id: string) => Response) =>
    createCandidateWorkerCleanup({ fetch: async (url: string, init?: RequestInit) => { const id = url.split('/').pop()!; log.push(`del:${init?.method}:${id}`); return answer(id); } }, 'tok');
  const runReal = (stubReply: (req: Request) => Response, cleanup: unknown, body: unknown = real) => {
    const { stub } = fakeStub(stubReply);
    const url = new URL('https://beehive.test/api/admin/purge');
    return handleLifecycleRoutes(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, master, stub, cleanup as never);
  };
  const ok = (deleted: boolean) => new Response(JSON.stringify({ success: true, deleted }));

  it('plans with a dry run, deletes the Workers (UUID candidates only), then purges, and reports the cleanup', async () => {
    const log: string[] = [];
    const res = await runReal(doReply(log), cleanupWith(log, (id) => ok(id === C1)));
    expect(res?.status).toBe(200);
    expect(log).toEqual(['do:plan+ids', `del:DELETE:${C1}`, `del:DELETE:${C2}`, 'do:purge+ids']);
    const body = (await res!.json()) as { data: Record<string, unknown> };
    expect(body.data.workerCleanup).toEqual({ status: 'done', deleted: [C1], absent: [C2] });
    expect(body.data.candidateIds).toBeUndefined();
  });

  it('deletes the Worker of a candidate that was tombstoned between the plan and the purge, and says so when that fails', async () => {
    const C3 = '2f1e2d3c-4b5a-4968-8777-665544332213';
    const purgeWithLate = new Response(JSON.stringify({ success: true, data: { ...planBody().data, dryRun: false, batches: 1, candidateIds: [C1, C2, C3] } }));
    const l1: string[] = [];
    const r1 = await runReal(doReply(l1, { purge: purgeWithLate }), cleanupWith(l1, () => ok(true)));
    expect(l1.filter((l) => l.startsWith('del:')).at(-1)).toBe(`del:DELETE:${C3}`);
    expect(((await r1!.json()) as { data: { workersNotDeleted?: string[] } }).data.workersNotDeleted).toBeUndefined();
    const l2: string[] = [];
    const r2 = await runReal(
      doReply(l2, { purge: new Response(JSON.stringify({ success: true, data: { ...planBody().data, dryRun: false, batches: 1, candidateIds: [C1, C2, C3] } })) }),
      cleanupWith(l2, (id) => (id === C3 ? new Response('{}', { status: 500 }) : ok(true)))
    );
    expect(r2?.status).toBe(200); // the ledger purge already happened; the leftover is reported, not hidden
    expect(((await r2!.json()) as { data: { workersNotDeleted?: string[] } }).data.workersNotDeleted).toEqual([C3]);
  });

  it('aborts before purging when a Worker cannot be deleted (409 live canary, 5xx, network), naming the candidate', async () => {
    for (const [answer, status] of [
      [() => new Response(JSON.stringify({ error: 'live canary' }), { status: 409 }), 409],
      [() => new Response('{}', { status: 500 }), 502],
      [() => { throw new Error('boom'); }, 502],
    ] as const) {
      const log: string[] = [];
      const res = await runReal(doReply(log), cleanupWith(log, answer as never));
      expect(res?.status).toBe(status);
      expect(log).not.toContain('do:purge+ids');
      expect(((await res!.json()) as { error: string }).error).toContain(C1);
    }
  });

  it('never deletes anything for a dry run, and refusals of the plan (403, 409) come before any delete', async () => {
    const log: string[] = [];
    await runReal(doReply(log), cleanupWith(log, () => ok(true)), { orgNamePrefix: 'x' });
    expect(log).toEqual(['do:plan']);
    const log2: string[] = [];
    const refused = await runReal(doReply(log2, { plan: new Response(JSON.stringify({ success: false, error: 'active promotion' }), { status: 409 }) }), cleanupWith(log2, () => ok(true)));
    expect(refused?.status).toBe(409);
    expect(log2.some((l) => l.startsWith('del:'))).toBe(false);
  });

  it('checks confirm against the plan total before deleting any Worker (a wrong confirm leaves every Worker alone)', async () => {
    const log: string[] = [];
    const res = await runReal(doReply(log), cleanupWith(log, () => ok(true)), { ...real, confirm: 4 });
    expect(res?.status).toBe(409);
    expect(((await res!.json()) as { error: string }).error).toContain('does not match');
    expect(log).toEqual(['do:plan+ids']);
  });

  it('refuses a purge that would delete more than 40 candidate Workers, without purging', async () => {
    const ids = Array.from({ length: 41 }, (_, i) => `${String(i).padStart(8, '0')}-4b5a-4968-8777-665544332211`);
    const log: string[] = [];
    const res = await runReal(doReply(log, { plan: new Response(JSON.stringify(planBody({ candidateIds: ids }))) }), cleanupWith(log, () => ok(true)));
    expect(res?.status).toBe(409);
    expect(log).toEqual(['do:plan+ids']);
  });

  it('purges as before, reporting the cleanup as skipped, when the preview manager has no Versions client (501), has no binding, or the Spec DO is older', async () => {
    const l1: string[] = [];
    const r1 = await runReal(doReply(l1), cleanupWith(l1, () => new Response('{}', { status: 501 })));
    expect(((await r1!.json()) as { data: { workerCleanup: { status: string } } }).data.workerCleanup.status).toBe('skipped');
    expect(l1).toContain('do:purge+ids');
    const l2: string[] = [];
    const r2 = await runReal(doReply(l2), null);
    expect(((await r2!.json()) as { data: { workerCleanup: { status: string } } }).data.workerCleanup.status).toBe('skipped');
    expect(l2).toEqual(['do:purge']);
    // an older Spec DO rejects withCandidateIds with a 400: the plan is retried without it, and the purge does not send it
    const l3: string[] = [];
    const older = (req: Request) => req.clone().json().then((b: { dryRun?: boolean; withCandidateIds?: boolean }) => {
      l3.push(`do:${b.dryRun ? 'plan' : 'purge'}${b.withCandidateIds ? '+ids' : ''}`);
      if (b.withCandidateIds) return new Response(JSON.stringify({ success: false, error: 'Unrecognized key' }), { status: 400 });
      return new Response(JSON.stringify({ success: true, data: { ...planBody().data, candidateIds: undefined, dryRun: !!b.dryRun } }));
    }) as unknown as Response;
    const r3 = await runReal(older, cleanupWith(l3, () => ok(true)));
    expect(r3?.status).toBe(200);
    expect(l3).toEqual(['do:plan+ids', 'do:plan', 'do:purge']);
  });
});

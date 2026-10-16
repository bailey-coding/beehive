/**
 * Edge lifecycle routes: master-only gating, actor attribution, payload checks
 * and pass-through of DO status codes. The DO side is in
 * workers/spec-do/tests/ledger-lifecycle.test.ts.
 *
 * Task: spine-item3-ledger-lifecycle | Spec: AGENTS.md#state-management
 */
import { describe, it, expect } from 'vitest';
import { handleLifecycleRoutes } from '../lifecycle';
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

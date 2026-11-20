/**
 * `advance` at the edge. Promotion-gaps plan V13 kept it internal (only the promotion worker, over the Spec DO binding). Wave 2a part A4
 * (docs/plans/wave-2a-plan.md, maintainer decision M3, 2026-11-20) opens POST to the **master** principal only, as the replacement for the
 * upward stage PATCH, which the Spec DO now refuses: a master `advance` is narrower than the old master PATCH (one rung, with the evidence each
 * rung enforces). Service and user tokens stay out (default deny: not on USER_WRITE_ROUTES; service-accounts.test.ts, user-tokens.test.ts).
 * Other methods are still not routed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../index';

const stub = { fetch: vi.fn() };
const env = { SPEC_DO: { idFromName: vi.fn().mockReturnValue('do'), get: vi.fn().mockReturnValue(stub) }, API_AUTH_TOKEN: 'tok' };

beforeEach(() => {
  stub.fetch.mockReset();
  env.SPEC_DO.get.mockReturnValue(stub);
});

const send = (method: string, auth = 'Bearer tok') =>
  worker.fetch(
    new Request('http://localhost/api/candidates/c-1/advance', {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toRung: 'full' }),
    }),
    env as any,
    {} as any
  );
const reachedAdvance = () => stub.fetch.mock.calls.some((c) => new URL((c[0] as Request).url).pathname.endsWith('/advance'));

describe('POST /api/candidates/:id/advance at the edge', () => {
  it.each(['PATCH', 'PUT'])('%s is not routed', async (method) => {
    const res = await send(method);
    expect(res.status).toBe(404);
    expect(reachedAdvance()).toBe(false);
  });

  it('POST with the master token reaches the Spec DO advance route', async () => {
    stub.fetch.mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'candidate_not_found' }), { status: 404 }));
    const res = await send('POST');
    expect(reachedAdvance()).toBe(true);
    expect(res.status).toBe(404);
  });

  it('POST is forwarded WITHOUT the promotion token even when the edge holds it (review S3: the master token is shared by every worker)', async () => {
    stub.fetch.mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));
    const withSecret = { ...env, SPEC_DO_INTERNAL_TOKEN: 'i', SPEC_DO_PROMOTION_TOKEN: 'p' };
    await worker.fetch(
      new Request('http://localhost/api/candidates/c-1/advance', { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ toRung: 'shadow' }) }),
      withSecret as any,
      {} as any
    );
    const fwd = stub.fetch.mock.calls.map((c) => c[0] as Request).find((r) => new URL(r.url).pathname.endsWith('/advance'))!;
    expect(fwd.headers.get('X-Beehive-Internal')).toBe('i');
    expect(fwd.headers.get('X-Beehive-Promotion')).toBeNull();
  });

  it('POST with a wrong bearer is 401 and never reaches the Spec DO', async () => {
    const res = await send('POST', 'Bearer nope');
    expect(res.status).toBe(401);
    expect(reachedAdvance()).toBe(false);
  });
});

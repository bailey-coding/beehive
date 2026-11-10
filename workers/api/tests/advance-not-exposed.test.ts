/**
 * `advance` is internal (promotion-gaps plan V13): the promotion worker reaches it over the Spec DO binding, the edge does not route it.
 * The edge route list is explicit, so a new Spec DO route is closed to the edge until someone adds it; this keeps it that way.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../index';

const stub = { fetch: vi.fn() };
const env = { SPEC_DO: { idFromName: vi.fn().mockReturnValue('do'), get: vi.fn().mockReturnValue(stub) }, API_AUTH_TOKEN: 'tok' };

beforeEach(() => {
  stub.fetch.mockReset();
  env.SPEC_DO.get.mockReturnValue(stub);
});

describe('POST /api/candidates/:id/advance at the edge', () => {
  it.each(['POST', 'PATCH', 'PUT'])('%s is not routed: no promotion without going through the promotion worker', async (method) => {
    const res = await worker.fetch(
      new Request('http://localhost/api/candidates/c-1/advance', {
        method,
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({ toRung: 'full' }),
      }),
      env as any,
      {} as any
    );
    expect(res.status).toBe(404);
    const advanced = stub.fetch.mock.calls.some((c) => new URL((c[0] as Request).url).pathname.endsWith('/advance'));
    expect(advanced).toBe(false);
  });
});

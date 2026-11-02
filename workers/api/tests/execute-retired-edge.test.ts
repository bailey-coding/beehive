/**
 * Edge side of the retired execute route (docs/plans/retire-execute-plan.md): master gets 410 route_retired without the Spec DO
 * being called (any body, including none); a user token is still refused with 403 first (S9 matrix, user-tokens.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../index';
import { ROUTE_RETIRED } from '../../shared/retired-route';

const stub = { fetch: vi.fn() };
const env = { SPEC_DO: { idFromName: vi.fn().mockReturnValue('do'), get: vi.fn().mockReturnValue(stub) }, API_AUTH_TOKEN: 'tok' };

beforeEach(() => {
  stub.fetch.mockReset();
  env.SPEC_DO.get.mockReturnValue(stub);
});

describe('POST /api/candidates/:id/execute at the edge (retired)', () => {
  it.each([undefined, '{}', '{not json'])('master gets 410 route_retired without a Spec DO call (body %s)', async (body) => {
    const res = await worker.fetch(
      new Request('http://localhost/api/candidates/c1/execute', {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body,
      }),
      env as any,
      {} as any
    );
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ success: false, code: ROUTE_RETIRED });
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

/**
 * Route dispatch never throws out of the worker (docs/plans/wave-0-plan.md part 3, review d S4): a request body that is not JSON or a
 * path that does not decode is a 400; a failure that is not the caller's (a Spec DO answer that is not JSON, any other throw) is a
 * generic 500 that echoes no error text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../index';

const stub = { fetch: vi.fn() };
const env = { SPEC_DO: { idFromName: vi.fn().mockReturnValue('do'), get: vi.fn().mockReturnValue(stub) }, API_AUTH_TOKEN: 'tok' };
const call = (path: string, method: string, body?: string) =>
  worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json', 'X-Actor-ID': 'maint-1' },
      body,
    }),
    env as any,
    {} as any
  );

beforeEach(() => {
  stub.fetch.mockReset();
  env.SPEC_DO.get.mockReturnValue(stub);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('route dispatch errors at the edge', () => {
  it('a body that is not JSON is a 400 with no Spec DO call', async () => {
    const res = await call('/api/organizations', 'POST', '{bad');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: 'Malformed request' });
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('a Spec DO answer that is not JSON is a 500, not a 400 blamed on the caller', async () => {
    stub.fetch.mockResolvedValue(new Response('<html>oops</html>', { status: 200 }));
    const res = await call('/api/specs/s1/claim', 'POST', '{}');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, error: 'Internal error' });
  });

  it('any other throw is a 500 that does not echo the error message', async () => {
    stub.fetch.mockRejectedValue(new Error('secret internal detail'));
    const res = await call('/api/specs/s1/claim', 'POST', '{}');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret internal detail');
  });

  it.each([
    ['DELETE', '/api/organizations/%E0%A4%A', '{}'],
    ['POST', '/api/admin/actors/%E0%A4%A/role', JSON.stringify({ role: 'maintainer' })],
  ])('a path segment that does not decode is a 400 (%s %s, master token)', async (method, path, body) => {
    const res = await call(path, method, body);
    expect(res.status).toBe(400);
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

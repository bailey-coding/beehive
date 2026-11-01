/**
 * Edge route GET /api/near-misses (PR-B): read scope, forwards only the known query keys, and maps an older Spec DO's generic
 * 404 to 503 (not available yet), never to an empty list (AGENTS.md Response.ok rule).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../index';

const stub = { fetch: vi.fn() };
const env = { SPEC_DO: { idFromName: vi.fn().mockReturnValue('do'), get: vi.fn().mockReturnValue(stub) }, API_AUTH_TOKEN: 'tok' };
const get = (q: string) =>
  worker.fetch(new Request(`http://localhost/api/near-misses${q}`, { headers: { Authorization: 'Bearer tok' } }), env as any, {} as any);

beforeEach(() => {
  stub.fetch.mockReset();
  env.SPEC_DO.get.mockReturnValue(stub);
});

describe('GET /api/near-misses at the edge', () => {
  it('forwards specId, candidateId, reason, limit and offset, and drops anything else', async () => {
    stub.fetch.mockResolvedValue(Response.json({ success: true, data: [] }));
    const res = await get('?specId=s1&candidateId=c1&reason=trial_loss&limit=5&offset=2&evil=1');
    expect(res.status).toBe(200);
    const forwarded = new URL((stub.fetch.mock.calls[0][0] as Request).url);
    expect(forwarded.pathname).toBe('/api/near-misses');
    expect(Object.fromEntries(forwarded.searchParams)).toEqual({ specId: 's1', candidateId: 'c1', reason: 'trial_loss', limit: '5', offset: '2' });
  });

  it('an older Spec DO without the route (404) is 503, never an empty list', async () => {
    stub.fetch.mockResolvedValue(Response.json({ success: false, error: 'Not found' }, { status: 404 }));
    const res = await get('');
    expect(res.status).toBe(503);
  });

  it('passes a 400 from the Spec DO through', async () => {
    stub.fetch.mockResolvedValue(Response.json({ success: false, error: 'invalid query' }, { status: 400 }));
    expect((await get('?reason=typo')).status).toBe(400);
  });

  it('needs authentication', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/near-misses'), env as any, {} as any);
    expect(res.status).toBe(401);
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

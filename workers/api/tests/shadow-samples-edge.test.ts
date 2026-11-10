/**
 * Edge route POST /api/candidates/:id/shadow-samples (promotion-gaps PR A, plan N3 and V13): forwards the body and the
 * Idempotency-Key; the Spec DO's coded 404 (no such candidate) passes through, a code-less 404 (an older Spec DO with no route)
 * is a 503, never "unknown candidate" (AGENTS.md: a 404 is never "empty").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../index';
import { CANDIDATE_NOT_FOUND } from '../../shared/shadow-verdict';

const stub = { fetch: vi.fn() };
const env = { SPEC_DO: { idFromName: vi.fn().mockReturnValue('do'), get: vi.fn().mockReturnValue(stub) }, API_AUTH_TOKEN: 'tok' };
const body = { samples: [{ requestId: 'r', score: 90, matched: true }] };
const post = (id = 'c-1', headers: Record<string, string> = {}, payload: BodyInit = JSON.stringify(body)) =>
  worker.fetch(
    new Request(`http://localhost/api/candidates/${id}/shadow-samples`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json', ...headers },
      body: payload,
    }),
    env as any,
    {} as any
  );

beforeEach(() => {
  stub.fetch.mockReset();
  env.SPEC_DO.get.mockReturnValue(stub);
});

describe('POST /api/candidates/:id/shadow-samples at the edge', () => {
  it('forwards the body, the path and the Idempotency-Key', async () => {
    stub.fetch.mockResolvedValue(Response.json({ success: true, data: {} }));
    const res = await post('c-1', { 'Idempotency-Key': 'k-1' });
    expect(res.status).toBe(200);
    const forwarded = stub.fetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/api/candidates/c-1/shadow-samples');
    expect(forwarded.headers.get('Idempotency-Key')).toBe('k-1');
    expect(await forwarded.json()).toEqual(body);
  });

  it("passes the Spec DO's coded 404 through as 404 (the candidate is unknown)", async () => {
    stub.fetch.mockResolvedValue(Response.json({ success: false, error: CANDIDATE_NOT_FOUND }, { status: 404 }));
    expect((await post()).status).toBe(404);
  });

  it("an older Spec DO's code-less 404 is a 503, never 'unknown candidate'", async () => {
    stub.fetch.mockResolvedValue(Response.json({ success: false, error: 'Not found' }, { status: 404 }));
    expect((await post()).status).toBe(503);
  });

  it('a non-JSON 404 is a 503 too', async () => {
    stub.fetch.mockResolvedValue(new Response('nope', { status: 404 }));
    expect((await post()).status).toBe(503);
  });

  it('passes 400 and 409 through', async () => {
    stub.fetch.mockResolvedValue(Response.json({ success: false, error: 'bad' }, { status: 400 }));
    expect((await post()).status).toBe(400);
    stub.fetch.mockResolvedValue(Response.json({ success: false, error: 'conflict' }, { status: 409 }));
    expect((await post()).status).toBe(409);
  });

  it('a body that is not JSON is a 400 with no Spec DO call', async () => {
    const res = await post('c-1', {}, 'not json');
    expect(res.status).toBe(400);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('a key over 255 characters is a 400 with no Spec DO call', async () => {
    const res = await post('c-1', { 'Idempotency-Key': 'k'.repeat(256) });
    expect(res.status).toBe(400);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('needs authentication', async () => {
    const res = await worker.fetch(new Request('http://localhost/api/candidates/c-1/shadow-samples', { method: 'POST', body: JSON.stringify(body) }), env as any, {} as any);
    expect(res.status).toBe(401);
  });
});

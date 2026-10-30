/**
 * Edge forwarding of Idempotency-Key to the Spec DO (docs/M5A-2-IMPL-PLAN.md section 1).
 * The Spec DO keys 8 POST routes that the edge exposes; the header must reach them, and only them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../index';

const mockSpecDoStub = { fetch: vi.fn() };
const mockEnv = {
  SPEC_DO: { idFromName: vi.fn().mockReturnValue('do-id'), get: vi.fn().mockReturnValue(mockSpecDoStub) },
  API_AUTH_TOKEN: 'test-auth-token',
};
const mockCtx = {};

function post(path: string, headers: Record<string, string> = {}, body: unknown = { name: 'x' }): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-auth-token', ...headers },
    body: JSON.stringify(body),
  });
}

const KEYED_ROUTES = [
  '/api/organizations',
  '/api/actors',
  '/api/repositories',
  '/api/specs',
  '/api/candidates',
  '/api/gate-verdicts',
  '/api/trials',
  '/api/promotions',
];

describe('Idempotency-Key at the edge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpecDoStub.fetch.mockReset();
    mockSpecDoStub.fetch.mockImplementation(async () => Response.json({ success: true }, { status: 201 }));
    mockEnv.SPEC_DO.get.mockReturnValue(mockSpecDoStub);
  });

  it.each(KEYED_ROUTES)('forwards the key on POST %s', async (path) => {
    const response = await worker.fetch(post(path, { 'Idempotency-Key': 'k-1' }), mockEnv as any, mockCtx as any);
    expect(response.status).toBe(201);
    const forwarded = mockSpecDoStub.fetch.mock.calls[0][0] as Request;
    expect(new URL(forwarded.url).pathname).toBe(path);
    expect(forwarded.headers.get('Idempotency-Key')).toBe('k-1');
  });

  it('sends no key when the client sent none', async () => {
    await worker.fetch(post('/api/organizations'), mockEnv as any, mockCtx as any);
    const forwarded = mockSpecDoStub.fetch.mock.calls[0][0] as Request;
    expect(forwarded.headers.get('Idempotency-Key')).toBeNull();
  });

  it('accepts a key of exactly 255 characters', async () => {
    const response = await worker.fetch(
      post('/api/organizations', { 'Idempotency-Key': 'k'.repeat(255) }), mockEnv as any, mockCtx as any
    );
    expect(response.status).toBe(201);
  });

  it('rejects a key over 255 characters with 400 and no Spec DO call', async () => {
    const response = await worker.fetch(
      post('/api/organizations', { 'Idempotency-Key': 'k'.repeat(256) }), mockEnv as any, mockCtx as any
    );
    expect(response.status).toBe(400);
    const data = await response.json() as { success: boolean; error: string };
    expect(data.success).toBe(false);
    expect(data.error).toContain('255');
    expect(mockSpecDoStub.fetch).not.toHaveBeenCalled();
  });

  it('does not forward the key on a route the Spec DO does not key', async () => {
    await worker.fetch(post('/api/issues', { 'Idempotency-Key': 'k-1' }, { title: 't' }), mockEnv as any, mockCtx as any);
    const calls = mockSpecDoStub.fetch.mock.calls.map((c) => c[0] as Request);
    for (const forwarded of calls) {
      expect(forwarded.headers.get('Idempotency-Key')).toBeNull();
    }
  });

  it('a client cannot reach the history route the queue consumer keys (GET only at the edge)', async () => {
    const response = await worker.fetch(
      post('/api/entities/candidate/c-1/history', { 'Idempotency-Key': 'queue:evt-1' }), mockEnv as any, mockCtx as any
    );
    expect(response.status).not.toBe(201);
    const forwardedKeys = mockSpecDoStub.fetch.mock.calls.map((c) => (c[0] as Request).headers.get('Idempotency-Key'));
    expect(forwardedKeys).not.toContain('queue:evt-1');
  });
});

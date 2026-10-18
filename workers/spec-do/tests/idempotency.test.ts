/**
 * Tests for idempotency keys functionality
 * Task: M5a - Idempotency Keys for Queue Double-Write Prevention
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';

let spec: SpecDO;
let state: SqliteState;

const rowCount = (table: string) =>
  (state.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const keyRows = () => rowCount('idempotency_keys');

beforeEach(async () => {
  state = makeSqliteState();
  spec = makeSpecDo(state);
  await spec.init();
});

function call(
  path: string,
  method: string = 'GET',
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

// Helper to generate unique idempotency keys
let keyCounter = 0;
function makeIdempotencyKey(): string {
  return `idemp-key-${++keyCounter}-${Date.now()}`;
}

describe('Idempotency Keys', () => {
  describe('Basic functionality', () => {
    it('should return 409 Conflict when same key is reused with different request body', async () => {
      const key = makeIdempotencyKey();
      const endpoint = '/api/organizations';
      
      // First request with body A
      const bodyA = { name: 'Test Org A', type: 'github' as const };
      const responseA = await call(endpoint, 'POST', bodyA, { 'Idempotency-Key': key });
      
      // Second request with same key but different body
      const bodyB = { name: 'Test Org B', type: 'github' as const };
      const responseB = await call(endpoint, 'POST', bodyB, { 'Idempotency-Key': key });
      
      expect(responseB.status).toBe(409);
      const data = await responseB.json();
      expect(data.error).toContain('Idempotency key conflict');
    });

    it('should allow same request with same key (return cached response)', async () => {
      const key = makeIdempotencyKey();
      const endpoint = '/api/organizations';
      const body = { name: `Test Org ${Date.now()}`, type: 'github' as const };
      
      // First request
      const response1 = await call(endpoint, 'POST', body, { 'Idempotency-Key': key });
      expect(response1.status).toBe(201);
      
      // Second request with same key and body
      const response2 = await call(endpoint, 'POST', body, { 'Idempotency-Key': key });
      expect(response2.status).toBe(201);
      
      const data1 = await response1.json();
      const data2 = await response2.json();
      
      // Both should return the same organization (from cache)
      expect(data1.data.id).toBe(data2.data.id);
    });

    it('should allow requests without idempotency key (backwards compatibility)', async () => {
      const endpoint = '/api/organizations';
      const body = { name: `Test Org No Key ${Date.now()}`, type: 'github' as const };
      
      // Request without idempotency key should work
      const response = await call(endpoint, 'POST', body);
      expect(response.status).toBe(201);
      
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it('should not check idempotency for GET requests', async () => {
      const key = makeIdempotencyKey();
      const endpoint = '/api/organizations';
      
      // GET requests should ignore idempotency key
      const response = await call(endpoint, 'GET', undefined, { 'Idempotency-Key': key });
      expect(response.status).toBe(200);
    });

    it('should handle missing Idempotency-Key header gracefully', async () => {
      const endpoint = '/api/organizations';
      const body = { name: `Test Org ${Date.now()}`, type: 'github' as const };
      
      const response = await call(endpoint, 'POST', body);
      expect(response.status).toBe(201);
    });

    it('ignores the key on routes that are not wired for idempotency', async () => {
      const key = makeIdempotencyKey();
      const res = await call('/api/organizations/does-not-exist/stage', 'PATCH', { stage: 'active' }, {
        'Idempotency-Key': key,
      });
      expect(res.status).toBe(404);
      expect(keyRows()).toBe(0);
    });

    it('works for candidates mutations', async () => {
      const org = (await (await call('/api/organizations', 'POST', { name: 'Cand Org', type: 'github' })).json()).data;
      const actorId = (await (await call('/api/actors', 'POST', { type: 'human', name: 'alice' })).json()).data.id;
      const specRes = await call('/api/specs', 'POST', {
        name: 'Cand Spec', contract: '{}', declaredDeltaSurface: [], organizationId: org.id,
      }, { 'X-Actor-ID': actorId });
      expect(specRes.status).toBe(201);
      const specId = (await specRes.json()).data.id;
      const repoRes = await call('/api/repositories', 'POST', {
        name: 'Cand Repo', organizationId: org.id, repoType: 'candidate', specId,
        remoteUrl: 'https://example.invalid/r.git', namespace: 'ns',
      });
      expect(repoRes.status).toBe(201);
      const repositoryId = (await repoRes.json()).data.id;

      const key = makeIdempotencyKey();
      const candidateBody = { specId, repositoryId, commitSha: 'abc123', baseCommitSha: 'def456', agentId: actorId };
      const response1 = await call('/api/candidates', 'POST', candidateBody, { 'Idempotency-Key': key });
      const response2 = await call('/api/candidates', 'POST', candidateBody, { 'Idempotency-Key': key });

      expect(response1.status).toBe(201);
      expect(response2.status).toBe(201);
      expect((await response1.json()).data.id).toBe((await response2.json()).data.id);
      expect(rowCount('candidates')).toBe(1);
    });
  });

  describe('Scoping', () => {
    it('does not replay one actor\'s response to another actor using the same key', async () => {
      const key = makeIdempotencyKey();
      const body = { name: 'Scoped Org', type: 'github' as const };
      const a = await call('/api/organizations', 'POST', body, { 'Idempotency-Key': key, 'X-Actor-ID': 'actor-a' });
      const b = await call('/api/organizations', 'POST', body, { 'Idempotency-Key': key, 'X-Actor-ID': 'actor-b' });
      const aAgain = await call('/api/organizations', 'POST', body, { 'Idempotency-Key': key, 'X-Actor-ID': 'actor-a' });

      expect(a.status).toBe(201);
      // B's request executes (and hits the duplicate-name check) instead of replaying A's response
      expect(b.status).toBe(409);
      expect(b.headers.get('Idempotent-Replay')).toBeNull();
      expect(aAgain.headers.get('Idempotent-Replay')).toBe('true');
      expect((await aAgain.json()).data.id).toBe((await a.json()).data.id);
      expect(keyRows()).toBe(1);
    });

    it('does not replay a response on a different route with the same key', async () => {
      const key = makeIdempotencyKey();
      const org = await call('/api/organizations', 'POST', { name: 'Route Org', type: 'github' }, { 'Idempotency-Key': key });
      const actor = await call('/api/actors', 'POST', { type: 'human', name: 'bob' }, { 'Idempotency-Key': key });
      expect(org.status).toBe(201);
      expect(actor.status).toBe(201);
      expect(actor.headers.get('Idempotent-Replay')).toBeNull();
    });
  });

  describe('Atomicity', () => {
    it('leaves no key behind when the mutation fails, so a retry runs it', async () => {
      const key = makeIdempotencyKey();
      const bad = { specId: 'missing', repositoryId: 'missing', commitSha: 'a', baseCommitSha: 'b' };
      const first = await call('/api/candidates', 'POST', bad, { 'Idempotency-Key': key });
      expect(first.status).toBeGreaterThanOrEqual(400);
      expect(keyRows()).toBe(0);
      const retry = await call('/api/candidates', 'POST', bad, { 'Idempotency-Key': key });
      expect(retry.status).toBe(first.status);
      expect(retry.headers.get('Idempotent-Replay')).toBeNull();
    });

    it('stores the response with the mutation: replay body equals the original', async () => {
      const key = makeIdempotencyKey();
      const body = { name: 'Atomic Org', type: 'github' as const };
      const first = await call('/api/organizations', 'POST', body, { 'Idempotency-Key': key });
      const text1 = await first.text();
      const replay = await call('/api/organizations', 'POST', body, { 'Idempotency-Key': key });
      expect(await replay.text()).toBe(text1);
      expect(rowCount('organizations')).toBe(1);
    });
  });

  describe('Expiry', () => {
    it('treats an expired key as new and re-runs the mutation', async () => {
      const key = makeIdempotencyKey();
      const body = { name: 'Expiring Org', type: 'github' as const };
      const first = await call('/api/organizations', 'POST', body, { 'Idempotency-Key': key });
      expect(first.status).toBe(201);
      state.raw.prepare('UPDATE idempotency_keys SET expires_at = 1').run();

      const again = await call('/api/organizations', 'POST', { name: 'Expiring Org 2', type: 'github' }, {
        'Idempotency-Key': key,
      });
      expect(again.status).toBe(201);
      expect(again.headers.get('Idempotent-Replay')).toBeNull();
      expect(keyRows()).toBe(1);
    });

    it('sweeps expired keys of other requests occasionally', async () => {
      await call('/api/organizations', 'POST', { name: 'Old', type: 'github' }, { 'Idempotency-Key': makeIdempotencyKey() });
      state.raw.prepare('UPDATE idempotency_keys SET expires_at = 1').run();
      // The sweep runs on the first keyed request of each window
      (spec as unknown as { idempotencyCalls: number }).idempotencyCalls = 0;
      await call('/api/organizations', 'POST', { name: 'New', type: 'github' }, { 'Idempotency-Key': makeIdempotencyKey() });
      expect(keyRows()).toBe(1);
    });
  });

  describe('Header validation', () => {
    it('rejects keys over 255 characters with 400 and runs no mutation', async () => {
      const body = { name: 'Long Key Org', type: 'github' as const };
      const response = await call('/api/organizations', 'POST', body, { 'Idempotency-Key': 'a'.repeat(256) });
      expect(response.status).toBe(400);
      expect(rowCount('organizations')).toBe(0);
    });

    it('accepts a key of exactly 255 characters', async () => {
      const body = { name: 'Max Key Org', type: 'github' as const };
      const response = await call('/api/organizations', 'POST', body, { 'Idempotency-Key': 'a'.repeat(255) });
      expect(response.status).toBe(201);
    });
  });

  describe('Edge cases', () => {
    it('should handle concurrent requests with same key gracefully', async () => {
      const key = makeIdempotencyKey();
      const endpoint = '/api/organizations';
      const body = { name: `Test Org Concurrent ${Date.now()}`, type: 'github' as const };
      
      // Send multiple requests with the same key
      const promises = Array(3).fill(null).map(() =>
        call(endpoint, 'POST', body, { 'Idempotency-Key': key })
      );
      
      const responses = await Promise.allSettled(promises);
      
      // At least one should succeed (the first one)
      const successful = responses.filter(r => r.status === 'fulfilled' && r.value.status === 201);
      expect(successful.length).toBeGreaterThan(0);
      
      // All successful responses should return the same org
      const orgs = await Promise.all(
        successful.map(async r => (await (r as PromiseFulfilledResult<Response>).value.json()).data.id)
      );
      
      // All orgs should be the same (from cache)
      const uniqueOrgs = new Set(orgs);
      expect(uniqueOrgs.size).toBe(1);
      expect(successful.length).toBe(3);
      expect(rowCount('organizations')).toBe(1);
    });
  });
});

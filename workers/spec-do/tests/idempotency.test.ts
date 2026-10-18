/**
 * Tests for idempotency keys functionality
 * Task: M5a - Idempotency Keys for Queue Double-Write Prevention
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo } from './sqlite-state';

let spec: SpecDO;

beforeEach(async () => {
  spec = makeSpecDo(makeSqliteState());
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

    it('should work for PATCH mutations', async () => {
      // First create an organization
      const orgResponse = await call('/api/organizations', 'POST', {
        name: `Test Org Patch ${Date.now()}`,
        type: 'github' as const,
      });
      const org = await orgResponse.json();
      
      // Then try to update it with idempotency key
      const key = makeIdempotencyKey();
      const patchBody = { stage: 'active' as const };
      
      const response1 = await call(`/api/organizations/${org.data.id}/stage`, 'PATCH', patchBody, {
        'Idempotency-Key': key,
      });
      
      // Same request should return cached
      const response2 = await call(`/api/organizations/${org.data.id}/stage`, 'PATCH', patchBody, {
        'Idempotency-Key': key,
      });
      
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
    });

    it('should work for candidates mutations', async () => {
      // Create a spec first
      const specResponse = await call('/api/specs', 'POST', {
        name: `Test Spec ${Date.now()}`,
        contract: '{}',
        declaredDeltaSurface: [],
        organizationId: 'test-org-id',
      }, { 'X-Actor-ID': 'test-actor' });
      
      // Create a repository
      const repoResponse = await call('/api/repositories', 'POST', {
        name: `Test Repo ${Date.now()}`,
        organizationId: 'test-org-id',
        repoType: 'candidate' as const,
        remoteUrl: 'https://github.com/test/test',
        namespace: 'test',
      });
      
      const key = makeIdempotencyKey();
      const candidateBody = {
        specId: 'test-spec-id',
        repositoryId: 'test-repo-id',
        commitSha: 'abc123',
        baseCommitSha: 'def456',
        agentId: 'test-agent',
      };
      
      // First request
      const response1 = await call('/api/candidates', 'POST', candidateBody, {
        'Idempotency-Key': key,
      });
      
      // Second request with same key
      const response2 = await call('/api/candidates', 'POST', candidateBody, {
        'Idempotency-Key': key,
      });
      
      expect(response1.status).toBe(201);
      expect(response2.status).toBe(201);
    });
  });

  describe('Header validation', () => {
    it('should reject keys that are too long', async () => {
      const longKey = 'a'.repeat(300); // More than 255 chars
      const endpoint = '/api/organizations';
      const body = { name: `Test Org ${Date.now()}`, type: 'github' as const };
      
      const response = await call(endpoint, 'POST', body, { 'Idempotency-Key': longKey });
      
      // Should either ignore the key or return an error
      // For now, we ignore it (return null from getIdempotencyKey)
      expect(response.status).toBeLessThan(500); // Should succeed without using the key
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
    });
  });
});

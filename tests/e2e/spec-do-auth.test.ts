/**
 * Spec DO internal auth (local only): a worker holding the cross-script SPEC_DO binding and only
 * the tier-1 token (tests/e2e/probe on port 8792, started by scripts/start-e2e-workers.sh) can use the
 * ordinary DO routes, but cannot purge, tombstone, grant roles or mint service accounts; with no
 * token or a wrong one it gets nothing. The public edge (beehive, which holds both tokens) still
 * performs those operations.
 *
 * Never runs against production. Task: do-auth-cache | Spec: AGENTS.md#state-management
 */

import { describe, it, expect } from 'vitest';
import { getConfig } from './config';
import { createRequest, readJson } from './helpers';

const config = getConfig();
const isLocal = config.environment === 'local';

type Token = 'tier1' | 'none' | 'wrong';

async function viaProbe(method: string, path: string, body?: unknown, token: Token = 'tier1') {
  const res = await fetch(`${config.probeUrl}/forward`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, path, body, token, actorId: 'e2e-probe' }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { status: number; body: any };
}

const PRIVILEGED: Array<[string, string, unknown]> = [
  ['POST', '/internal/purge', { orgNamePrefix: 'test-org-e2e-', dryRun: true }],
  ['POST', '/internal/tombstone', { entityType: 'organization', id: 'does-not-matter' }],
  ['POST', '/internal/actors/does-not-matter/role', { role: 'maintainer' }],
  ['POST', '/internal/service-accounts', { name: 'e2e-should-not-exist' }],
  ['GET', '/internal/service-accounts', undefined],
  ['PATCH', '/api/actors/does-not-matter/promotion-authority', undefined],
];

describe.skipIf(!isLocal)('Spec DO internal auth (local)', () => {
  it('tier-1 worker reaches ordinary DO routes', async () => {
    expect((await viaProbe('GET', '/health')).status).toBe(200);
    expect((await viaProbe('GET', '/api/organizations?limit=1')).status).toBe(200);
    expect((await viaProbe('GET', '/deploy-refs/live?rung=canary')).status).toBe(200);
    expect((await viaProbe('GET', '/promotion-mode')).status).toBe(200);
  });

  it('tier-1 worker cannot purge, tombstone, grant roles, or mint/list service accounts (403)', async () => {
    for (const [method, path, body] of PRIVILEGED) {
      const result = await viaProbe(method, path, body);
      expect(result.status, `${method} ${path}`).toBe(403);
      expect(result.body.success).toBe(false);
    }
  });

  it('no token or a wrong token is 401 on every route', async () => {
    for (const token of ['none', 'wrong'] as const) {
      expect((await viaProbe('GET', '/health', undefined, token)).status).toBe(401);
      expect((await viaProbe('GET', '/api/organizations', undefined, token)).status).toBe(401);
      for (const [method, path, body] of PRIVILEGED) {
        expect((await viaProbe(method, path, body, token)).status, `${token} ${method} ${path}`).toBe(401);
      }
    }
  });

  it('the beehive edge (holds both tokens) still tombstones (admin route)', async () => {
    const actor = await fetch(createRequest('/api/actors', 'POST', { type: 'human', name: `e2e-doauth-${Date.now()}` }));
    expect(actor.status).toBe(201);
    const actorId = ((await readJson(actor)) as { data: { id: string } }).data.id;
    const headers = { 'X-Actor-ID': actorId };

    const created = await fetch(createRequest('/api/organizations', 'POST', { name: `test-org-e2e-doauth-${Date.now()}`, type: 'artifacts' }, headers));
    expect(created.status).toBe(201);
    const orgId = ((await readJson(created)) as { data: { id: string } }).data.id;

    const tombstone = await fetch(createRequest(`/api/organizations/${orgId}`, 'DELETE', { reason: 'e2e do-auth' }, headers));
    expect(tombstone.status).toBe(200);
  });
});

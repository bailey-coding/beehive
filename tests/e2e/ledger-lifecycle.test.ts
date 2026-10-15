/**
 * Ledger lifecycle E2E (local only): create a test-org-e2e-* tree, tombstone the
 * org, check include_deleted gating, then purge by prefix (dry run, confirm
 * mismatch, real run).
 *
 * Needs the beehive worker on :8787 started with PURGE_MIN_AGE_HOURS=0
 * (scripts/start-e2e-workers.sh does this). Never runs against production: purge
 * is irreversible and the maintainer bootstrap would grant a real role.
 *
 * Task: spine-item3-ledger-lifecycle | Spec: AGENTS.md#state-management
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { getConfig } from './config';
import { createRequest, readJson } from './helpers';

const isLocal = getConfig().environment === 'local';
const PREFIX = 'test-org-e2e-';

async function call(path: string, method = 'GET', body?: unknown, actorId?: string) {
  const res = await fetch(createRequest(path, method, body, actorId ? { 'X-Actor-ID': actorId } : {}));
  return { status: res.status, json: await readJson(res).catch(() => ({})) };
}

describe.skipIf(!isLocal)('Ledger lifecycle (local)', () => {
  let maintainer: string;
  let outsider: string;
  let orgId: string;
  let specId: string;
  let candidateId: string;
  const orgName = `${PREFIX}lifecycle-${Date.now()}`;

  beforeAll(async () => {
    // Reuse an existing maintainer (earlier runs) or bootstrap one by self-grant
    const actors = await call('/api/actors?limit=1000');
    const existing = (actors.json.data as { id: string; role?: string }[]).find((a) => a.role === 'maintainer');
    if (existing) {
      maintainer = existing.id;
    } else {
      const created = await call('/api/actors', 'POST', { type: 'human', name: 'e2e-maintainer' });
      maintainer = (created.json.data as { id: string }).id;
      const granted = await call(`/api/admin/actors/${maintainer}/role`, 'POST', { role: 'maintainer' }, maintainer);
      expect(granted.status).toBe(200);
    }
    outsider = ((await call('/api/actors', 'POST', { type: 'agent', name: 'e2e-outsider' })).json.data as { id: string }).id;

    const org = await call('/api/organizations', 'POST', { name: orgName, type: 'artifacts' }, maintainer);
    expect(org.status).toBe(201);
    orgId = (org.json.data as { id: string }).id;
    const repo = await call(
      '/api/repositories',
      'POST',
      { name: 'repo', organizationId: orgId, repoType: 'baseline', remoteUrl: 'https://example.invalid/r.git', namespace: 'e2e' },
      maintainer
    );
    expect(repo.status).toBe(201);
    const spec = await call(
      '/api/specs',
      'POST',
      { name: 'spec', contract: '{}', declaredDeltaSurface: [], organizationId: orgId },
      maintainer
    );
    expect(spec.status).toBe(201);
    specId = (spec.json.data as { id: string }).id;
    const cand = await call(
      '/api/candidates',
      'POST',
      { specId, repositoryId: (repo.json.data as { id: string }).id, commitSha: 'abc', baseCommitSha: 'base' },
      maintainer
    );
    expect(cand.status).toBe(201);
    candidateId = (cand.json.data as { id: string }).id;
  });

  it('tombstones the org and cascades to its spec and candidate', async () => {
    const res = await call(`/api/organizations/${orgId}`, 'DELETE', { reason: 'e2e cleanup' }, maintainer);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ entityType: 'organization', id: orgId, counts: { organizations: 1, specs: 1, candidates: 1 } });

    expect((await call(`/api/organizations/${orgId}`)).status).toBe(404);
    expect((await call(`/api/specs/${specId}`)).status).toBe(404);
    expect((await call(`/api/candidates/${candidateId}`)).status).toBe(404);
  });

  it('shows the tombstone to the maintainer only', async () => {
    const seen = await call(`/api/organizations/${orgId}?include_deleted=1`, 'GET', undefined, maintainer);
    expect(seen.status).toBe(200);
    expect(seen.json.data).toMatchObject({ id: orgId, delete_reason: 'e2e cleanup', deleted_by: maintainer });
    expect((await call(`/api/organizations/${orgId}?include_deleted=1`, 'GET', undefined, outsider)).status).toBe(403);
  });

  it('purge by prefix: non-maintainer 403, dry run, confirm mismatch 409, then real run', async () => {
    expect((await call('/api/admin/purge', 'POST', { orgNamePrefix: PREFIX }, outsider)).status).toBe(403);

    const dry = await call('/api/admin/purge', 'POST', { orgNamePrefix: PREFIX }, maintainer);
    expect(dry.status).toBe(200);
    const plan = dry.json.data as { orgIds: string[]; total: number; minAgeHours: number; skipped: { orgId: string; reason: string }[] };
    expect(plan.minAgeHours, 'start the beehive worker with PURGE_MIN_AGE_HOURS=0').toBe(0);
    expect(plan.orgIds).toContain(orgId);
    expect(plan.total).toBeGreaterThanOrEqual(4);

    const mismatch = await call('/api/admin/purge', 'POST', { orgNamePrefix: PREFIX, dryRun: false, confirm: plan.total + 1 }, maintainer);
    expect(mismatch.status).toBe(409);

    const real = await call('/api/admin/purge', 'POST', { orgNamePrefix: PREFIX, dryRun: false, confirm: plan.total }, maintainer);
    expect(real.status).toBe(200);
    expect(real.json.data).toMatchObject({ dryRun: false, total: plan.total });

    expect((await call(`/api/organizations/${orgId}?include_deleted=1`, 'GET', undefined, maintainer)).status).toBe(404);
    expect((await call(`/api/specs/${specId}?include_deleted=1`, 'GET', undefined, maintainer)).status).toBe(404);
    // entity_history survives the purge
    const history = await call(`/api/entities/spec/${specId}/history`);
    expect((history.json.data as { stage: string }[]).map((h) => h.stage)).toEqual(expect.arrayContaining(['tombstoned', 'purged']));
  });
});

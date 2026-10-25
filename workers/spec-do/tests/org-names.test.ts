/**
 * Organization names become Artifacts namespaces (fork-created candidate repos) that the sandbox runner builds from, so new
 * organizations must carry a valid namespace name. Existing rows are never re-checked. Spec: docs/SF-8-NAMESPACE-PLAN.md
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo } from './sqlite-state';

let spec: SpecDO;

beforeEach(async () => {
  spec = makeSpecDo(makeSqliteState());
  await spec.init();
});

const create = (name: unknown) =>
  spec.fetch(new Request('https://spec-do.internal/api/organizations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: 'artifacts' }),
  }));

describe('POST /api/organizations name validation', () => {
  it('rejects a name that is not a valid Artifacts namespace with 400, and writes nothing', async () => {
    for (const bad of ['my.org', '_x', '-x', 'a b', 'a/b', '', 'x'.repeat(65), '<img src=x>', null, 5]) {
      const res = await create(bad);
      expect(res.status, String(bad)).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, error: expect.stringContaining('organization name') });
    }
    const list = await (await spec.fetch(new Request('https://spec-do.internal/api/organizations'))).json() as { data: unknown[] };
    expect(list.data).toHaveLength(0);
  });

  it('accepts valid names, including the longest one', async () => {
    for (const ok of ['my-org', 'Org_1', 'a', 'x'.repeat(64), 'test-org-e2e-sbx-1']) {
      expect((await create(ok)).status, ok).toBe(201);
    }
  });

  it('does not re-check organizations that already exist (legacy names stay readable)', () => {
    const legacy = spec.createOrganization('Legacy Org.inc', 'github');
    expect(spec.getOrganization(legacy.id)?.name).toBe('Legacy Org.inc');
  });
});

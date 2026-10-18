/**
 * SpecDO ledger lifecycle: tombstones (soft delete + logical cascade),
 * ?include_deleted=1 gating, maintainer role, purge (hard delete), and the
 * m4 -> m5 migration. Real SQL (node:sqlite, FKs on) through the real router.
 *
 * Task: spine-item3-ledger-lifecycle | Spec: AGENTS.md#state-management
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { authedDo, TEST_DO_TOKENS } from './do-tokens';
import { generateServiceToken, hashToken, tokenPrefix } from '../../shared/service-tokens';
import type { PurgeResult, TombstoneResult } from '../../shared/ledger-lifecycle';

let store: SqliteState;
let spec: SpecDO;
let maintainer: string;
let agent: string;

function call(path: string, method = 'GET', body?: unknown, actorId?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (actorId) headers['X-Actor-ID'] = actorId;
  return spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

const count = (sql: string, ...params: string[]) =>
  (store.raw.prepare(sql).get(...params) as { n: number }).n;

/** org -> repo -> spec -> two candidates, one issue, plus dependents of every kind */
function seedOrg(name: string) {
  const org = spec.createOrganization(name, 'artifacts');
  const repo = spec.createRepository(`${name}-repo`, org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
  const s = spec.createSpec(`${name}-spec`, 'd', 'contract', [], org.id, agent);
  const c1 = spec.createCandidate(s.id, repo.id, 'sha1', 'base', agent);
  const c2 = spec.createCandidate(s.id, repo.id, 'sha2', 'base', agent);
  const issue = spec.createIssue(1, repo.id, 'bug', 'body', agent);
  spec.createIssueComment(issue.id, 'comment', agent);
  spec.createGateVerdict(c1.id, 'pre-merge', 'pass', 90, 0, agent);
  // Raw insert so the trial is already decided (createTrial makes a pending one)
  store.raw
    .prepare(`INSERT INTO trials (id, spec_id, candidate_a_id, candidate_b_id, comparison_metrics, decided_at, decided_by)
              VALUES (?, ?, ?, ?, '{}', ?, ?)`)
    .run(`trial-${name}`, s.id, c1.id, c2.id, Date.now(), agent);
  spec.createPromotion(c1.id, 'pre-merge', 'shadow', agent);
  return { org, repo, spec: s, c1, c2, issue };
}

async function tombstone(path: string, actorId = maintainer, reason?: string): Promise<Response> {
  const [, , segment, id] = path.split('/');
  const entityType = { organizations: 'organization', repositories: 'repository', specs: 'spec', candidates: 'candidate' }[segment];
  return call('/internal/tombstone', 'POST', { entityType, id, ...(reason ? { reason } : {}) }, actorId);
}

/** Make every tombstone in the ledger older than the default 24h purge age */
function ageTombstones(hours = 25) {
  const at = Date.now() - hours * 3_600_000;
  for (const t of ['organizations', 'repositories', 'specs', 'candidates', 'issues']) {
    store.raw.prepare(`UPDATE ${t} SET deleted_at = ? WHERE deleted_at IS NOT NULL`).run(at);
  }
}

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  maintainer = spec.createActor('human', 'maint').id;
  agent = spec.createActor('agent', 'agent-1').id;
  store.raw.prepare(`UPDATE actors SET role = 'maintainer' WHERE id = ?`).run(maintainer);
});

describe('m4 -> m5 migration', () => {
  const columns = (s: SqliteState, table: string) =>
    (s.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const version = (s: SqliteState) =>
    (s.raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value: string }).value;

  it('a fresh ledger has the lifecycle columns and purge_log before its first request', () => {
    for (const t of ['organizations', 'repositories', 'specs', 'candidates', 'issues']) {
      expect(columns(store, t)).toEqual(expect.arrayContaining(['deleted_at', 'deleted_by', 'delete_reason']));
    }
    expect(columns(store, 'actors')).toContain('role');
    expect(columns(store, 'purge_log').length).toBeGreaterThan(0);
  });

  it('adds columns to an m4 ledger additively, keeps rows, and is idempotent', async () => {
    // An m4 ledger from before this change: rebuild it without the m5 columns
    const raw = makeSqliteState().raw;
    const fresh = makeSqliteState(raw);
    const old = makeSpecDo(fresh);
    await old.init();
    old.createOrganization('existing-org', 'github');
    raw.exec('DROP TABLE purge_log');
    for (const t of ['organizations', 'repositories', 'specs', 'candidates', 'issues']) {
      for (const idx of ['deleted']) raw.exec(`DROP INDEX IF EXISTS idx_${t}_${idx}`);
      for (const c of ['deleted_at', 'deleted_by', 'delete_reason']) raw.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    }
    raw.exec('ALTER TABLE actors DROP COLUMN role');
    raw.exec("UPDATE metadata SET value = 'm4' WHERE key = 'schema_version'");

    const restarted = makeSqliteState(raw, fresh.kv);
    await makeSpecDo(restarted).init();
    // m5 -> m6 (service tokens) and m6 -> m7 (deploy refs) run in the same pass
    expect(version(restarted)).toBe('m9');
    expect(columns(restarted, 'organizations')).toEqual(expect.arrayContaining(['deleted_at', 'deleted_by', 'delete_reason']));
    expect(columns(restarted, 'actors')).toContain('role');
    expect(raw.prepare("SELECT COUNT(*) AS n FROM organizations WHERE name = 'existing-org' AND deleted_at IS NULL").get()).toEqual({ n: 1 });

    await makeSpecDo(makeSqliteState(raw, fresh.kv)).init();
    expect(version(restarted)).toBe('m9');
  });

  it('does not touch the entity_history CHECK', () => {
    const sql = (store.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'entity_history'").get() as { sql: string }).sql;
    expect(sql).toContain("'issue', 'candidate', 'spec', 'trial', 'promotion', 'gate_verdict', 'service_account'");
    expect(sql).not.toContain("'organization'");
  });
});

describe('tombstone', () => {
  it('hides the row from list and get, and records who and why', async () => {
    const { c1 } = seedOrg('org-a');
    const res = await tombstone(`/api/candidates/${c1.id}`, maintainer, 'bad candidate');
    expect(res.status).toBe(200);
    expect(await data<TombstoneResult>(res)).toMatchObject({ entityType: 'candidate', id: c1.id, counts: { candidates: 1 } });

    expect((await call(`/api/candidates/${c1.id}`)).status).toBe(404);
    const list = await data<{ id: string }[]>(await call('/api/candidates'));
    expect(list.map((c) => c.id)).not.toContain(c1.id);
    expect(list).toHaveLength(1);

    expect(store.raw.prepare('SELECT deleted_by, delete_reason FROM candidates WHERE id = ?').get(c1.id)).toEqual({
      deleted_by: maintainer,
      delete_reason: 'bad candidate',
    });
    expect(count(`SELECT COUNT(*) AS n FROM entity_history WHERE entity_id = ? AND stage = 'tombstoned'`, c1.id)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM purge_log WHERE action = 'tombstone' AND outcome = 'completed'`)).toBe(1);
  });

  it('cascades from an organization to its repos, specs, candidates and issues in one transaction', async () => {
    const a = seedOrg('org-a');
    const b = seedOrg('org-b');
    const before = store.transactions.count;
    const res = await tombstone(`/api/organizations/${a.org.id}`);
    expect(res.status).toBe(200);
    expect(store.transactions.count - before).toBe(1);
    expect((await data<TombstoneResult>(res)).counts).toEqual({
      organizations: 1,
      repositories: 1,
      specs: 1,
      candidates: 2,
      issues: 1,
    });

    for (const path of [
      `/api/organizations/${a.org.id}`,
      `/api/repositories/${a.repo.id}`,
      `/api/specs/${a.spec.id}`,
      `/api/candidates/${a.c2.id}`,
      `/api/issues/${a.issue.id}`,
    ]) {
      expect((await call(path)).status).toBe(404);
    }
    // org-b is untouched
    expect((await call(`/api/specs/${b.spec.id}`)).status).toBe(200);
    expect((await data<unknown[]>(await call('/api/organizations'))).length).toBe(1);
    // a tombstoned spec cannot be claimed
    expect((await call(`/api/specs/${a.spec.id}/claim`, 'POST', {}, agent)).status).toBe(404);
  });

  it('cascades from a spec to its candidates only', async () => {
    const a = seedOrg('org-a');
    const res = await tombstone(`/api/specs/${a.spec.id}`);
    expect((await data<TombstoneResult>(res)).counts).toEqual({ specs: 1, candidates: 2 });
    expect((await call(`/api/repositories/${a.repo.id}`)).status).toBe(200);
    expect((await call(`/api/issues/${a.issue.id}`)).status).toBe(200);
  });

  it('is 404 for an unknown id and 409 when already tombstoned', async () => {
    const a = seedOrg('org-a');
    expect((await tombstone('/api/specs/nope')).status).toBe(404);
    expect((await tombstone(`/api/specs/${a.spec.id}`)).status).toBe(200);
    expect((await tombstone(`/api/specs/${a.spec.id}`)).status).toBe(409);
  });

  it('is refused (409) while a candidate in scope has an active promotion, and changes nothing', async () => {
    const a = seedOrg('org-a');
    store.raw.prepare(`UPDATE promotions SET stage = 'active' WHERE candidate_id = ?`).run(a.c1.id);
    const res = await tombstone(`/api/organizations/${a.org.id}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(a.c1.id);
    expect(count('SELECT COUNT(*) AS n FROM organizations WHERE deleted_at IS NOT NULL')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM candidates WHERE deleted_at IS NOT NULL')).toBe(0);
  });

  it('an in-flight promotion state also blocks it', async () => {
    const a = seedOrg('org-a');
    const state = {
      id: 'p1', candidateId: a.c2.id, specId: a.spec.id, currentRung: 'shadow', targetRung: 'train',
      status: 'in_progress', mode: 'tournament', startedAt: '2026-10-15T00:00:00.000Z',
    };
    expect((await call('/promotion-states', 'POST', state)).status).toBe(201);
    expect((await tombstone(`/api/candidates/${a.c2.id}`)).status).toBe(409);
  });

  it('frees the organization name for reuse', async () => {
    const a = seedOrg('org-a');
    await tombstone(`/api/organizations/${a.org.id}`);
    expect((await call('/api/organizations', 'POST', { name: 'org-a', type: 'github' })).status).toBe(201);
  });

  it('rejects an invalid payload (400)', async () => {
    expect((await call('/internal/tombstone', 'POST', { entityType: 'issue', id: 'x' }, maintainer)).status).toBe(400);
    expect((await call('/internal/tombstone', 'POST', { entityType: 'spec', id: 'x', extra: 1 }, maintainer)).status).toBe(400);
  });
});

describe('?include_deleted=1', () => {
  it('shows tombstoned rows with their tombstone fields to a maintainer only', async () => {
    const a = seedOrg('org-a');
    await tombstone(`/api/organizations/${a.org.id}`, maintainer, 'test cleanup');

    const listed = await data<{ id: string; deleted_at?: number; delete_reason?: string }[]>(
      await call('/api/organizations?include_deleted=1', 'GET', undefined, maintainer)
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: a.org.id, delete_reason: 'test cleanup', deleted_by: maintainer });
    expect(typeof listed[0].deleted_at).toBe('number');

    const cand = await data<{ deletedAt?: number }>(
      await call(`/api/candidates/${a.c1.id}?include_deleted=1`, 'GET', undefined, maintainer)
    );
    expect(typeof cand.deletedAt).toBe('number');
    expect((await call(`/api/issues?include_deleted=1&repositoryId=${a.repo.id}`, 'GET', undefined, maintainer)).status).toBe(200);
  });

  it('is 403 for a non-maintainer or anonymous actor', async () => {
    seedOrg('org-a');
    expect((await call('/api/organizations?include_deleted=1', 'GET', undefined, agent)).status).toBe(403);
    expect((await call('/api/specs?include_deleted=1')).status).toBe(403);
  });

  it('live rows serialize exactly as before (no tombstone fields)', async () => {
    const a = seedOrg('org-a');
    const org = await data<Record<string, unknown>>(await call(`/api/organizations/${a.org.id}`));
    expect(Object.keys(org)).not.toContain('deleted_at');
  });
});

describe('maintainer role', () => {
  it('a maintainer grants and revokes the role; a non-maintainer is 403', async () => {
    expect((await call(`/internal/actors/${agent}/role`, 'POST', { role: 'maintainer' }, agent)).status).toBe(403);
    expect((await call(`/internal/actors/${agent}/role`, 'POST', { role: 'maintainer' }, maintainer)).status).toBe(200);
    expect(spec.isMaintainer(agent)).toBe(true);
    expect((await call(`/internal/actors/${agent}/role`, 'POST', { role: null }, maintainer)).status).toBe(200);
    expect(spec.isMaintainer(agent)).toBe(false);
    expect(count(`SELECT COUNT(*) AS n FROM purge_log WHERE action = 'role_change'`)).toBe(2);
  });

  it('bootstrap: with no maintainer, an actor may grant the role to itself only', async () => {
    store.raw.exec(`UPDATE actors SET role = NULL`);
    expect((await call(`/internal/actors/${maintainer}/role`, 'POST', { role: 'maintainer' }, agent)).status).toBe(403);
    expect((await call(`/internal/actors/${agent}/role`, 'POST', { role: 'maintainer' }, agent)).status).toBe(200);
    // Bootstrap is over: self-grant no longer works for others
    expect((await call(`/internal/actors/${maintainer}/role`, 'POST', { role: 'maintainer' }, maintainer)).status).toBe(403);
  });

  it('exposes role on the actor and 404s an unknown actor', async () => {
    const actor = await data<{ role?: string }>(await call(`/api/actors/${maintainer}`));
    expect(actor.role).toBe('maintainer');
    expect((await call('/internal/actors/nope/role', 'POST', { role: 'maintainer' }, maintainer)).status).toBe(404);
  });
});

describe('purge', () => {
  const purge = (body: unknown, actorId = maintainer) => call('/internal/purge', 'POST', body, actorId);

  it('is 403 for a non-maintainer, including the dry run', async () => {
    expect((await purge({ orgNamePrefix: 'org-' }, agent)).status).toBe(403);
    expect((await purge({ orgNamePrefix: 'org-' }, 'unknown')).status).toBe(403);
  });

  it('dry-runs by default, counting tombstoned rows and their dependents without deleting', async () => {
    const a = seedOrg('org-a');
    await tombstone(`/api/organizations/${a.org.id}`);
    ageTombstones();
    const res = await purge({ orgNamePrefix: 'org-' });
    expect(res.status).toBe(200);
    const result = await data<PurgeResult>(res);
    expect(result).toMatchObject({ dryRun: true, orgIds: [a.org.id], skipped: [], batches: 0 });
    expect(result.counts).toEqual({
      issue_comments: 1, issue_candidate_links: 0, issue_spec_links: 0, gate_verdicts: 1, promotions: 1,
      trials: 1, issues: 1, candidates: 2, repositories: 1, specs: 1, organizations: 1,
    });
    expect(result.total).toBe(10);
    expect(count('SELECT COUNT(*) AS n FROM organizations')).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM purge_log WHERE action = 'purge' AND outcome = 'dry_run'`)).toBe(1);
  });

  it('hard-deletes with the matching confirm, keeping entity_history and purge_log', async () => {
    const a = seedOrg('org-a');
    const b = seedOrg('other-b');
    await tombstone(`/api/organizations/${a.org.id}`);
    await tombstone(`/api/organizations/${b.org.id}`);
    ageTombstones();
    const historyBefore = count('SELECT COUNT(*) AS n FROM entity_history');
    const { total } = await data<PurgeResult>(await purge({ orgNamePrefix: 'org-' }));

    const res = await purge({ orgNamePrefix: 'org-', dryRun: false, confirm: total });
    expect(res.status).toBe(200);
    expect(await data<PurgeResult>(res)).toMatchObject({ dryRun: false, total: 10, batches: 1 });

    expect(count('SELECT COUNT(*) AS n FROM organizations WHERE id = ?', a.org.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM candidates WHERE spec_id = ?', a.spec.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM issue_comments')).toBe(1); // org-b's
    // the prefix did not match other-b, which is tombstoned but kept
    expect(count('SELECT COUNT(*) AS n FROM organizations WHERE id = ?', b.org.id)).toBe(1);
    // audit survives and grows: purged rows get a history row (spec, candidates, issue)
    expect(count('SELECT COUNT(*) AS n FROM entity_history')).toBe(historyBefore + 4);
    expect(count(`SELECT COUNT(*) AS n FROM entity_history WHERE entity_id = ? AND stage = 'purged'`, a.c1.id)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM purge_log WHERE action = 'purge' AND outcome = 'completed' AND dry_run = 0`)).toBe(1);
  });

  it('confirm that does not match the dry-run total is 409 and deletes nothing', async () => {
    const a = seedOrg('org-a');
    await tombstone(`/api/organizations/${a.org.id}`);
    ageTombstones();
    const res = await purge({ orgNamePrefix: 'org-', dryRun: false, confirm: 3 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('does not match');
    expect(count('SELECT COUNT(*) AS n FROM organizations')).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM purge_log WHERE outcome = 'refused'`)).toBe(1);
  });

  it('a real run without confirm is 400', async () => {
    expect((await purge({ orgNamePrefix: 'org-', dryRun: false })).status).toBe(400);
    expect((await purge({ orgNamePrefix: 'org-', orgIds: ['x'] })).status).toBe(400);
    expect((await purge({})).status).toBe(400);
  });

  it('skips tombstones younger than the minimum age (default 24h)', async () => {
    const a = seedOrg('org-a');
    await tombstone(`/api/organizations/${a.org.id}`);
    ageTombstones(23);
    const result = await data<PurgeResult>(await purge({ orgNamePrefix: 'org-' }));
    expect(result).toMatchObject({ minAgeHours: 24, orgIds: [], total: 0 });
    expect(result.skipped).toEqual([{ orgId: a.org.id, name: 'org-a', reason: 'too_recent' }]);
    // confirm 0 on an empty plan deletes nothing
    expect((await purge({ orgNamePrefix: 'org-', dryRun: false, confirm: 0 })).status).toBe(200);
    expect(count('SELECT COUNT(*) AS n FROM organizations')).toBe(1);
  });

  it('PURGE_MIN_AGE_HOURS overrides the minimum age', async () => {
    spec = authedDo(new SpecDO(store.state as never, { ...TEST_DO_TOKENS, PURGE_MIN_AGE_HOURS: '0' } as never));
    await spec.init();
    const a = seedOrg('org-a');
    await tombstone(`/api/organizations/${a.org.id}`);
    const result = await data<PurgeResult>(await purge({ orgIds: [a.org.id] }));
    expect(result).toMatchObject({ minAgeHours: 0, orgIds: [a.org.id], total: 10 });
  });

  it('skips live orgs and orgs with live descendants', async () => {
    const live = seedOrg('org-live');
    const a = seedOrg('org-a');
    await tombstone(`/api/organizations/${a.org.id}`);
    ageTombstones();
    // a spec created under the org after it was tombstoned is live
    spec.createSpec('late', 'd', 'c', [], a.org.id, agent);
    const result = await data<PurgeResult>(await purge({ orgNamePrefix: 'org-' }));
    expect(result.orgIds).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { orgId: live.org.id, name: 'org-live', reason: 'not_tombstoned' },
        { orgId: a.org.id, name: 'org-a', reason: 'live_descendants' },
      ])
    );
  });

  it('refuses (409) when a target candidate has an active promotion', async () => {
    const a = seedOrg('org-a');
    await tombstone(`/api/organizations/${a.org.id}`);
    ageTombstones();
    // promoted after the tombstone (e.g. by a promotion worker that does not read tombstones)
    store.raw.prepare(`UPDATE promotions SET stage = 'active' WHERE candidate_id = ?`).run(a.c1.id);
    const dry = await purge({ orgNamePrefix: 'org-' });
    expect(dry.status).toBe(409);
    const real = await purge({ orgNamePrefix: 'org-', dryRun: false, confirm: 10 });
    expect(real.status).toBe(409);
    expect(count('SELECT COUNT(*) AS n FROM candidates')).toBe(2);
  });

  it('runs in batches of at most 500 rows, children before parents, one transaction each', async () => {
    const a = seedOrg('org-a');
    // 600 extra candidates -> 610 rows -> 2 batches
    for (let i = 0; i < 600; i++) spec.createCandidate(a.spec.id, a.repo.id, `sha-${i}`, 'base', agent);
    await tombstone(`/api/organizations/${a.org.id}`);
    ageTombstones();
    const { total } = await data<PurgeResult>(await purge({ orgNamePrefix: 'org-a' }));
    expect(total).toBe(610);
    const before = store.transactions.count;
    const res = await purge({ orgNamePrefix: 'org-a', dryRun: false, confirm: total });
    expect(res.status).toBe(200);
    expect((await data<PurgeResult>(res)).batches).toBe(2);
    expect(store.transactions.count - before).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM candidates')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM organizations')).toBe(0);
  });
});

describe('reserved organization', () => {
  const purge = (body: unknown) => call('/internal/purge', 'POST', body, maintainer);
  // No organizationId: attributed to the reserved org
  const mintUnscoped = async (name: string) => {
    const plaintext = generateServiceToken();
    return call(
      '/internal/service-accounts',
      'POST',
      { name, scopes: ['read'], tokenHash: await hashToken(plaintext), tokenPrefix: tokenPrefix(plaintext), expiresAt: Date.now() + 86_400_000 },
      maintainer
    );
  };

  async function ensureReserved() {
    // An unscoped mint creates the reserved org lazily
    const res = await mintUnscoped('unscoped-svc');
    expect(res.status).toBe(201);
    expect(count(`SELECT COUNT(*) AS n FROM organizations WHERE id = 'beehive-system'`)).toBe(1);
  }

  it('cannot be tombstoned (403), and unscoped mints keep working', async () => {
    await ensureReserved();
    const res = await tombstone('/api/organizations/beehive-system');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('reserved');
    expect(count(`SELECT COUNT(*) AS n FROM organizations WHERE id = 'beehive-system' AND deleted_at IS NULL`)).toBe(1);
    expect((await mintUnscoped('second-svc')).status).toBe(201);
  });

  it('cannot be purged by id (403)', async () => {
    await ensureReserved();
    const res = await purge({ orgIds: ['beehive-system'] });
    expect(res.status).toBe(403);
    expect(count(`SELECT COUNT(*) AS n FROM organizations WHERE id = 'beehive-system'`)).toBe(1);
  });

  it('is skipped as reserved when a name prefix matches it, even if already tombstoned', async () => {
    await ensureReserved();
    // Damage from before the guard: the reserved org was tombstoned long ago
    store.raw.prepare(`UPDATE organizations SET deleted_at = 1 WHERE id = 'beehive-system'`).run();
    const result = await data<PurgeResult>(await purge({ orgNamePrefix: 'beehive-', dryRun: false, confirm: 0 }));
    expect(result.orgIds).toEqual([]);
    expect(result.skipped).toEqual([{ orgId: 'beehive-system', name: 'beehive-system', reason: 'reserved' }]);
    expect(count(`SELECT COUNT(*) AS n FROM organizations WHERE id = 'beehive-system'`)).toBe(1);
  });
});

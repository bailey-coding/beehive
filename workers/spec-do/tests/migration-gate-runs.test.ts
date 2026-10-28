/**
 * migration m13: gate_runs and the candidates.preview_* columns. The matrix (migration-matrix.test.ts) already runs A1-A4 over
 * every legacy shape, including ledgers created fresh at m11 and m12 that lack the preview columns; this file pins what is
 * specific to m13: the repair of those ledgers, the step replayed, the table's shape, and that the m12 refusal is untouched.
 *
 * Task: real-gate-slice5 | Spec: docs/REAL-GATE-IMPL-PLAN.md §3
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeSpecDo, type SqliteState } from './sqlite-state';
import { loadLegacyLedger, readVersion, freshLedger, LATEST_VERSION } from './legacy-ledger';
import { legacyFixtures } from './fixtures/legacy';

type Row = Record<string, unknown>;
const all = (s: SqliteState, sql: string) => s.raw.prepare(sql).all() as Row[];
const cols = (s: SqliteState, t: string) => all(s, `PRAGMA table_info(${t})`).map((c) => c.name as string);
const tables = (s: SqliteState) => all(s, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name as string);
const PREVIEW = ['preview_url', 'preview_worker_name', 'preview_created_at'];
const fixture = (name: string) => {
  const f = legacyFixtures().find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
};
const load = (name: string) => {
  const f = fixture(name);
  return loadLegacyLedger({ ddl: f.ddl, seed: f.seed, version: f.startVersion });
};

afterEach(() => vi.restoreAllMocks());

describe('migration m13: gate_runs and the preview columns', () => {
  it('the latest version is m13 or later and a fresh ledger has gate_runs and the preview columns without running a step', async () => {
    expect(Number(LATEST_VERSION.slice(1))).toBeGreaterThanOrEqual(13);
    const fresh = await freshLedger();
    expect(readVersion(fresh)).toBe(LATEST_VERSION);
    expect(tables(fresh)).toContain('gate_runs');
    expect(cols(fresh, 'candidates')).toEqual(expect.arrayContaining(PREVIEW));
  });

  it.each(['m11-fresh-no-preview', 'm12-fresh-no-preview'])(
    'a ledger created fresh at %s (stamped, never ran m2) has no preview columns before, and gets them with gate_runs from m13',
    async (name) => {
      const s = load(name);
      for (const c of PREVIEW) expect(cols(s, 'candidates')).not.toContain(c);
      expect(tables(s)).not.toContain('gate_runs');
      const rowsBefore = all(s, 'SELECT id, spec_id, repository_id, commit_sha, base_commit_sha, agent_id, created_at, stage FROM candidates');
      expect(rowsBefore.length).toBeGreaterThan(0);

      await makeSpecDo(s).init();

      expect(readVersion(s)).toBe(LATEST_VERSION);
      expect(cols(s, 'candidates')).toEqual(expect.arrayContaining(PREVIEW));
      expect(tables(s)).toContain('gate_runs');
      expect(all(s, 'SELECT id, spec_id, repository_id, commit_sha, base_commit_sha, agent_id, created_at, stage FROM candidates')).toEqual(rowsBefore);
      expect(all(s, 'SELECT preview_url, preview_worker_name, preview_created_at FROM candidates')).toEqual(
        rowsBefore.map(() => ({ preview_url: null, preview_worker_name: null, preview_created_at: null }))
      );
    }
  );

  it('and the repaired ledger reads a preview back, and a run on a repository without a namespace is refused by name', async () => {
    const s = load('m12-fresh-no-preview');
    const spec = makeSpecDo(s);
    await spec.init();
    s.raw.prepare("UPDATE candidates SET preview_url = 'https://p.example', preview_worker_name = 'w', preview_created_at = 5 WHERE id = 'cand-1'").run();
    expect(spec.getCandidate('cand-1')).toMatchObject({ preview_url: 'https://p.example', preview_worker_name: 'w', preview_created_at: 5 });
    const res = await spec.fetch(
      new Request('https://spec-do.internal/api/gate-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'cand-1', gate: 'pre-merge', commitSha: 'b'.repeat(40), decidedBy: 'act-1' }),
      })
    );
    // the seed repository has no namespace: the route refuses it by name instead of starting a run it cannot clone
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('namespace');
  });

  it('a migrated ledger that already has the preview columns (m2 added them) is not an error, and keeps them', async () => {
    const s = load('m11-19705f8');
    expect(cols(s, 'candidates')).toEqual(expect.arrayContaining(PREVIEW));
    await makeSpecDo(s).init();
    expect(readVersion(s)).toBe(LATEST_VERSION);
    expect(cols(s, 'candidates').filter((c) => PREVIEW.includes(c))).toHaveLength(3);
  });

  it('replaying the m13 step from m12 changes nothing, with rows in gate_runs', async () => {
    const s = load('m12-migrated');
    const spec = makeSpecDo(s);
    await spec.init();
    s.raw
      .prepare(
        `INSERT INTO gate_runs (id, candidate_id, gate, commit_sha, attempt, status, decided_by, started_at)
         VALUES ('r1', 'cand-1', 'pre-merge', ?, 1, 'running', 'act-1', 1)`
      )
      .run('c'.repeat(40));
    const master = () => JSON.stringify(all(s, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"));
    const before = [master(), JSON.stringify(all(s, 'SELECT * FROM gate_runs'))];
    s.raw.exec("UPDATE metadata SET value = 'm12' WHERE key = 'schema_version'");
    await makeSpecDo(s).init();
    expect(readVersion(s)).toBe(LATEST_VERSION);
    expect([master(), JSON.stringify(all(s, 'SELECT * FROM gate_runs'))]).toEqual(before);
  });

  it('gate_runs has the planned shape: a foreign key to actors only (candidate_id is logical), a status CHECK, a unique attempt per sha', async () => {
    const s = await freshLedger();
    expect(cols(s, 'gate_runs')).toEqual([
      'id', 'candidate_id', 'gate', 'commit_sha', 'attempt', 'status', 'failure_class', 'exit_code', 'checks', 'timings', 'runner',
      'instance', 'image_digest', 'tests_passed', 'tests_failed', 'duration_ms', 'log_tail', 'log_sha256', 'log_truncated',
      'decided_by', 'started_at', 'finished_at',
    ]);
    // docs/OPS.md rollback floor: a new table may reference only actors, or an m12-floor build's purge fails on it
    expect(all(s, 'PRAGMA foreign_key_list(gate_runs)').map((f) => [f.table, f.from])).toEqual([['actors', 'decided_by']]);
    const indexes = all(s, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'gate_runs' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
    expect(indexes).toEqual(['idx_gate_runs_candidate', 'idx_gate_runs_started', 'idx_gate_runs_status']);

    const ins = (id: string, attempt: number, status = 'running', cand = 'c1') =>
      s.raw.prepare(`INSERT INTO gate_runs (id, candidate_id, gate, commit_sha, attempt, status, decided_by, started_at) VALUES (?, ?, 'pre-merge', ?, ?, ?, 'a1', 1)`).run(id, cand, 'd'.repeat(40), attempt, status);
    s.raw.exec("INSERT INTO organizations (id, name, type, created_at) VALUES ('o1', 'o', 'artifacts', 1)");
    s.raw.exec("INSERT INTO actors (id, type, name, created_at) VALUES ('a1', 'human', 'h', 1)");
    s.raw.exec("INSERT INTO repositories (id, name, organization_id, repo_type, remote_url, created_at) VALUES ('rp', 'r', 'o1', 'baseline', 'u', 1)");
    s.raw.exec("INSERT INTO specs (id, name, contract, declared_delta_surface, organization_id, created_by, created_at) VALUES ('sp', 's', '{}', '[]', 'o1', 'a1', 1)");
    s.raw.exec("INSERT INTO candidates (id, spec_id, repository_id, commit_sha, base_commit_sha, agent_id, created_at) VALUES ('c1', 'sp', 'rp', 'x', 'y', 'a1', 1)");
    ins('r1', 1);
    expect(() => ins('r2', 1)).toThrow(/UNIQUE/);
    expect(() => ins('r3', 2, 'weird')).toThrow(/CHECK/);
    // the table itself accepts an unknown candidate (no FK); the route refuses it with a 404 (gate-runs.test.ts)
    expect(() => ins('r4', 2, 'running', 'ghost')).not.toThrow();
    expect(() => ins('r5', 0)).toThrow(/CHECK/);
    expect(() => ins('r6', 3, 'not_run')).not.toThrow();
  });

  it('every legacy start in the matrix ends with gate_runs and the preview columns (nothing relies on a particular start)', async () => {
    for (const f of legacyFixtures()) {
      const s = loadLegacyLedger({ ddl: f.ddl, seed: f.seed, version: f.startVersion });
      await makeSpecDo(s).init();
      expect(tables(s), f.name).toContain('gate_runs');
      expect(cols(s, 'candidates'), f.name).toEqual(expect.arrayContaining(PREVIEW));
    }
  });

  describe('rollback floor (docs/OPS.md): a build older than m13 over an m13 ledger can still purge', () => {
    it('with gate_runs rows and foreign keys ON, deleting an org\'s rows the way an m12 ORG_PURGE_ORDER does (no gate_runs entry, children first) succeeds and leaves the runs', async () => {
      const s = await freshLedger();
      const spec = makeSpecDo(s);
      await spec.init();
      const actor = spec.createActor('human', 'maint').id;
      const org = spec.createOrganization('floor-org', 'artifacts');
      const repo = spec.createRepository('floor-repo', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'floor-org');
      const sp = spec.createSpec('floor-spec', 'd', 'contract', [], org.id, actor);
      const cand = spec.createCandidate(sp.id, repo.id, 'sha', 'base', actor);
      const post = (path: string, body: unknown) =>
        spec.fetch(new Request(`https://spec-do.internal${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      const started = (await (await post('/api/gate-runs', { candidateId: cand.id, gate: 'pre-merge', commitSha: 'a'.repeat(40), decidedBy: actor })).json()) as { data: { runId: string } };
      await post(`/api/gate-runs/${started.data.runId}/result`, {
        status: 'pass',
        checks: { tests: 'verified', conformance: 'not_run', complexity: 'not_run' },
        timings: {},
        instance: 'standard-2',
      });
      expect(all(s, 'SELECT COUNT(*) AS n FROM gate_runs')[0].n).toBe(1);
      expect(all(s, 'PRAGMA foreign_keys')[0].foreign_keys).toBe(1);

      // the m12 list, written out: gate_verdicts, candidates, repositories, specs, organizations (nothing names gate_runs)
      expect(() => {
        s.raw.prepare('DELETE FROM gate_verdicts WHERE candidate_id = ?').run(cand.id);
        s.raw.prepare('DELETE FROM candidates WHERE id = ?').run(cand.id);
        s.raw.prepare('DELETE FROM repositories WHERE organization_id = ?').run(org.id);
        s.raw.prepare('DELETE FROM specs WHERE organization_id = ?').run(org.id);
        s.raw.prepare('DELETE FROM organizations WHERE id = ?').run(org.id);
      }).not.toThrow();
      expect(all(s, 'SELECT COUNT(*) AS n FROM gate_runs')[0].n).toBe(1); // orphan, swept by the next m13 purge (purge-local.test.ts)
    });
  });

  describe('untouched: the m12 duplicate refusal still stops a ledger at m11, before m13 is attempted', () => {
    it('duplicate github identities from m11: named error, version stays m11, no gate_runs table, no preview repair, rows intact', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const s = load('m11-fresh-no-preview');
      s.raw.exec("INSERT INTO actors (id, type, name, github_user_id, created_at) VALUES ('d1', 'human', 'd1', '77', 1), ('d2', 'human', 'd2', '77', 1)");
      const actorsBefore = all(s, 'SELECT * FROM actors ORDER BY id');

      await expect(makeSpecDo(s).init()).rejects.toThrow(/^DuplicateGithubIdentityError: m12 refused/);

      expect(readVersion(s)).toBe('m11');
      expect(tables(s)).not.toContain('gate_runs');
      expect(cols(s, 'candidates')).not.toContain('preview_url');
      expect(all(s, 'SELECT * FROM actors ORDER BY id')).toEqual(actorsBefore);

      // the human fix, then the retry runs m12 and m13 in order
      s.raw.exec("UPDATE actors SET github_user_id = NULL WHERE id = 'd2'");
      await makeSpecDo(s).init();
      expect(readVersion(s)).toBe(LATEST_VERSION);
      expect(tables(s)).toContain('gate_runs');
    });
  });
});

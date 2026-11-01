/**
 * migration m14: the governance tables (docs/M5A-2-GOVERNANCE-PLAN.md PR-A, schema only, no writers). The matrix
 * (migration-matrix.test.ts) runs A1-A4 over every legacy shape; this file pins what is specific to m14: the table shapes, the
 * epoch, the replayed step, and the rollback floor (new tables reference only actors).
 *
 * Task: m5a2-pra | Spec: docs/M5A-2-GOVERNANCE-PLAN.md "Migration m14", docs/OPS.md "Rollback floor"
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeSpecDo, type SqliteState } from './sqlite-state';
import { loadLegacyLedger, readVersion, freshLedger, LATEST_VERSION } from './legacy-ledger';
import { legacyFixtures } from './fixtures/legacy';

type Row = Record<string, unknown>;
const all = (s: SqliteState, sql: string) => s.raw.prepare(sql).all() as Row[];
const cols = (s: SqliteState, t: string) => all(s, `PRAGMA table_info(${t})`).map((c) => c.name as string);
const tables = (s: SqliteState) => all(s, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name as string);
const epoch = (s: SqliteState) => all(s, "SELECT value FROM metadata WHERE key = 'governance.m14_epoch'");
const GOVERNANCE_TABLES = ['approvals', 'change_classifications', 'governance_events', 'intent_provenance', 'near_misses'];

afterEach(() => vi.restoreAllMocks());

describe('migration m14: governance tables and the epoch', () => {
  it('the latest version is m14 or later and a fresh ledger has the five tables and one epoch without running a step', async () => {
    expect(Number(LATEST_VERSION.slice(1))).toBeGreaterThanOrEqual(14);
    const fresh = await freshLedger();
    expect(readVersion(fresh)).toBe(LATEST_VERSION);
    for (const t of GOVERNANCE_TABLES) expect(tables(fresh), t).toContain(t);
    expect(epoch(fresh)).toHaveLength(1);
    expect(Number(epoch(fresh)[0].value)).toBeGreaterThan(0);
  });

  it('every legacy start in the matrix, including the m13 snapshot, ends with the five empty tables and an epoch', async () => {
    const fixtures = legacyFixtures();
    expect(fixtures.some((f) => f.name.startsWith('m13-'))).toBe(true);
    for (const f of fixtures) {
      const s = loadLegacyLedger({ ddl: f.ddl, seed: f.seed, version: f.startVersion });
      for (const t of GOVERNANCE_TABLES) expect(tables(s), `${f.name} before`).not.toContain(t);
      await makeSpecDo(s).init();
      for (const t of GOVERNANCE_TABLES) {
        expect(tables(s), `${f.name} ${t}`).toContain(t);
        expect(all(s, `SELECT COUNT(*) AS n FROM ${t}`)[0].n, `${f.name} ${t} is empty`).toBe(0);
      }
      expect(epoch(s), f.name).toHaveLength(1);
      expect(readVersion(s), f.name).toBe(LATEST_VERSION);
    }
  });

  it('replaying the m14 step from m13 changes no schema object and no row, and the epoch does not move', async () => {
    const f = legacyFixtures().find((x) => x.name.startsWith('m13-'))!;
    const s = loadLegacyLedger({ ddl: f.ddl, seed: f.seed, version: f.startVersion });
    const started = Date.now();
    await makeSpecDo(s).init();
    const before = epoch(s)[0].value;
    // milliseconds, the unit of created_at, and stamped by this migration (not copied from elsewhere)
    expect(Number(before)).toBeGreaterThanOrEqual(started);
    expect(Number(before)).toBeLessThanOrEqual(Date.now());
    s.raw.exec("INSERT INTO governance_events (id, event, created_at) VALUES ('e1', 'policy_change', 1)");
    s.raw.exec("INSERT INTO near_misses (id, spec_id, candidate_id, reason, source_ref, created_at) VALUES ('n1', 'sp', 'c', 'trial_loss', 't1', 1)");
    const master = () => JSON.stringify(all(s, 'SELECT type, name, sql FROM sqlite_master ORDER BY type, name'));
    const rows = () => JSON.stringify([all(s, 'SELECT * FROM governance_events'), all(s, 'SELECT * FROM near_misses')]);
    const snapshot = [master(), rows()];
    s.raw.exec("UPDATE metadata SET value = 'm13' WHERE key = 'schema_version'");
    await new Promise((r) => setTimeout(r, 5)); // a replay at a later time must still keep the first epoch
    await makeSpecDo(s).init();
    expect(readVersion(s)).toBe(LATEST_VERSION);
    expect([master(), rows()]).toEqual(snapshot);
    expect(epoch(s)[0].value).toBe(before);
  });

  it('a ledger at m13 with rows everywhere keeps every row through m14', async () => {
    const f = legacyFixtures().find((x) => x.name.startsWith('m13-'))!;
    const s = loadLegacyLedger({ ddl: f.ddl, seed: f.seed, version: f.startVersion });
    const count = (t: string) => all(s, `SELECT COUNT(*) AS n FROM ${t}`)[0].n;
    const before = Object.fromEntries(['organizations', 'actors', 'repositories', 'specs', 'candidates', 'issues'].map((t) => [t, count(t)]));
    await makeSpecDo(s).init();
    for (const [t, n] of Object.entries(before)) expect(count(t), t).toBe(n);
  });

  describe('table shapes (docs/M5A-2-GOVERNANCE-PLAN.md, frozen before PR-A)', () => {
    it('columns, in the planned order', async () => {
      const s = await freshLedger();
      expect(cols(s, 'change_classifications')).toEqual(['id', 'entity_type', 'entity_id', 'commit_sha', 'change_type', 'confidence', 'classifier', 'inputs_hash', 'created_at']);
      expect(cols(s, 'approvals')).toEqual([
        'id', 'subject_type', 'subject_id', 'rung', 'commit_sha', 'content_hash', 'approver_actor_id', 'approver_eligible', 'decision', 'self_approval', 'reason', 'created_at',
      ]);
      expect(cols(s, 'near_misses')).toEqual(['id', 'spec_id', 'candidate_id', 'reason', 'rung', 'lost_to_candidate_id', 'trial_id', 'source_ref', 'evidence', 'complexity_delta', 'created_at']);
      expect(cols(s, 'intent_provenance')).toEqual(['id', 'entity_type', 'entity_id', 'origin', 'origin_actor_id', 'source', 'created_via', 'source_issue_id', 'basis', 'created_at']);
      expect(cols(s, 'governance_events')).toEqual(['id', 'event', 'actor_id', 'asserted_actor_id', 'subject', 'reason', 'detail', 'created_at']);
    });

    it('foreign keys reference actors only (approvals.approver_actor_id, intent_provenance.origin_actor_id); every other id is logical', async () => {
      const s = await freshLedger();
      for (const t of GOVERNANCE_TABLES) {
        const fks = all(s, `PRAGMA foreign_key_list(${t})`).map((f) => [f.table, f.from]);
        const expected = t === 'approvals' ? [['actors', 'approver_actor_id']] : t === 'intent_provenance' ? [['actors', 'origin_actor_id']] : [];
        expect(fks, t).toEqual(expected);
      }
    });

    it('approvals: no unique key on decision, so approve, reject, approve by one approver is legal; checks hold', async () => {
      const s = await freshLedger();
      s.raw.exec("INSERT INTO actors (id, type, name, created_at) VALUES ('a1', 'human', 'h', 1)");
      const ins = (id: string, decision: string) =>
        s.raw.prepare("INSERT INTO approvals (id, subject_type, subject_id, rung, commit_sha, approver_actor_id, decision, created_at) VALUES (?, 'candidate', 'c1', 'full', ?, 'a1', ?, 1)").run(id, 'f'.repeat(40), decision);
      expect(() => { ins('p1', 'approve'); ins('p2', 'reject'); ins('p3', 'approve'); }).not.toThrow();
      expect(all(s, 'SELECT id FROM approvals ORDER BY rowid').map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
      expect(() => ins('p4', 'maybe')).toThrow(/CHECK/);
      expect(() => s.raw.prepare("INSERT INTO approvals (id, subject_type, subject_id, approver_actor_id, decision, created_at) VALUES ('p5', 'spec', 's1', 'a1', 'approve', 1)").run()).not.toThrow(); // rung NULL for a spec row
      expect(() => s.raw.prepare("INSERT INTO approvals (id, subject_type, subject_id, rung, approver_actor_id, decision, created_at) VALUES ('p6', 'candidate', 'c1', 'shadow', 'a1', 'approve', 1)").run()).toThrow(/CHECK/);
      expect(() => s.raw.prepare("INSERT INTO approvals (id, subject_type, subject_id, approver_actor_id, decision, created_at) VALUES ('p7', 'issue', 'i1', 'a1', 'approve', 1)").run()).toThrow(/CHECK/);
      expect(() => s.raw.prepare("INSERT INTO approvals (id, subject_type, subject_id, approver_actor_id, decision, created_at) VALUES ('p8', 'candidate', 'c1', 'ghost', 'approve', 1)").run()).toThrow(/FOREIGN KEY/);
    });

    it('near_misses: a redelivery is deduplicated by (candidate, reason, source_ref); reason is free text', async () => {
      const s = await freshLedger();
      const ins = (id: string, reason: string, ref: string) =>
        s.raw.prepare("INSERT INTO near_misses (id, spec_id, candidate_id, reason, source_ref, created_at) VALUES (?, 'sp', 'c1', ?, ?, 1)").run(id, reason, ref);
      // reason is free text on purpose (a CHECK could not be widened later); the writer validates it
      expect(() => ins('n0', 'a_reason_added_later', 'x0')).not.toThrow();
      ins('n1', 'trial_loss', 't1');
      expect(() => ins('n2', 'trial_loss', 't1')).toThrow(/UNIQUE/);
      expect(() => s.raw.prepare("INSERT OR IGNORE INTO near_misses (id, spec_id, candidate_id, reason, source_ref, created_at) VALUES ('n3', 'sp', 'c1', 'trial_loss', 't1', 1)").run()).not.toThrow();
      expect(all(s, "SELECT COUNT(*) AS n FROM near_misses WHERE reason = 'trial_loss'")[0].n).toBe(1);
      expect(() => ins('n4', 'gate_fail', 't1')).not.toThrow(); // a different reason is a different fact
    });

    it('change_classifications: the new types are accepted, confidence is 0..1, entity types are checked', async () => {
      const s = await freshLedger();
      const ins = (type: string, conf: number, entity = 'candidate') =>
        s.raw.prepare("INSERT INTO change_classifications (id, entity_type, entity_id, change_type, confidence, created_at) VALUES (?, ?, 'e1', ?, ?, 1)").run(`${type}-${conf}-${entity}`, entity, type, conf);
      for (const t of ['typo-fix', 'refactor', 'behavior-change', 'security-sensitive', 'dependency-change', 'infra', 'schema-migration', 'oracle-change', 'unclassified']) {
        expect(() => ins(t, 0.5), t).not.toThrow();
      }
      expect(() => ins('infra', 1.5)).toThrow(/CHECK/);
      expect(() => ins('infra', -0.1)).toThrow(/CHECK/);
      expect(() => ins('mystery', 0.5)).toThrow(/CHECK/);
      expect(() => ins('infra', 0.5, 'organization')).toThrow(/CHECK/);
    });

    it('intent_provenance: one row per entity, nullable origin_actor_id, free-text source and created_via', async () => {
      const s = await freshLedger();
      const ins = (id: string, entity: string, origin = 'external', source: string | null = 'something-new') =>
        s.raw.prepare("INSERT INTO intent_provenance (id, entity_type, entity_id, origin, source, created_via, created_at) VALUES (?, 'spec', ?, ?, ?, 'future-kind', 1)").run(id, entity, origin, source);
      ins('i1', 'sp1');
      expect(() => ins('i2', 'sp1')).toThrow(/UNIQUE/);
      expect(() => ins('i3', 'sp2', 'root')).toThrow(/CHECK/);
      expect(() => ins('i4', 'sp3', 'unknown', null)).not.toThrow();
      expect(all(s, "SELECT origin_actor_id FROM intent_provenance WHERE id = 'i1'")[0].origin_actor_id).toBeNull();
    });

    it('indexes, defaults and the one CHECK not exercised elsewhere', async () => {
      const s = await freshLedger();
      const idx = (t: string) => all(s, `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${t}' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => r.name);
      expect(idx('change_classifications')).toEqual(['idx_change_classifications_entity']);
      expect(all(s, 'PRAGMA index_info(idx_change_classifications_entity)').map((c) => c.name)).toEqual(['entity_type', 'entity_id', 'commit_sha', 'created_at']);
      expect(idx('approvals')).toEqual(['idx_approvals_approver', 'idx_approvals_subject']);
      expect(idx('near_misses')).toEqual(['idx_near_misses_spec']); // lookups by candidate use the UNIQUE autoindex
      expect(idx('intent_provenance')).toEqual([]);
      expect(idx('governance_events')).toEqual(['idx_governance_events_created', 'idx_governance_events_event']);
      // fail-closed defaults: a row that does not say otherwise is not eligible and not a self-approval
      s.raw.exec("INSERT INTO actors (id, type, name, created_at) VALUES ('a1', 'human', 'h', 1)");
      s.raw.exec("INSERT INTO approvals (id, subject_type, subject_id, approver_actor_id, decision, created_at) VALUES ('d1', 'spec', 's1', 'a1', 'approve', 1)");
      expect(all(s, "SELECT approver_eligible, self_approval FROM approvals WHERE id = 'd1'")[0]).toEqual({ approver_eligible: 0, self_approval: 0 });
      // intent_provenance.entity_type is only issue or spec
      expect(() => s.raw.exec("INSERT INTO intent_provenance (id, entity_type, entity_id, origin, created_at) VALUES ('x', 'organization', 'o1', 'external', 1)")).toThrow(/CHECK/);
    });

    it('governance_events takes any event name (free text) and has no foreign keys', async () => {
      const s = await freshLedger();
      expect(() => s.raw.exec("INSERT INTO governance_events (id, event, actor_id, created_at) VALUES ('g1', 'a_future_event', 'nobody', 1)")).not.toThrow();
    });
  });

  describe('rollback floor (docs/OPS.md): a build older than m14 over an m14 ledger can still purge', () => {
    it('with rows in all five tables and foreign keys ON, deleting candidates, specs, repositories and the organization (the m13 list) succeeds and leaves the rows', async () => {
      const s = await freshLedger();
      const spec = makeSpecDo(s);
      await spec.init();
      const actor = spec.createActor('human', 'maint').id;
      const org = spec.createOrganization('floor-org', 'artifacts');
      const repo = spec.createRepository('floor-repo', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'floor-org');
      const sp = spec.createSpec('floor-spec', 'd', 'contract', [], org.id, actor);
      const cand = spec.createCandidate(sp.id, repo.id, 'sha', 'base', actor);
      s.raw.prepare("INSERT INTO change_classifications (id, entity_type, entity_id, change_type, confidence, created_at) VALUES ('c1', 'candidate', ?, 'infra', 0.9, 1)").run(cand.id);
      s.raw.prepare("INSERT INTO approvals (id, subject_type, subject_id, rung, commit_sha, approver_actor_id, decision, created_at) VALUES ('a1', 'candidate', ?, 'full', 'sha', ?, 'approve', 1)").run(cand.id, actor);
      s.raw.prepare("INSERT INTO near_misses (id, spec_id, candidate_id, reason, source_ref, created_at) VALUES ('n1', ?, ?, 'trial_loss', 't', 1)").run(sp.id, cand.id);
      s.raw.prepare("INSERT INTO intent_provenance (id, entity_type, entity_id, origin, origin_actor_id, created_at) VALUES ('p1', 'spec', ?, 'maintainer', ?, 1)").run(sp.id, actor);
      s.raw.prepare("INSERT INTO governance_events (id, event, subject, created_at) VALUES ('g1', 'policy_change', ?, 1)").run(sp.id);
      expect(all(s, 'PRAGMA foreign_keys')[0].foreign_keys).toBe(1);

      expect(() => {
        s.raw.prepare('DELETE FROM gate_verdicts WHERE candidate_id = ?').run(cand.id);
        s.raw.prepare('DELETE FROM candidates WHERE id = ?').run(cand.id);
        s.raw.prepare('DELETE FROM repositories WHERE organization_id = ?').run(org.id);
        s.raw.prepare('DELETE FROM specs WHERE organization_id = ?').run(org.id);
        s.raw.prepare('DELETE FROM organizations WHERE id = ?').run(org.id);
      }).not.toThrow();
      for (const t of GOVERNANCE_TABLES) expect(all(s, `SELECT COUNT(*) AS n FROM ${t}`)[0].n, `${t} rows are orphans, swept by a later purge`).toBe(1);
    });
  });
});

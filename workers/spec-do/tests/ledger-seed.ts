/**
 * Seeds a ledger candidate under a chosen spec id and candidate id with raw SQL (idempotent), for tests that post canary deployments. Since
 * wave-2a part B `deployCanary` needs a live candidate filed under the named spec; these tests used to name ids with no ledger row.
 * The parent rows (actor, organization, repository) are shared fixtures with fixed ids.
 */
type RawDb = { prepare(sql: string): { run(...params: unknown[]): unknown } };

export const SEED_ACTOR = 'seed-actor';

export function seedLedgerCandidate(
  raw: RawDb,
  candidateId: string,
  specId: string,
  opts: { commitSha?: string; stage?: string } = {}
): void {
  const ts = Date.now();
  raw.prepare(`INSERT OR IGNORE INTO actors (id, type, name, created_at) VALUES (?, 'agent', ?, ?)`).run(SEED_ACTOR, SEED_ACTOR, ts);
  raw.prepare(`INSERT OR IGNORE INTO organizations (id, name, type, created_at) VALUES ('seed-org', 'seed-org', 'artifacts', ?)`).run(ts);
  raw
    .prepare(
      `INSERT OR IGNORE INTO repositories (id, name, organization_id, repo_type, remote_url, namespace, created_at)
       VALUES ('seed-repo', 'seed-repo', 'seed-org', 'baseline', 'https://example.invalid/r.git', 'seed-org', ?)`
    )
    .run(ts);
  raw
    .prepare(
      `INSERT OR IGNORE INTO specs (id, name, contract, declared_delta_surface, organization_id, created_by, created_at)
       VALUES (?, ?, '{}', '[]', 'seed-org', ?, ?)`
    )
    .run(specId, specId, SEED_ACTOR, ts);
  raw
    .prepare(
      `INSERT OR IGNORE INTO candidates (id, spec_id, repository_id, commit_sha, base_commit_sha, agent_id, created_at, stage)
       VALUES (?, ?, 'seed-repo', ?, '', ?, ?, ?)`
    )
    .run(candidateId, specId, opts.commitSha ?? '', SEED_ACTOR, ts, opts.stage ?? 'pending');
}

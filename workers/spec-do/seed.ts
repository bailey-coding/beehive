/**
 * Beehive Spec DO Database Seeding
 * 
 * Used for local development with Miniflare.
 * This populates the in-memory SQLite database with test data.
 * 
 * Usage:
 *   - In development: The SpecDO class checks for a seed flag
 *   - Or call seedDatabase() directly from tests
 */

import { Database } from 'sql.js';

// Seed data types
interface SeedOrganization {
  id: string;
  name: string;
  type: 'github' | 'gitlab' | 'artifacts';
  externalId?: string;
}

interface SeedActor {
  id: string;
  type: 'human' | 'agent';
  name: string;
  githubUserId?: string;
  trustScore?: number;
  promotionAuthority?: boolean;
}

interface SeedSpec {
  id: string;
  name: string;
  description: string;
  contract: string;
  declaredDeltaSurface: string[];
  organizationId: string;
  createdBy: string;
  stage?: string;
}

interface SeedCandidate {
  id: string;
  specId: string;
  repositoryId: string;
  commitSha: string;
  baseCommitSha: string;
  agentId: string;
  stage?: string;
}

interface SeedRepository {
  id: string;
  name: string;
  organizationId: string;
  repoType: 'baseline' | 'candidate';
  specId?: string;
  agentId?: string;
  remoteUrl: string;
  namespace: string;
  defaultBranch?: string;
}

// Complete seed data for a minimal Beehive workflow
const seedData: {
  organizations: SeedOrganization[];
  actors: SeedActor[];
  specs: SeedSpec[];
  repositories: SeedRepository[];
  candidates: SeedCandidate[];
  issues: Record<string, unknown>[];
  gateVerdicts: Record<string, unknown>[];
  trials: Record<string, unknown>[];
  issueSpecLinks: Record<string, unknown>[];
  issueCandidateLinks: Record<string, unknown>[];
} = {
  organizations: [
    {
      id: 'org-001',
      name: 'beehive-demo',
      type: 'artifacts',
      externalId: 'default',
    },
  ],

  actors: [
    {
      id: 'human-001',
      type: 'human',
      name: 'Maintainer One',
      githubUserId: 'maintainer1',
      trustScore: 90,
      promotionAuthority: true,
    },
    {
      id: 'human-002',
      type: 'human',
      name: 'Maintainer Two',
      githubUserId: 'maintainer2',
      trustScore: 85,
      promotionAuthority: true,
    },
    {
      id: 'agent-001',
      type: 'agent',
      name: 'Agent Alpha',
      trustScore: 60,
      promotionAuthority: false,
    },
    {
      id: 'agent-002',
      type: 'agent',
      name: 'Agent Beta',
      trustScore: 55,
      promotionAuthority: false,
    },
    {
      id: 'agent-003',
      type: 'agent',
      name: 'Agent Gamma',
      trustScore: 50,
      promotionAuthority: false,
    },
  ],

  repositories: [
    {
      id: 'repo-001',
      name: 'beehive-url-shortener',
      organizationId: 'org-001',
      repoType: 'baseline',
      specId: 'spec-001',
      remoteUrl: 'https://localhost:8787/git/default/beehive-url-shortener.git',
      namespace: 'default',
    },
    {
      id: 'repo-002',
      name: 'beehive-url-shortener-agent-alpha',
      organizationId: 'org-001',
      repoType: 'candidate',
      agentId: 'agent-001',
      remoteUrl: 'https://localhost:8787/git/default/beehive-url-shortener-agent-alpha.git',
      namespace: 'default',
    },
    {
      id: 'repo-003',
      name: 'beehive-url-shortener-agent-beta',
      organizationId: 'org-001',
      repoType: 'candidate',
      agentId: 'agent-002',
      remoteUrl: 'https://localhost:8787/git/default/beehive-url-shortener-agent-beta.git',
      namespace: 'default',
    },
    {
      id: 'repo-004',
      name: 'beehive-url-shortener-agent-gamma',
      organizationId: 'org-001',
      repoType: 'candidate',
      agentId: 'agent-003',
      remoteUrl: 'https://localhost:8787/git/default/beehive-url-shortener-agent-gamma.git',
      namespace: 'default',
    },
  ],

  specs: [
    {
      id: 'spec-001',
      name: 'URL Shortener v1',
      description: 'A simple URL shortening service',
      contract: JSON.stringify({
        endpoints: [
          {
            path: '/shorten',
            method: 'POST',
            request: {
              body: { url: 'string' },
            },
            response: {
              body: { shortUrl: 'string', originalUrl: 'string' },
            },
          },
          {
            path: '/{shortId}',
            method: 'GET',
            response: {
              body: { originalUrl: 'string' },
            },
          },
        ],
        models: {
          ShortUrl: {
            type: 'object',
            properties: {
              shortId: { type: 'string' },
              originalUrl: { type: 'string', format: 'uri' },
              createdAt: { type: 'string', format: 'date-time' },
              expiresAt: { type: 'string', format: 'date-time', nullable: true },
            },
            required: ['shortId', 'originalUrl', 'createdAt'],
          },
        },
      }),
      declaredDeltaSurface: ['POST /shorten', 'GET /{shortId}'],
      organizationId: 'org-001',
      createdBy: 'human-001',
      stage: 'active',
    },
  ],

  candidates: [
    {
      id: 'candidate-001',
      specId: 'spec-001',
      repositoryId: 'repo-002',
      commitSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      baseCommitSha: 'baseline-001',
      agentId: 'agent-001',
      stage: 'passed_premerge',
    },
    {
      id: 'candidate-002',
      specId: 'spec-001',
      repositoryId: 'repo-003',
      commitSha: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1',
      baseCommitSha: 'baseline-001',
      agentId: 'agent-002',
      stage: 'passed_premerge',
    },
    {
      id: 'candidate-003',
      specId: 'spec-001',
      repositoryId: 'repo-004',
      commitSha: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2',
      baseCommitSha: 'baseline-001',
      agentId: 'agent-003',
      stage: 'pending',
    },
  ],

  issues: [
    {
      id: 'issue-001',
      number: 1,
      repositoryId: 'repo-001',
      title: 'Add rate limiting to /shorten endpoint',
      body: 'The /shorten endpoint needs rate limiting to prevent abuse. Implement a token bucket algorithm with 100 requests per minute per IP.',
      createdBy: 'human-001',
      stage: 'spec_needed',
    },
    {
      id: 'issue-002',
      number: 2,
      repositoryId: 'repo-001',
      title: 'Add analytics tracking for shortened URLs',
      body: 'Track click counts and referrers for shortened URLs to provide analytics to users.',
      createdBy: 'human-002',
      stage: 'reported',
    },
  ],

  gateVerdicts: [
    {
      candidateId: 'candidate-001',
      gate: 'pre-merge',
      status: 'pass',
      score: 95,
      complexityDelta: 0.8,
      decidedBy: 'human-001',
      notes: 'All tests passed, complexity within acceptable range',
    },
    {
      candidateId: 'candidate-002',
      gate: 'pre-merge',
      status: 'pass',
      score: 88,
      complexityDelta: 1.2,
      decidedBy: 'human-001',
      notes: 'All tests passed, slightly higher complexity',
    },
  ],

  trials: [
    {
      id: 'trial-001',
      specId: 'spec-001',
      candidateAId: 'candidate-001',
      candidateBId: 'candidate-002',
      winnerId: 'candidate-001',
      comparisonMetrics: JSON.stringify({
        conformance_score: { a: 95, b: 88 },
        complexity_delta: { a: 0.8, b: 1.2 },
        performance: { a: 150, b: 180 },
      }),
      decidedBy: 'human-001',
      decidedAt: Date.now(),
      stage: 'decided',
    },
  ],

  issueSpecLinks: [
    {
      id: 'issue-spec-001',
      issueId: 'issue-001',
      specId: 'spec-001',
      relationship: 'requests-change',
    },
  ],

  issueCandidateLinks: [
    {
      id: 'issue-candidate-001',
      issueId: 'issue-001',
      candidateId: 'candidate-001',
      relationship: 'requests-fix',
    },
    {
      id: 'issue-candidate-002',
      issueId: 'issue-001',
      candidateId: 'candidate-002',
      relationship: 'requests-fix',
    },
  ],
};

/**
 * Seed the database with test data
 * Called during SpecDO initialization when in development mode
 */
export function seedDatabase(db: Database): void {
  console.log('[SpecDO] Seeding database with test data...');

  // Insert organizations
  const orgStmt = db.prepare(
    `INSERT OR IGNORE INTO organizations (id, name, type, external_id, created_at) 
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const org of seedData.organizations) {
    orgStmt.bind(org.id, org.name, org.type, org.externalId || null, Date.now());
    orgStmt.step();
    orgStmt.reset();
  }
  orgStmt.free();

  // Insert actors
  const actorStmt = db.prepare(
    `INSERT OR IGNORE INTO actors (id, type, name, github_user_id, trust_score, promotion_authority, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const actor of seedData.actors) {
    actorStmt.bind(
      actor.id,
      actor.type,
      actor.name,
      actor.githubUserId || null,
      actor.trustScore || 50,
      actor.promotionAuthority || false,
      Date.now()
    );
    actorStmt.step();
    actorStmt.reset();
  }
  actorStmt.free();

  // Insert repositories
  const repoStmt = db.prepare(
    `INSERT OR IGNORE INTO repositories 
     (id, name, organization_id, repo_type, spec_id, agent_id, remote_url, namespace, default_branch, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const repo of seedData.repositories) {
    repoStmt.bind(
      repo.id,
      repo.name,
      repo.organizationId,
      repo.repoType,
      repo.specId || null,
      repo.agentId || null,
      repo.remoteUrl,
      repo.namespace,
      repo.defaultBranch || 'main',
      Date.now()
    );
    repoStmt.step();
    repoStmt.reset();
  }
  repoStmt.free();

  // Insert specs
  const specStmt = db.prepare(
    `INSERT OR IGNORE INTO specs 
     (id, name, description, contract, declared_delta_surface, organization_id, created_by, created_at, stage) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const spec of seedData.specs) {
    specStmt.bind(
      spec.id,
      spec.name,
      spec.description,
      spec.contract,
      JSON.stringify(spec.declaredDeltaSurface),
      spec.organizationId,
      spec.createdBy,
      Date.now(),
      spec.stage || 'draft'
    );
    specStmt.step();
    specStmt.reset();
  }
  specStmt.free();

  // Insert candidates
  const candidateStmt = db.prepare(
    `INSERT OR IGNORE INTO candidates 
     (id, spec_id, repository_id, commit_sha, base_commit_sha, agent_id, created_at, stage) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const candidate of seedData.candidates) {
    candidateStmt.bind(
      candidate.id,
      candidate.specId,
      candidate.repositoryId,
      candidate.commitSha,
      candidate.baseCommitSha,
      candidate.agentId,
      Date.now(),
      candidate.stage || 'pending'
    );
    candidateStmt.step();
    candidateStmt.reset();
  }
  candidateStmt.free();

  // Insert issues
  const issueStmt = db.prepare(
    `INSERT OR IGNORE INTO issues 
     (id, number, repository_id, title, body, status, labels, created_at, created_by, comment_policy, visibility, stage) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const issue of seedData.issues) {
    issueStmt.bind(
      issue.id,
      issue.number,
      issue.repositoryId,
      issue.title,
      issue.body,
      'open',
      null, // labels
      Date.now(),
      issue.createdBy,
      'open', // comment_policy
      'public', // visibility
      issue.stage || 'reported'
    );
    issueStmt.step();
    issueStmt.reset();
  }
  issueStmt.free();

  // Insert gate verdicts
  const verdictStmt = db.prepare(
    `INSERT OR IGNORE INTO gate_verdicts 
     (id, candidate_id, gate, status, score, complexity_delta, notes, created_at, decided_by, stage) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const verdict of seedData.gateVerdicts) {
    verdictStmt.bind(
      `verdict-${verdict.candidateId}-${verdict.gate}`,
      verdict.candidateId,
      verdict.gate,
      verdict.status,
      verdict.score,
      verdict.complexityDelta,
      verdict.notes || null,
      Date.now(),
      verdict.decidedBy,
      'passed'
    );
    verdictStmt.step();
    verdictStmt.reset();
  }
  verdictStmt.free();

  // Insert trials
  const trialStmt = db.prepare(
    `INSERT OR IGNORE INTO trials 
     (id, spec_id, candidate_a_id, candidate_b_id, winner_id, comparison_metrics, decided_at, decided_by, stage) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const trial of seedData.trials) {
    trialStmt.bind(
      trial.id,
      trial.specId,
      trial.candidateAId,
      trial.candidateBId,
      trial.winnerId,
      trial.comparisonMetrics,
      trial.decidedAt,
      trial.decidedBy,
      trial.stage || 'pending'
    );
    trialStmt.step();
    trialStmt.reset();
  }
  trialStmt.free();

  // Insert issue-spec links
  const issueSpecLinkStmt = db.prepare(
    `INSERT OR IGNORE INTO issue_spec_links (id, issue_id, spec_id, relationship, created_at) 
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const link of seedData.issueSpecLinks) {
    issueSpecLinkStmt.bind(
      link.id,
      link.issueId,
      link.specId,
      link.relationship,
      Date.now()
    );
    issueSpecLinkStmt.step();
    issueSpecLinkStmt.reset();
  }
  issueSpecLinkStmt.free();

  // Insert issue-candidate links
  const issueCandidateLinkStmt = db.prepare(
    `INSERT OR IGNORE INTO issue_candidate_links (id, issue_id, candidate_id, relationship, created_at) 
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const link of seedData.issueCandidateLinks) {
    issueCandidateLinkStmt.bind(
      link.id,
      link.issueId,
      link.candidateId,
      link.relationship,
      Date.now()
    );
    issueCandidateLinkStmt.step();
    issueCandidateLinkStmt.reset();
  }
  issueCandidateLinkStmt.free();

  // Mark seeding as complete
  const seedStmt = db.prepare(
    `INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)`
  );
  seedStmt.bind('seeded_at', String(Date.now()), Date.now());
  seedStmt.step();
  seedStmt.free();

  console.log('[SpecDO] Database seeded successfully');
}

/**
 * Check if database has been seeded
 */
export function isSeeded(db: Database): boolean {
  const stmt = db.prepare(
    `SELECT value FROM metadata WHERE key = 'seeded_at'`
  );
  const row = stmt.step();
  stmt.free();
  return row !== null;
}

export { seedData };

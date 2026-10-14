/**
 * Beehive UI Types
 * 
 * Shared TypeScript types for the React UI.
 */

// ============================================================================
// API RESPONSE TYPES
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: number;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  timestamp: number;
}

// ============================================================================
// ENTITY TYPES
// ============================================================================

// Organizations
export interface Organization {
  id: string;
  name: string;
  type: 'github' | 'gitlab' | 'artifacts';
  external_id?: string;
  created_at: number;
}

// Actors
export interface Actor {
  id: string;
  type: 'human' | 'agent';
  name: string;
  github_user_id?: string;
  trust_score: number;
  promotion_authority: boolean;
  created_at: number;
}

// Repositories
export interface Repository {
  id: string;
  name: string;
  organization_id: string;
  repo_type: 'baseline' | 'candidate';
  spec_id?: string;
  agent_id?: string;
  remote_url: string;
  namespace?: string;
  default_branch: string;
  created_at: number;
}

// Specs
export interface Spec {
  id: string;
  name: string;
  description?: string;
  contract: string;
  declaredDeltaSurface: string[];
  organization_id: string;
  created_by: string;
  created_at: number;
  stage: 'draft' | 'proposed' | 'active' | 'deprecated' | 'archived';
}

// Candidates
export interface Candidate {
  id: string;
  spec_id: string;
  repository_id: string;
  commit_sha: string;
  base_commit_sha: string;
  agent_id: string;
  created_at: number;
  stage: 'pending' | 'passed_premerge' | 'passed_shadow' | 'passed_train' | 'passed_canary' | 'promoted' | 'failed' | 'rolled_back';
  repository?: Repository;
  spec?: Spec;
  actor?: Actor;
}

// Gate Verdicts
export interface GateVerdict {
  id: string;
  candidate_id: string;
  gate: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  status: 'pass' | 'fail' | 'pending';
  score: number;
  complexity_delta: number;
  notes?: string;
  created_at: number;
  decided_by: string;
  stage: 'pending' | 'passed' | 'failed';
}

// Trials
export interface Trial {
  id: string;
  spec_id: string;
  candidate_a_id: string;
  candidate_b_id: string;
  winner_id?: string;
  comparison_metrics: ComparisonMetrics;
  decided_at: number;
  decided_by: string;
  stage: 'pending' | 'comparing' | 'decided';
}

// Trial Comparison (extended for detail view)
export interface TrialComparison {
  trial: Trial;
  candidateA?: Candidate;
  candidateB?: Candidate;
  verdictA?: GateVerdict;
  verdictB?: GateVerdict;
  winner?: Candidate;
  spec?: Spec;
}

// Comparison Metrics
export interface ComparisonMetrics {
  conformance_score?: { a: number; b: number };
  complexity_delta?: { a: number; b: number };
  performance?: { a: number; b: number };
}

// Promotions
export interface Promotion {
  id: string;
  candidate_id: string;
  from_rung: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  to_rung: 'pre-merge' | 'shadow' | 'train' | 'canary' | 'full';
  promoted_at: number;
  promoted_by: string;
  rollback_reason?: string;
  stage: 'pending' | 'active' | 'rolled_back';
}

// Issues
export interface Issue {
  id: string;
  number: number;
  repository_id: string;
  title: string;
  body?: string;
  status: 'open' | 'closed';
  labels?: string;
  created_at: number;
  created_by: string;
  closed_at?: number;
  closed_by?: string;
  comment_policy: 'open' | 'maintainers_only' | 'locked';
  visibility: 'public' | 'internal' | 'private';
  stage: 'reported' | 'spec_needed' | 'spec_defining' | 'spec_defined' | 'implementing' | 'validating' | 'merged' | 'closed';
}

// ============================================================================
// FILTER TYPES
// ============================================================================

export interface TrialFilter {
  specId?: string;
  candidateId?: string;
  stage?: string;
  decidedBy?: string;
}

export interface CandidateFilter {
  specId?: string;
  agentId?: string;
  stage?: string;
}

export interface SpecFilter {
  organizationId?: string;
  stage?: string;
}

export interface IssueFilter {
  repositoryId?: string;
  stage?: string;
  status?: string;
}

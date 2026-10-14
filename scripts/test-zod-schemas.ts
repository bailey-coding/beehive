/**
 * Test script to verify Zod schemas compile and work correctly
 */

import { z } from 'zod';

// Test basic schemas
import {
  UUIDSchema,
  CandidateResponseSchema,
  GateWorkflowRequestSchema,
  ArtifactsPushEventSchema,
  DeployPreviewRequestBodySchema,
} from '../workers/shared/schemas.ts';

// Test data
const testUuid = '550e8400-e29b-41d4-a716-446655440000';
const testCandidateId = '550e8400-e29b-41d4-a716-446655440000';
const testRepositoryId = '550e8400-e29b-41d4-a716-446655440001';
const testSpecId = '550e8400-e29b-41d4-a716-446655440002';

// Test 1: UUID validation
console.log('Test 1: UUID validation');
try {
  const result = UUIDSchema.parse(testUuid);
  console.log('✓ UUID schema works:', result);
} catch (error) {
  console.error('✗ UUID schema failed:', error);
}

// Test 2: Candidate Response validation
console.log('\nTest 2: Candidate Response validation');
try {
  const candidateData = {
    id: testCandidateId,
    specId: testSpecId,
    repositoryId: testRepositoryId,
    commitSha: 'abc123def456',
    baseCommitSha: 'base123def456',
    agentId: testUuid,
    createdAt: Date.now(),
    stage: 'pending',
    previewUrl: 'https://example.com',
    previewWorkerName: 'worker-123',
    previewCreatedAt: Date.now(),
    base_commit_sha: 'base123def456',
    repository: {
      remote_url: 'https://github.com/test/repo',
      namespace: 'test',
    },
    shadowMatch: true,
    shadowScore: 100,
    shadowMetrics: '{}',
  };
  
  const result = CandidateResponseSchema.parse(candidateData);
  console.log('✓ Candidate Response schema works');
} catch (error) {
  console.error('✗ Candidate Response schema failed:', error);
}

// Test 3: Artifacts Push Event validation
console.log('\nTest 3: Artifacts Push Event validation');
try {
  const eventData = {
    id: 'push-123',
    type: 'push' as const,
    repository: {
      name: 'test-repo',
      namespace: 'test',
      full_name: 'test/test-repo',
    },
    commit: {
      sha: 'abc123def456',
      message: 'Test commit',
      author: {
        name: 'Test User',
        email: 'test@example.com',
      },
      timestamp: new Date().toISOString(),
    },
    ref: 'refs/heads/main',
    base_ref: 'refs/heads/base',
    created_at: new Date().toISOString(),
  };
  
  const result = ArtifactsPushEventSchema.parse(eventData);
  console.log('✓ Artifacts Push Event schema works');
} catch (error) {
  console.error('✗ Artifacts Push Event schema failed:', error);
}

// Test 4: Gate Workflow Request validation
console.log('\nTest 4: Gate Workflow Request validation');
try {
  const requestData = {
    candidateId: testCandidateId,
    specId: testSpecId,
    commitSha: 'abc123def456',
    baseCommitSha: 'base123def456',
    actorId: 'actor-123',
    namespace: 'test',
    repoName: 'test-repo',
  };
  
  const result = GateWorkflowRequestSchema.parse(requestData);
  console.log('✓ Gate Workflow Request schema works');
} catch (error) {
  console.error('✗ Gate Workflow Request schema failed:', error);
}

// Test 5: Deploy Preview Request Body validation
console.log('\nTest 5: Deploy Preview Request Body validation');
try {
  const requestData = {
    candidateId: testCandidateId,
    repository: {
      name: 'test-repo',
      namespace: 'test',
      full_name: 'test/test-repo',
    },
    commit: {
      sha: 'abc123def456',
      message: 'Test commit',
      author: {
        name: 'Test User',
        email: 'test@example.com',
      },
      timestamp: new Date().toISOString(),
    },
    commitSha: 'abc123def456',
    baseCommitSha: 'base123def456',
    timestamp: Date.now(),
  };
  
  const result = DeployPreviewRequestBodySchema.parse(requestData);
  console.log('✓ Deploy Preview Request Body schema works');
} catch (error) {
  console.error('✗ Deploy Preview Request Body schema failed:', error);
}

console.log('\n=== All Zod schema tests completed ===');

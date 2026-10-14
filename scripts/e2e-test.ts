/**
 * Full End-to-End Test for M2 Workers Builds Integration
 * 
 * This script creates all necessary entities (org, spec, repo, candidate)
 * and tests the complete flow: queue → queue-consumer → preview-manager → Workers Builds
 * 
 * Prerequisites:
 * - BEEHIVE_API_TOKEN (with full permissions)
 * - CLOUDFLARE_ACCOUNT_ID
 * - CLOUDFLARE_API_TOKEN (with Workers:Edit + Queues:Edit)
 */

import { setTimeout } from 'timers/promises';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load environment variables from .env file
try {
  const envPath = resolve('.env');
  const envContent = readFileSync(envPath, 'utf-8');
  const envLines = envContent.split('\n');
  
  for (const line of envLines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, value] = trimmed.split('=');
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }
} catch (error) {
  console.log('No .env file found or error reading it, using process.env');
}

// ============================================================================
// Configuration
// ============================================================================

const API_BASE = 'https://beehive.bz23711.workers.dev/api';
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const BEEHIVE_TOKEN = process.env.BEEHIVE_API_TOKEN || '';
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || BEEHIVE_TOKEN;

// Test entity names (using timestamps for uniqueness)
const testSuffix = `-e2e-${Date.now()}`;
const testOrgName = `test-org${testSuffix}`;
const testSpecName = `test-spec${testSuffix}`;
const testRepoName = `test-candidate-repo${testSuffix}`;
const testNamespace = 'bailey-coding';

// ============================================================================
// Types
// ============================================================================

interface TestResult {
  test: string;
  passed: boolean;
  message: string;
  details?: any;
  timestamp: number;
}

interface CreatedEntity {
  id: string;
  name: string;
  type: string;
}

// ============================================================================
// State
// ============================================================================

const results: TestResult[] = [];
const createdEntities: CreatedEntity[] = [];

function logResult(result: TestResult) {
  results.push(result);
  const status = result.passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status}: ${result.test}`);
  if (result.message) {
    console.log(`   Message: ${result.message}`);
  }
  if (result.details) {
    console.log(`   Details: ${JSON.stringify(result.details, null, 2)}`);
  }
  console.log('');
}

// Test actor ID - will be created if it doesn't exist
let testActorId: string | null = null;

// ============================================================================
// Helper Functions
// ============================================================================

function getHeaders(token: string) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Actor-ID': testActorId || 'human-001', // Required by Spec DO for foreign key constraint
  };
}

async function beehiveApiRequest(method: string, path: string, body?: any) {
  const url = `${API_BASE}${path}`;
  const options: RequestInit = {
    method,
    headers: getHeaders(BEEHIVE_TOKEN),
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Beehive API error ${response.status}: ${errorText}`);
  }
  
  return response.json();
}

async function cfApiRequest(method: string, path: string, body?: any) {
  const url = `${CF_API_BASE}${path}`;
  const options: RequestInit = {
    method,
    headers: getHeaders(CF_TOKEN),
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloudflare API error ${response.status}: ${errorText}`);
  }
  
  const data = await response.json();
  
  if (!data.success) {
    const errors = data.errors?.map((e: any) => e.message).join(', ') || 'Unknown error';
    throw new Error(`Cloudflare API returned success=false: ${errors}`);
  }
  
  return data.result || data;
}

// ============================================================================
// Cleanup Function
// ============================================================================

async function cleanup() {
  console.log('\n🧹 Cleaning up test entities...');
  
  // Delete in reverse order to respect dependencies
  // Candidates → Repositories → Specs → Organizations
  for (const entity of [...createdEntities].reverse()) {
    try {
      let path = '';
      
      if (entity.type === 'candidate') {
        path = `/candidates/${entity.id}`;
      } else if (entity.type === 'repository') {
        path = `/repositories/${entity.id}`;
      } else if (entity.type === 'spec') {
        path = `/specs/${entity.id}`;
      } else if (entity.type === 'organization') {
        path = `/organizations/${entity.id}`;
      }
      
      if (path) {
        await beehiveApiRequest('DELETE', path);
        console.log(`   ✓ Deleted ${entity.type}: ${entity.name}`);
      }
    } catch (error) {
      console.log(`   ✗ Failed to delete ${entity.type} ${entity.name}:`, error);
    }
  }
  
  console.log('   Cleanup complete\n');
}

// ============================================================================
// Test Functions
// ============================================================================

async function testCreateOrGetActor() {
  try {
    // Try to get an existing actor first
    const response = await beehiveApiRequest('GET', '/actors?limit=1');
    const actors = response.data || response;
    
    if (actors && actors.length > 0) {
      testActorId = actors[0].id;
      logResult({
        test: 'Get Existing Actor',
        passed: true,
        message: `Found existing actor: ${testActorId}`,
        details: { actorId: testActorId },
        timestamp: Date.now(),
      });
      return testActorId;
    }
    
    // Create a new actor if none exist
    const createResponse = await beehiveApiRequest('POST', '/actors', {
      type: 'agent',
      name: `e2e-test-agent-${testSuffix}`,
      githubUserId: `e2e-test-${Date.now()}`,
    });
    
    const actor = createResponse.data || createResponse;
    testActorId = actor.id;
    createdEntities.push({
      id: actor.id,
      name: actor.name,
      type: 'actor',
    });
    
    logResult({
      test: 'Create Test Actor',
      passed: true,
      message: `Actor created: ${actor.id}`,
      details: { actorId: actor.id, name: actor.name },
      timestamp: Date.now(),
    });
    
    return testActorId;
  } catch (error) {
    logResult({
      test: 'Create Or Get Actor',
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    return null;
  }
}

async function testCreateOrganization() {
  try {
    const response = await beehiveApiRequest('POST', '/organizations', {
      name: testOrgName,
      type: 'artifacts',
      externalId: `e2e-${Date.now()}`,
    });
    
    const org = response.data || response;
    createdEntities.push({
      id: org.id,
      name: org.name,
      type: 'organization',
    });
    
    logResult({
      test: 'Create Test Organization',
      passed: true,
      message: `Organization created: ${org.id}`,
      details: { orgId: org.id, name: org.name },
      timestamp: Date.now(),
    });
    
    return org.id;
  } catch (error) {
    logResult({
      test: 'Create Test Organization',
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    return null;
  }
}

async function testCreateSpec(orgId: string) {
  try {
    const contract = {
      name: 'TestSpec',
      description: 'E2E Test Specification',
      endpoints: [
        {
          path: '/api/test',
          method: 'GET',
          response: { status: 200 },
        },
      ],
      deltaSurface: ['/api/*'],
    };
    
    const response = await beehiveApiRequest('POST', '/specs', {
      name: testSpecName,
      description: 'E2E Test Specification',
      contract: JSON.stringify(contract),
      declaredDeltaSurface: ['/api/*'],
      organizationId: orgId,
    });
    
    const spec = response.data || response;
    createdEntities.push({
      id: spec.id,
      name: spec.name,
      type: 'spec',
    });
    
    logResult({
      test: 'Create Test Spec',
      passed: true,
      message: `Spec created: ${spec.id}`,
      details: { specId: spec.id, name: spec.name },
      timestamp: Date.now(),
    });
    
    return spec.id;
  } catch (error) {
    logResult({
      test: 'Create Test Spec',
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    return null;
  }
}

async function testCreateRepository(orgId: string, specId: string) {
  try {
    const response = await beehiveApiRequest('POST', '/repositories', {
      name: testRepoName,
      organizationId: orgId,
      repoType: 'candidate',
      specId: specId,
      agentId: testActorId || 'human-001',
      remoteUrl: `${testNamespace}/${testRepoName}`,
      namespace: testNamespace,
      defaultBranch: 'main',
    });
    
    const repo = response.data || response;
    createdEntities.push({
      id: repo.id,
      name: repo.name,
      type: 'repository',
    });
    
    logResult({
      test: 'Create Test Repository',
      passed: true,
      message: `Repository created: ${repo.id}`,
      details: { repoId: repo.id, name: repo.name, remoteUrl: repo.remoteUrl },
      timestamp: Date.now(),
    });
    
    return repo.id;
  } catch (error) {
    logResult({
      test: 'Create Test Repository',
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    return null;
  }
}

async function testCreateCandidate(repoId: string, specId: string) {
  try {
    const response = await beehiveApiRequest('POST', '/candidates', {
      specId: specId,
      repositoryId: repoId,
      commitSha: 'abc123def456' + Date.now().toString(16).substring(0, 10),
      baseCommitSha: 'base123def456',
      agentId: 'e2e-agent',
    });
    
    const candidate = response.data || response;
    createdEntities.push({
      id: candidate.id,
      name: `candidate-${candidate.id.substring(0, 8)}`,
      type: 'candidate',
    });
    
    logResult({
      test: 'Create Test Candidate',
      passed: true,
      message: `Candidate created: ${candidate.id}`,
      details: { candidateId: candidate.id, specId: candidate.specId, repoId: candidate.repositoryId },
      timestamp: Date.now(),
    });
    
    return candidate.id;
  } catch (error) {
    logResult({
      test: 'Create Test Candidate',
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    return null;
  }
}

async function testSendQueueMessage(repoFullName: string) {
  try {
    if (!ACCOUNT_ID) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID not set');
    }
    
    // Get queue ID
    const queuesPath = `/accounts/${ACCOUNT_ID}/queues`;
    const queuesData = await cfApiRequest('GET', queuesPath) as any;
    let queues: any[] = [];
    
    if (Array.isArray(queuesData)) {
      queues = queuesData;
    } else if (queuesData?.queues && Array.isArray(queuesData.queues)) {
      queues = queuesData.queues;
    } else if (queuesData?.result?.queues && Array.isArray(queuesData.result.queues)) {
      queues = queuesData.result.queues;
    }
    
    const queue = queues.find((q: any) => q.queue_name === 'preview-artifacts-push');
    if (!queue) {
      throw new Error('Queue preview-artifacts-push not found');
    }
    
    const queueId = queue.queue_id || queue.id;
    const commitSha = `test-${Date.now().toString(16).substring(0, 40)}`;
    
    const messageBody = {
      event: {
        id: `e2e-${Date.now()}`,
        type: 'push' as const,
        repository: {
          name: testRepoName,
          namespace: testNamespace,
          full_name: repoFullName,
        },
        commit: {
          sha: commitSha,
          message: 'E2E Test: Workers Builds Integration',
          author: {
            name: 'E2E Test Runner',
            email: 'e2e@beehive.test',
          },
          timestamp: new Date().toISOString(),
        },
        ref: 'refs/heads/main',
        base_ref: 'refs/heads/main',
        created_at: new Date().toISOString(),
      },
      received_at: Date.now(),
    };
    
    // Send message to queue
    const path = `/accounts/${ACCOUNT_ID}/queues/${queueId}/messages`;
    const response = await cfApiRequest('POST', path, { body: messageBody });
    
    logResult({
      test: 'Send Test Message to Queue',
      passed: true,
      message: 'Message successfully sent to preview-artifacts-push queue',
      details: {
        queueId,
        messageId: response.messageId || response.id,
        commitSha,
        repository: repoFullName,
      },
      timestamp: Date.now(),
    });
    
    return { queueId, messageId: response.messageId || response.id, commitSha, repoFullName };
  } catch (error) {
    logResult({
      test: 'Send Test Message to Queue',
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    return null;
  }
}

async function testVerifyPreviewDeployment(candidateId: string, repoFullName: string) {
  try {
    const token = BEEHIVE_TOKEN;
    if (!token) {
      throw new Error('BEEHIVE_API_TOKEN not set');
    }
    
    // Wait for processing (can take several seconds)
    console.log('   Waiting 15 seconds for queue processing...');
    await setTimeout(15000);
    
    // Check candidate multiple times for preview URL
    const maxAttempts = 3;
    const retryDelay = 5000; // 5 seconds between retries
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`   Checking candidate (attempt ${attempt}/${maxAttempts})...`);
      
      const response = await beehiveApiRequest('GET', `/candidates/${candidateId}`);
      const candidate = response.data || response;
      
      if (candidate.previewUrl) {
        logResult({
          test: 'Verify Preview Deployment',
          passed: true,
          message: `Preview URL created: ${candidate.previewUrl}`,
          details: {
            candidateId: candidate.id,
            previewUrl: candidate.previewUrl,
            previewWorkerName: candidate.previewWorkerName,
            previewDeployedAt: candidate.previewDeployedAt,
            attempt,
          },
          timestamp: Date.now(),
        });
        return true;
      } else if (attempt < maxAttempts) {
        console.log(`   Preview not ready yet, retrying in ${retryDelay / 1000} seconds...`);
        await setTimeout(retryDelay);
      }
    }
    
    // Final check
    const response = await beehiveApiRequest('GET', `/candidates/${candidateId}`);
    const candidate = response.data || response;
    
    logResult({
      test: 'Verify Preview Deployment',
      passed: false,
      message: 'No preview URL found after multiple attempts (deployment may still be processing)',
      details: {
        candidateId: candidate.id,
        currentPreviewUrl: candidate.previewUrl,
        stage: candidate.stage,
        note: 'Workers Builds can take several minutes. Check logs with: npx wrangler tail --name beehive-preview-manager',
      },
      timestamp: Date.now(),
    });
    return false;
  } catch (error) {
    logResult({
      test: 'Verify Preview Deployment',
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    });
    return false;
  }
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runE2ETest() {
  console.log('='.repeat(70));
  console.log('🚀 Full End-to-End Test: Workers Builds Integration');
  console.log('='.repeat(70));
  console.log('');
  
  let orgId: string | null = null;
  let specId: string | null = null;
  let repoId: string | null = null;
  let candidateId: string | null = null;
  let repoFullName: string | null = null;
  
  try {
    // Step 0: Create or get test actor
    testActorId = await testCreateOrGetActor();
    if (!testActorId) return;
    
    // Step 1: Create organization
    orgId = await testCreateOrganization();
    if (!orgId) return;
    
    // Step 2: Create spec
    specId = await testCreateSpec(orgId);
    if (!specId) return;
    
    // Step 3: Create repository
    repoId = await testCreateRepository(orgId, specId);
    if (!repoId) return;
    
    repoFullName = `${testNamespace}/${testRepoName}`;
    
    // Step 4: Create candidate
    candidateId = await testCreateCandidate(repoId, specId);
    if (!candidateId) return;
    
    // Step 5: Send queue message
    const queueResult = await testSendQueueMessage(repoFullName);
    if (!queueResult) return;
    
    // Step 6: Verify preview deployment
    await testVerifyPreviewDeployment(candidateId, repoFullName);
    
  } catch (error) {
    console.error('\n❌ Test runner error:', error);
  } finally {
    // Print summary
    printSummary();
    
    // Cleanup
    console.log('\n📝 Cleanup:');
    console.log('   Run: npx ts-node scripts/e2e-test.ts --cleanup');
    console.log('   Or: Manually delete test entities via API');
    console.log('');
  }
}

function printSummary() {
  console.log('='.repeat(70));
  console.log('📊 Test Summary');
  console.log('='.repeat(70));
  
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  
  console.log(`Total: ${total}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('');
  
  if (createdEntities.length > 0) {
    console.log('Created Entities:');
    for (const entity of createdEntities) {
      console.log(`  - ${entity.type}: ${entity.name} (${entity.id})`);
    }
    console.log('');
  }
  
  if (failed > 0) {
    console.log('⚠️  Some tests failed. Check logs above for details.');
    console.log('');
    console.log('Troubleshooting:');
    console.log('1. Verify tokens: BEEHIVE_API_TOKEN and CLOUDFLARE_API_TOKEN');
    console.log('2. Check CLOUDFLARE_ACCOUNT_ID is correct');
    console.log('3. View logs: npx wrangler tail --name beehive-queue-consumer');
    console.log('4. View logs: npx wrangler tail --name beehive-preview-manager');
  } else {
    console.log('✅ All setup steps passed!');
    console.log('');
    console.log('If preview deployment is still processing:');
    console.log('  - Workers Builds can take several minutes');
    console.log('  - Check: npx wrangler tail --name beehive-preview-manager');
    console.log('  - Verify: curl -H "Authorization: Bearer $BEEHIVE_API_TOKEN"');
    console.log('    https://beehive.bz23711.workers.dev/api/candidates/{id}');
  }
  console.log('');
}

// ============================================================================
// CLI Support
// ============================================================================

const args = process.argv.slice(2);
const cleanupMode = args.includes('--cleanup') || args.includes('-c');

if (cleanupMode) {
  cleanup().catch(console.error);
} else {
  runE2ETest().catch(error => {
    console.error('Test runner error:', error);
    process.exit(1);
  });
}

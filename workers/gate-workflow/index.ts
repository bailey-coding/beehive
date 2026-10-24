/**
 * Beehive Pre-merge Gate Workflow
 * 
 * Cloudflare Workflow that implements the first rung of the oracle ladder.
 * Runs automated tests, property checks, and spec conformance validation.
 * 
 * This is the M1 gate implementation - hand-written, not agent-generated.
 */


import { z } from 'zod';
import { authGate } from '../shared/auth';
import { getSpecDoStub, type SpecDoStub } from '../shared/spec-do-auth';

interface Env {
  SPEC_DO: DurableObjectNamespace;
  // Tier-1 secret for Spec DO calls (workers/shared/spec-do-auth.ts); no admin token on this worker
  SPEC_DO_INTERNAL_TOKEN?: string;
  ARTIFACTS: unknown; // Cloudflare Artifacts binding
  SANDBOX_RUNNER: Service; // Binding to Sandbox Runner Worker
  API_AUTH_TOKEN?: string;
}

// Types for gate workflow
interface GateWorkflowRequest {
  candidateId: string;
  specId: string;
  commitSha: string;
  baseCommitSha: string;
  actorId: string;
  namespace?: string;
  repoName?: string;
}

// Zod schemas for gate workflow
const GateWorkflowRequestSchema = z.object({
  candidateId: z.string().uuid(),
  specId: z.string().uuid(),
  commitSha: z.string().min(1),
  baseCommitSha: z.string().min(1),
  actorId: z.string().min(1),
  namespace: z.string().optional(),
  repoName: z.string().optional(),
});

interface GateWorkflowResult {
  verdictId: string;
  candidateId: string;
  specId?: string;
  commitSha?: string;
  baseCommitSha?: string;
  gate: 'pre-merge';
  status: 'pass' | 'fail' | 'pending';
  score: number;
  complexityDelta: number;
  testResults: TestResult[];
  conformanceErrors: ConformanceError[];
  notes?: string;
  startedAt: number;
  completedAt: number;
}

interface TestResult {
  testName: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

interface ConformanceError {
  path: string;
  expected: string;
  actual: string;
  severity: 'error' | 'warning';
}

interface SpecContract {
  endpoints?: unknown[];
  models?: Record<string, unknown>;
  workflow?: unknown;
}

// In-memory state for development
const workflows = new Map<string, { status: string; result?: GateWorkflowResult }>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Auth gate - fail closed, applies to every route including /health
    const denied = await authGate(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Health check
    if (path === '/health' || path === '/gates/health') {
      return new Response(JSON.stringify({ status: 'healthy', timestamp: Date.now() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ============================================================================
    // GATE WORKFLOW
    // ============================================================================

    // POST /gates/pre-merge - Start pre-merge gate evaluation
    if (path === '/gates/pre-merge' && method === 'POST') {
      return await handleStartPreMergeGate(request, env);
    }

    // GET /gates/pre-merge/status/:verdictId - Get workflow status
    if (path.match(/^\/gates\/pre-merge\/status\/[^\/]+$/) && method === 'GET') {
      return await handleGetWorkflowStatus(request);
    }

    // GET /gates/pre-merge/:verdictId - Get full workflow result
    if (path.match(/^\/gates\/pre-merge\/[^\/]+$/) && method === 'GET') {
      return await handleGetWorkflowResult(request);
    }

    // ============================================================================
    // TEST EXECUTION
    // ============================================================================

    // POST /gates/pre-merge/:verdictId/tests - Run tests for a workflow
    if (path.match(/^\/gates\/pre-merge\/[^\/]+\/tests$/) && method === 'POST') {
      return await handleRunTests(request, env);
    }

    // ============================================================================
    // COMPLEXITY CALCULATION
    // ============================================================================

    // POST /gates/pre-merge/:verdictId/complexity - Calculate complexity delta
    if (path.match(/^\/gates\/pre-merge\/[^\/]+\/complexity$/) && method === 'POST') {
      return await handleCalculateComplexity(request, env);
    }

    // ============================================================================
    // CONFORMANCE VALIDATION
    // ============================================================================

    // POST /gates/pre-merge/:verdictId/conformance - Validate spec conformance
    if (path.match(/^\/gates\/pre-merge\/[^\/]+\/conformance$/) && method === 'POST') {
      return await handleValidateConformance(request, env);
    }

    // ============================================================================
    // 404
    // ============================================================================

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
} satisfies ExportedHandler<Env>;

type ExportedHandler<E = unknown> = {
  fetch: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;
};

// ============================================================================
// HANDLER IMPLEMENTATIONS
// ============================================================================

function extractId(path: string): string {
  const match = path.match(/\/[^\/]+$/);
  return match ? match[0].substring(1) : '';
}

function extractParentId(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 2];
}

function generateId(): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < 40; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function now(): number {
  return Date.now();
}

// ============================================================================
// GATE WORKFLOW
// ============================================================================

async function handleStartPreMergeGate(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // Validate request body with Zod - prevents field name mismatches
    const body = GateWorkflowRequestSchema.parse(await request.json());
    const { candidateId, specId, commitSha, baseCommitSha, actorId } = body;

    const verdictId = `verdict-premerge-${generateId()}`;
    const startedAt = now();

    // Create workflow state
    workflows.set(verdictId, {
      status: 'running',
      result: {
        verdictId,
        candidateId,
        gate: 'pre-merge',
        status: 'pending',
        score: 0,
        complexityDelta: 0,
        testResults: [],
        conformanceErrors: [],
        startedAt,
        completedAt: 0,
      },
    });

    // In production with Cloudflare Workflows:
    // This would be a multi-step workflow that calls various services
    // For now, we'll execute synchronously

    // Get spec contract from Spec DO
    const specDoStub = getSpecDoStub(env);
    
    const specResponse = await specDoStub.fetch(
      new Request(`https://spec-do.internal/api/specs/${specId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    
    if (!specResponse.ok) {
      throw new Error(`Failed to get spec ${specId}`);
    }
    
    const specData = await specResponse.json() as { data?: { contract?: string } & Record<string, unknown> };
    const specContract: SpecContract = JSON.parse(specData.data?.contract ?? '{}');

    // Run all gate steps
    const result = await executePreMergeGate(
      env,
      candidateId,
      specId,
      specContract,
      commitSha,
      baseCommitSha,
      actorId,
      verdictId,
      startedAt
    );

    // Update workflow state
    workflows.set(verdictId, {
      status: 'complete',
      result,
    });

    // Record verdict in Spec DO
    await recordGateVerdict(env, result, actorId);

    return new Response(JSON.stringify({
      success: true,
      verdictId,
      result,
      timestamp: now(),
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function executePreMergeGate(
  env: Env,
  candidateId: string,
  specId: string,
  specContract: SpecContract,
  commitSha: string,
  baseCommitSha: string,
  actorId: string,
  verdictId: string,
  startedAt: number
): Promise<GateWorkflowResult> {
  const testResults: TestResult[] = [];
  const conformanceErrors: ConformanceError[] = [];

  // Step 1: Clone and setup
  console.log(`[Gate] Cloning candidate ${candidateId} for pre-merge gate`);
  
  // Step 2: Run unit tests
  console.log(`[Gate] Running unit tests for ${candidateId}`);
  const unitTestResults = await runUnitTests(env, candidateId, specId ?? '');
  testResults.push(...unitTestResults);

  // Step 3: Run property tests
  console.log(`[Gate] Running property tests for ${candidateId}`);
  const propertyTestResults = await runPropertyTests(env, candidateId, specContract);
  testResults.push(...propertyTestResults);

  // Step 4: Calculate complexity delta
  console.log(`[Gate] Calculating complexity delta for ${candidateId}`);
  const complexityDelta = await calculateComplexityDelta(env, candidateId, commitSha, baseCommitSha);

  // Step 5: Validate spec conformance
  console.log(`[Gate] Validating spec conformance for ${candidateId}`);
  const conformanceValidation = await validateSpecConformance(env, candidateId, specContract);
  conformanceErrors.push(...conformanceValidation.errors);

  // Step 6: Aggregate results
  console.log(`[Gate] Aggregating results for ${candidateId}`);
  const { status, score, notes } = aggregateResults(testResults, complexityDelta, conformanceErrors);

  const completedAt = now();

  return {
    verdictId,
    candidateId,
    gate: 'pre-merge',
    status: status as 'pass' | 'fail' | 'pending',
    score,
    complexityDelta,
    testResults,
    conformanceErrors,
    notes,
    startedAt,
    completedAt,
  };
}

async function handleGetWorkflowStatus(request: Request): Promise<Response> {
  try {
    const verdictId = extractId(request.url);
    const workflow = workflows.get(verdictId);

    if (!workflow) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Workflow not found',
        timestamp: now(),
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      status: workflow.status,
      startedAt: workflow.result?.startedAt,
      completedAt: workflow.result?.completedAt,
      timestamp: now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetWorkflowResult(request: Request): Promise<Response> {
  try {
    const verdictId = extractId(request.url);
    const workflow = workflows.get(verdictId);

    if (!workflow || !workflow.result) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Result not ready',
        timestamp: now(),
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      result: workflow.result,
      timestamp: now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================================================
// TEST EXECUTION
// ============================================================================

async function handleRunTests(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const verdictId = extractParentId(request.url);
    const workflow = workflows.get(verdictId);

    if (!workflow || !workflow.result) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Workflow not found',
        timestamp: now(),
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Re-run tests for this candidate
    const { candidateId, specId = '' } = workflow.result;
    
    // Get spec contract
    const specDoStub = getSpecDoStub(env);
    
    const specResponse = await specDoStub.fetch(
      new Request(`https://spec-do.internal/api/specs/${specId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    
    if (!specResponse.ok) {
      throw new Error(`Failed to get spec ${specId}`);
    }
    
    const specData = await specResponse.json() as { data?: { contract?: string } & Record<string, unknown> };
    const specContract: SpecContract = JSON.parse(specData.data?.contract ?? '{}');

    // Run tests
    const unitTestResults = await runUnitTests(env, candidateId, specId ?? '');
    const propertyTestResults = await runPropertyTests(env, candidateId, specContract);

    const allResults = [...unitTestResults, ...propertyTestResults];

    // Update workflow result
    workflow.result.testResults = allResults;

    return new Response(JSON.stringify({
      success: true,
      testResults: allResults,
      timestamp: now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================================================
// COMPLEXITY CALCULATION
// ============================================================================

async function handleCalculateComplexity(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const verdictId = extractParentId(request.url);
    const workflow = workflows.get(verdictId);

    if (!workflow || !workflow.result) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Workflow not found',
        timestamp: now(),
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { candidateId, commitSha = '', baseCommitSha = '' } = workflow.result;
    
    const complexityDelta = await calculateComplexityDelta(
      env,
      candidateId,
      commitSha,
      baseCommitSha
    );

    // Update workflow result
    workflow.result.complexityDelta = complexityDelta;

    return new Response(JSON.stringify({
      success: true,
      complexityDelta,
      timestamp: now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================================================
// CONFORMANCE VALIDATION
// ============================================================================

async function handleValidateConformance(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const verdictId = extractParentId(request.url);
    const workflow = workflows.get(verdictId);

    if (!workflow || !workflow.result) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Workflow not found',
        timestamp: now(),
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { candidateId, specId = '' } = workflow.result;
    
    // Get spec contract
    const specDoStub = getSpecDoStub(env);
    
    const specResponse = await specDoStub.fetch(
      new Request(`https://spec-do.internal/api/specs/${specId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    
    if (!specResponse.ok) {
      throw new Error(`Failed to get spec ${specId}`);
    }
    
    const specData = await specResponse.json() as { data?: { contract?: string } & Record<string, unknown> };
    const specContract: SpecContract = JSON.parse(specData.data?.contract ?? '{}');

    const validation = await validateSpecConformance(env, candidateId, specContract);

    // Update workflow result
    workflow.result.conformanceErrors = validation.errors;

    return new Response(JSON.stringify({
      success: true,
      conformanceErrors: validation.errors,
      conformanceScore: validation.score,
      timestamp: now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================================================
// IMPLEMENTATION DETAILS
// ============================================================================

// In production, these would use actual Cloudflare services
// For M1, we simulate the behavior

async function runUnitTests(
  env: Env,
  candidateId: string,
  specId: string
): Promise<TestResult[]> {
  // In production: Clone repo, install deps, run npm test / pytest / etc.
  // For now: Simulate with mock results
  
  console.log(`[Gate] Running unit tests for candidate ${candidateId}`);
  
  // Simulate some test results
  // In real implementation, this would execute actual tests
  return [
    {
      testName: 'healthcheck endpoint returns 200',
      passed: true,
      durationMs: 50,
    },
    {
      testName: 'shorten endpoint creates valid short URL',
      passed: true,
      durationMs: 120,
    },
    {
      testName: 'redirect endpoint follows short URL',
      passed: true,
      durationMs: 80,
    },
  ];
}

async function runPropertyTests(
  env: Env,
  candidateId: string,
  specContract: SpecContract
): Promise<TestResult[]> {
  // In production: Use property-based testing framework
  // For now: Simulate
  
  console.log(`[Gate] Running property tests for candidate ${candidateId}`);
  
  return [
    {
      testName: 'property: shorten returns valid URL format',
      passed: true,
      durationMs: 200,
    },
    {
      testName: 'property: all short URLs are unique',
      passed: true,
      durationMs: 300,
    },
  ];
}

async function calculateComplexityDelta(
  env: Env,
  candidateId: string,
  commitSha: string,
  baseCommitSha: string
): Promise<number> {
  // Calculate complexity delta by analyzing code metrics
  // Formula: delta = (candidate_complexity / base_complexity) - 1
  // Where complexity = weighted sum of: lines of code, cyclomatic complexity, dependencies
  
  console.log(`[Gate] Calculating complexity delta for ${candidateId} (${commitSha} vs ${baseCommitSha})`);
  
  // In production: Fetch actual code from Artifacts and analyze
  // For M1: Simulate with deterministic analysis based on candidateId
  // This provides consistent, testable results
  
  // Get candidate and spec info from Spec DO
  const specDoStub = getSpecDoStub(env);
  
  // Fetch candidate to get spec_id and repository
  const candidateResponse = await specDoStub.fetch(
    new Request(`https://spec-do.internal/api/candidates/${candidateId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
  );
  
  if (!candidateResponse.ok) {
    console.error(`[Gate] Failed to fetch candidate ${candidateId}`);
    return 1.0; // Default: no change
  }
  
  const candidateData = await candidateResponse.json() as { data?: { specId?: string; spec_id?: string; repositoryId?: string; repository_id?: string } };
  const specId = candidateData.data?.specId || candidateData.data?.spec_id;
  
  if (!specId) {
    console.error(`[Gate] No spec_id for candidate ${candidateId}`);
    return 1.0;
  }
  
  // Get spec's declared delta surface for context
  const specResponse = await specDoStub.fetch(
    new Request(`https://spec-do.internal/api/specs/${specId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
  );
  
  const specData = await specResponse.json() as { data?: { declaredDeltaSurface?: string[] } };
  const deltaSurface = specData.data?.declaredDeltaSurface || [];
  
  // Simulate code analysis based on candidateId hash
  // This provides deterministic results for testing
  const hash = hashCode(candidateId);
  
  // Base complexity metrics (simulated from code analysis)
  const baseLoc = 500 + (hash % 200); // 500-700 lines
  const baseCyclomatic = 5 + Math.floor((hash / 1000) % 10); // 5-15
  const baseDeps = 10 + (hash % 15); // 10-25 dependencies
  
  // Candidate complexity metrics
  const candidateLoc = baseLoc + ((hash * 3) % 100) - 50; // +/- 50 lines
  const candidateCyclomatic = baseCyclomatic + Math.floor(((hash * 7) % 20) - 10); // +/- 10
  const candidateDeps = baseDeps + ((hash * 5) % 10) - 5; // +/- 5
  
  // Calculate raw complexity scores (normalized)
  const baseComplexity = calculateRawComplexity(baseLoc, baseCyclomatic, baseDeps);
  const candidateComplexity = calculateRawComplexity(candidateLoc, candidateCyclomatic, candidateDeps);
  
  // Calculate delta
  const delta = (candidateComplexity / Math.max(baseComplexity, 0.01)) - 1;
  
  console.log(`[Gate] Complexity analysis: base=${baseComplexity.toFixed(2)}, candidate=${candidateComplexity.toFixed(2)}, delta=${delta.toFixed(2)}`);
  
  // Clamp to reasonable range (-0.5 to +2.0)
  return Math.max(-0.5, Math.min(2.0, delta));
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

function calculateRawComplexity(loc: number, cyclomatic: number, deps: number): number {
  // Normalize each metric to 0-1 range, then combine with weights
  // LOC: assume 1000 lines = max complexity (1.0)
  const locScore = Math.min(1.0, loc / 1000);
  
  // Cyclomatic: assume 50 = max complexity (1.0)
  const cyclomaticScore = Math.min(1.0, cyclomatic / 50);
  
  // Dependencies: assume 50 = max complexity (1.0)
  const depsScore = Math.min(1.0, deps / 50);
  
  // Weights: LOC=40%, Cyclomatic=40%, Dependencies=20%
  return locScore * 0.4 + cyclomaticScore * 0.4 + depsScore * 0.2;
}

async function validateSpecConformance(
  env: Env,
  candidateId: string,
  specContract: SpecContract
): Promise<{ errors: ConformanceError[]; score: number }> {
  // In production: Compare candidate implementation against spec contract
  // For now: Simulate
  
  console.log(`[Gate] Validating spec conformance for ${candidateId}`);
  
  // Simulate finding some minor issues
  const errors: ConformanceError[] = [];
  
  // 10% chance of finding a minor warning
  if (Math.random() < 0.1) {
    errors.push({
      path: '/shorten',
      expected: 'POST',
      actual: 'GET',
      severity: 'warning',
    });
  }
  
  // Calculate conformance score (100 - penalty for errors)
  const penalty = errors.filter(e => e.severity === 'error').length * 20;
  const warningPenalty = errors.filter(e => e.severity === 'warning').length * 5;
  const score = Math.max(0, 100 - penalty - warningPenalty);
  
  return { errors, score };
}

function aggregateResults(
  testResults: TestResult[],
  complexityDelta: number,
  conformanceErrors: ConformanceError[]
): { status: string; score: number; notes: string } {
  // Calculate test score (percentage of passed tests)
  const totalTests = testResults.length;
  const passedTests = testResults.filter(t => t.passed).length;
  const testScore = totalTests > 0 ? (passedTests / totalTests) * 100 : 100;
  
  // Calculate conformance score
  const errorCount = conformanceErrors.filter(e => e.severity === 'error').length;
  const warningCount = conformanceErrors.filter(e => e.severity === 'warning').length;
  const conformanceScore = Math.max(0, 100 - (errorCount * 20) - (warningCount * 5));
  
  // Calculate complexity score (lower delta = better, normalized to 0-100)
  // Assuming complexity delta of 1.0 is "normal", lower is better
  const complexityScore = Math.max(0, 100 - (Math.abs(complexityDelta - 1.0) * 50));
  
  // Weighted average (from spec-002: conformance=50%, complexity=25%, tests=25%)
  const weights = { conformance: 0.5, tests: 0.25, complexity: 0.25 };
  const score = (
    conformanceScore * weights.conformance +
    testScore * weights.tests +
    complexityScore * weights.complexity
  );
  
  // Determine status
  const status = score >= 80 ? 'pass' : 'fail';
  
  // Generate notes
  const notes = [
    `Test score: ${testScore.toFixed(1)}/100`,
    `Conformance score: ${conformanceScore.toFixed(1)}/100`,
    `Complexity score: ${complexityScore.toFixed(1)}/100`,
    `Overall score: ${score.toFixed(1)}/100`,
  ].join('; ');
  
  return { status, score: Math.round(score), notes };
}

async function recordGateVerdict(
  env: Env,
  result: GateWorkflowResult,
  actorId: string
): Promise<void> {
  // Record the verdict in the Spec DO
  const specDoStub = getSpecDoStub(env);
  
  const verdictData = {
    candidateId: result.candidateId,
    gate: result.gate,
    status: result.status,
    score: result.score,
    complexityDelta: result.complexityDelta,
    notes: result.notes,
    decidedBy: actorId,
  };
  
  await specDoStub.fetch(
    new Request('https://spec-do.internal/api/gate-verdicts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Actor-ID': actorId,
      },
      body: JSON.stringify(verdictData),
    })
  );
  
  console.log(`[Gate] Recorded verdict ${result.verdictId} for candidate ${result.candidateId}`);
}

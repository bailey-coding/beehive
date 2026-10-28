/**
 * Beehive Sandbox Runner Worker
 * 
 * Executes agent code in a sandboxed environment:
 * 1. Clones candidate repo from Cloudflare Artifacts
 * 2. Installs dependencies
 * 3. Executes agent implementation logic
 * 4. Commits changes
 * 5. Pushes to candidate repo
 * 
 * This is the execution layer for agents - hand-written for M1.
 */


import { authGate } from '../shared/auth';
import { parseBuildError, validateBuildRequest, type BuildErrorCode, type BuildResult, type BuildSandbox } from './build-sandbox';
import { parseTestError, validateTestRequest, type TestErrorCode, type TestResult, type TestSandbox } from './test-sandbox';

// The Durable Object class (wrangler.toml [[containers]] / [exports]) and the outbound entrypoint it uses
// (`ctx.exports.ArtifactsGateway`) must be exported from the entry module.
export { BuildSandbox, ArtifactsGateway } from './build-sandbox';
// Gate test container (docs/REAL-GATE-IMPL-PLAN.md): declared in wrangler.toml by its own [[containers]] block and [exports.TestSandbox].
export { TestSandbox, NpmRegistryGateway } from './test-sandbox';

// Not exported: workerd treats every named export of this module as an entrypoint, and a plain object is not one.
const BUILD_ERROR_STATUS: Record<BuildErrorCode, number> = {
  BAD_REQUEST: 400, BAD_NAMESPACE: 422, NOT_CONFIGURED: 503, CLONE_FAILED: 502, NO_ENTRY: 422, BUILD_FAILED: 422, TOO_LARGE: 413,
};

const TEST_ERROR_STATUS: Record<TestErrorCode, number> = {
  BAD_REQUEST: 400, BAD_NAMESPACE: 422, NOT_CONFIGURED: 503, SANDBOX_UNAVAILABLE: 503,
};

interface Env {
  SPEC_DO: DurableObjectNamespace;
  ARTIFACTS: unknown; // Cloudflare Artifacts binding
  SANDBOX: DurableObjectNamespace<BuildSandbox>; // build container (Dockerfile in this directory)
  TEST_SANDBOX?: DurableObjectNamespace<TestSandbox>; // gate test container (Dockerfile.test); optional so a mixed-version or local run without the binding answers 503
  BEEHIVE_LOCAL_DEV?: string;
  SANDBOX_MODE?: string;
  API_AUTH_TOKEN?: string;
  ARTIFACTS_NAMESPACE?: string;
}

// Types for sandbox execution
interface SandboxTask {
  taskId: string;
  candidateId: string;
  specId: string;
  repoName: string;
  namespace: string;
  commitMessage: string;
  agentId: string;
  maxDurationMs: number;
}

interface SandboxResult {
  taskId: string;
  success: boolean;
  commitSha?: string;
  error?: string;
  durationMs: number;
  stdout?: string;
  stderr?: string;
}

// In-memory task store for development (in production, use Durable Object)
const tasks = new Map<string, SandboxTask>();
const results = new Map<string, SandboxResult>();

interface CreateTaskBody {
  repoName?: string;
  namespace?: string;
  taskId?: string;
  commitMessage?: string;
  files?: Record<string, string>;
  commitSha?: string;
  branch?: string;
  candidateId?: string;
  specId?: string;
  agentCode?: string;
  timeoutMs?: number;
  agentId?: string;
  code?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Auth gate - fail closed, applies to every route including /health
    const denied = await authGate(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Health check
    if (path === '/health' || path === '/sandbox/health') {
      return new Response(JSON.stringify({ status: 'healthy', timestamp: Date.now() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /sandbox/probe - Tool versions of the build image (deploy check: proves the Dockerfile image built by
    // Workers Builds is the one running). Authenticated above.
    if (path === '/sandbox/probe' && method === 'GET') {
      try {
        const r = await env.SANDBOX.getByName('probe').probe();
        return Response.json({ success: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode });
      } catch (error) {
        console.error('[Sandbox] probe failed:', error instanceof Error ? error.message : String(error));
        return Response.json({ success: false, error: 'the build container could not be started' }, { status: 502 });
      }
    }

    // POST /sandbox/build { repo, commitSha, namespace? } - Build a candidate commit into a Worker bundle (CandidateBundle shape of
    // workers/preview-manager/versions.ts). Local e2e: SANDBOX_MODE=stub with BEEHIVE_LOCAL_DEV=1 returns a fixed bundle.
    if (path === '/sandbox/build' && method === 'POST') {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
      }
      try {
        const input = validateBuildRequest(raw);
        if (env.SANDBOX_MODE === 'stub' && env.BEEHIVE_LOCAL_DEV === '1') {
          const stub: BuildResult = {
            mainModule: 'index.js',
            modules: [{ name: 'index.js', content: 'export default { fetch: () => new Response("stub candidate") };\n' }],
            compatibilityDate: '2026-10-01',
            source: 'prebuilt',
            namespace: input.namespace ?? env.ARTIFACTS_NAMESPACE ?? 'default',
          };
          const { namespace: stubNamespace, ...stubBundle } = stub;
          return Response.json({ success: true, bundle: stubBundle, namespace: stubNamespace });
        }
        // One sandbox per (repo, commit). Calls on the same instance are queued inside the Durable Object (BuildSandbox.serialize).
        // The namespace is part of the instance name ('/' cannot occur in a namespace or a repo name), so equal repo names in two
        // namespaces never share a sandbox. Without a namespace in the request the name is the old one, and the DO uses its fallback.
        const instance = input.namespace ? `build-${input.namespace}/${input.repo}-${input.commitSha.slice(0, 8)}` : `build-${input.repo}-${input.commitSha.slice(0, 8)}`;
        const { namespace, ...bundle } = await env.SANDBOX.getByName(instance).build(input);
        return Response.json({ success: true, bundle, namespace });
      } catch (error) {
        // Also covers errors thrown inside the Durable Object, which arrive over RPC as plain Errors.
        const known = parseBuildError(error);
        if (known) return Response.json({ success: false, code: known.code, error: known.message }, { status: BUILD_ERROR_STATUS[known.code] });
        console.error('[Sandbox] build failed:', error instanceof Error ? error.message : String(error));
        return Response.json({ success: false, error: 'the build failed for an internal reason' }, { status: 502 });
      }
    }

    // POST /sandbox/test { repo, commitSha, namespace?, installDirs?, testCommand? } - Run a commit's own tests in a clean container
    // (docs/REAL-GATE-IMPL-PLAN.md section 2). 200 `{ success: true, result }` for every verdict, pass, fail or error alike; a non-2xx is an
    // infrastructure problem (the gate retries it). Local e2e: SANDBOX_MODE=stub with BEEHIVE_LOCAL_DEV=1 returns a fixed pass.
    if (path === '/sandbox/test' && method === 'POST') {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
      }
      try {
        const input = validateTestRequest(raw);
        if (env.SANDBOX_MODE === 'stub' && env.BEEHIVE_LOCAL_DEV === '1') {
          const logTail = 'stub run: nothing was executed';
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(logTail));
          const stub: TestResult = {
            status: 'pass', failureClass: null, exitCode: 0,
            phases: { install: { ms: 0, exit: 0, timedOut: false }, test: { ms: 0, exit: 0, timedOut: false } },
            logTail, logSha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''), truncated: false,
            imageDigest: null, instance: 'stub', counts: { passed: 1, failed: 0, skipped: 0 },
          };
          return Response.json({ success: true, result: stub });
        }
        if (!env.TEST_SANDBOX) return Response.json({ success: false, code: 'NOT_CONFIGURED', error: 'the test container is not configured' }, { status: 503 });
        // One sandbox per (repo, commit); the namespace is part of the name ('/' cannot occur in either), as for builds.
        const instance = `test-${input.namespace ?? env.ARTIFACTS_NAMESPACE ?? 'default'}/${input.repo}-${input.commitSha.slice(0, 8)}`;
        const result = await env.TEST_SANDBOX.getByName(instance).test(input);
        return Response.json({ success: true, result });
      } catch (error) {
        const known = parseTestError(error);
        if (known) return Response.json({ success: false, code: known.code, error: known.message }, { status: TEST_ERROR_STATUS[known.code] });
        console.error('[Sandbox] test run failed:', error instanceof Error ? error.message : String(error));
        return Response.json({ success: false, error: 'the test run failed for an internal reason' }, { status: 502 });
      }
    }

    // ============================================================================
    // TASK MANAGEMENT
    // ============================================================================

    // POST /sandbox/tasks - Create a new sandbox task
    if (path === '/sandbox/tasks' && method === 'POST') {
      return await handleCreateTask(request, env);
    }

    // GET /sandbox/tasks/:taskId - Get task status
    if (path.match(/^\/sandbox\/tasks\/[^\/]+$/) && method === 'GET') {
      return await handleGetTask(request);
    }

    // GET /sandbox/tasks/:taskId/result - Get task result
    if (path.match(/^\/sandbox\/tasks\/[^\/]+\/result$/) && method === 'GET') {
      return await handleGetResult(request);
    }

    // ============================================================================
    // REPO OPERATIONS
    // ============================================================================

    // POST /sandbox/repos - Clone a repo into sandbox
    if (path === '/sandbox/repos/clone' && method === 'POST') {
      return await handleCloneRepo(request, env);
    }

    // POST /sandbox/repos/:repoName/commit - Commit changes in sandbox
    if (path.match(/^\/sandbox\/repos\/[^\/]+\/commit$/) && method === 'POST') {
      return await handleCommit(request, env);
    }

    // POST /sandbox/repos/:repoName/push - Push from sandbox to Artifacts
    if (path.match(/^\/sandbox\/repos\/[^\/]+\/push$/) && method === 'POST') {
      return await handlePush(request, env);
    }

    // ============================================================================
    // AGENT EXECUTION
    // ============================================================================

    // POST /sandbox/execute - Execute agent code in sandbox
    if (path === '/sandbox/execute' && method === 'POST') {
      return await handleExecuteAgent(request, env);
    }

    // ============================================================================
    // DIRECT EXECUTION (for simple agents)
    // ============================================================================

    // POST /sandbox/execute/direct - Direct execution without full sandbox
    if (path === '/sandbox/execute/direct' && method === 'POST') {
      return await handleDirectExecution(request, env);
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

// ============================================================================
// TASK MANAGEMENT
// ============================================================================

async function handleCreateTask(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as Partial<SandboxTask>;
    const actorId = request.headers.get('X-Actor-ID') || 'unknown';
    if (!body.taskId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'taskId is required',
        timestamp: Date.now(),
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Store task
    tasks.set(body.taskId, body as SandboxTask);

    // Start async execution
    // In production, this would use Queues or immediate execution
    // For now, we'll just acknowledge the task

    return new Response(JSON.stringify({
      success: true,
      taskId: body.taskId,
      status: 'queued',
      timestamp: Date.now(),
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: Date.now(),
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetTask(request: Request): Promise<Response> {
  try {
    const taskId = extractId(request.url);
    const task = tasks.get(taskId);

    if (!task) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Task not found',
        timestamp: Date.now(),
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = results.get(taskId);

    return new Response(JSON.stringify({
      success: true,
      task,
      result,
      timestamp: Date.now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: Date.now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetResult(request: Request): Promise<Response> {
  try {
    const taskId = extractParentId(request.url);
    const result = results.get(taskId);

    if (!result) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Result not ready',
        timestamp: Date.now(),
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      result,
      timestamp: Date.now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: Date.now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================================================
// REPO OPERATIONS
// ============================================================================

async function handleCloneRepo(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as CreateTaskBody;
    const { repoName, namespace, taskId = generateId() } = body;
    const actorId = request.headers.get('X-Actor-ID') || 'unknown';

    // In production with Artifacts binding:
    // const repo = await env.ARTIFACTS.get(namespace, repoName);
    // const cloneResult = await repo.clone();

    // For now, simulate the operation
    console.log(`[Sandbox] Cloning repo: ${namespace}/${repoName} (task: ${taskId})`);

    // Store a simulated sandbox path
    const sandboxPath = `/sandbox/${taskId}/${repoName}`;

    return new Response(JSON.stringify({
      success: true,
      taskId,
      repoName,
      namespace,
      sandboxPath,
      timestamp: Date.now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: Date.now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleCommit(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const repoName = extractParentId(request.url);
    const body = await request.json() as CreateTaskBody;
    const { taskId = generateId(), commitMessage, files } = body;
    const actorId = request.headers.get('X-Actor-ID') || 'unknown';

    // In production, this would commit to the sandboxed filesystem
    // For now, simulate
    console.log(`[Sandbox] Committing to ${repoName}: ${commitMessage}`);
    console.log(`[Sandbox] Files: ${JSON.stringify(files)}`);

    // Generate a fake commit SHA
    const commitSha = generateFakeSha();

    return new Response(JSON.stringify({
      success: true,
      taskId,
      repoName,
      commitSha,
      commitMessage,
      timestamp: Date.now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: Date.now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handlePush(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const repoName = extractParentId(request.url);
    const body = await request.json() as CreateTaskBody;
    const { taskId = generateId(), commitSha, branch = 'main' } = body;
    const actorId = request.headers.get('X-Actor-ID') || 'unknown';

    // In production with Artifacts binding:
    // const repo = await env.ARTIFACTS.get(namespace, repoName);
    // const pushResult = await repo.push(commitSha, branch);

    // For now, simulate
    console.log(`[Sandbox] Pushing ${repoName}@${commitSha} to ${branch}`);

    // Simulate potential concurrent push rejection
    // For SPIKE validation, we want to test this
    const shouldReject = Math.random() < 0.3; // 30% chance of rejection for testing

    if (shouldReject) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Push rejected - concurrent push ordering',
        taskId,
        repoName,
        commitSha,
        timestamp: Date.now(),
      }), {
        status: 409, // Conflict
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      taskId,
      repoName,
      commitSha,
      branch,
      timestamp: Date.now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: Date.now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================================================
// AGENT EXECUTION
// ============================================================================

async function handleExecuteAgent(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as CreateTaskBody;
    const { taskId = generateId(), candidateId, specId, agentCode, timeoutMs = 30000 } = body;
    const actorId = request.headers.get('X-Actor-ID') || 'unknown';

    console.log(`[Sandbox] Executing agent for candidate ${candidateId} (task: ${taskId})`);

    // In production with Sandbox SDK:
    // const sandbox = await env.SANDBOX.create();
    // const result = await sandbox.run(agentCode, { timeoutMs });

    // For now, simulate execution
    const startTime = Date.now();

    // Simulate agent work
    await new Promise(resolve => setTimeout(resolve, 100));

    const durationMs = Date.now() - startTime;
    const success = !/throw\s+new\s+Error/.test(agentCode ?? '');
    const commitSha = generateFakeSha();

    // Store result
    const result: SandboxResult = {
      taskId,
      success,
      commitSha: success ? commitSha : undefined,
      error: success ? undefined : 'Agent code threw an error',
      durationMs,
      stdout: `[Agent] Implemented spec ${specId ?? ''} for candidate ${candidateId ?? ''}`,
      stderr: '',
    };
    results.set(taskId, result);

    if (!success) {
      return new Response(JSON.stringify({
        success: false,
        taskId,
        error: 'Agent code threw an error',
        durationMs,
        timestamp: Date.now(),
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      success: true,
      taskId,
      commitSha,
      durationMs,
      timestamp: Date.now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const err = error as Error & { taskId?: string; startTime?: number; stack?: string };
    const result: SandboxResult = {
      taskId: err.taskId || 'unknown',
      success: false,
      error: err.message || String(error),
      durationMs: Date.now() - (err.startTime || Date.now()),
      stderr: err.stack || '',
    };
    results.set(result.taskId, result);

    return new Response(JSON.stringify({
      success: false,
      error: err.message || String(error),
      taskId: result.taskId,
      timestamp: Date.now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================================================
// DIRECT EXECUTION
// ============================================================================

async function handleDirectExecution(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = await request.json() as CreateTaskBody;
    const { taskId = generateId(), specId, agentId, code } = body;

    // This is a simplified execution path for development
    // In production, this would use the full sandbox

    console.log(`[Sandbox] Direct execution for spec ${specId} by agent ${agentId}`);

    // Simulate code execution
    const startTime = Date.now();
    
    // Execute the code in a simple eval (for development only!)
    // In production, NEVER use eval - use Sandbox SDK
    let result;
    try {
      // Simple validation - don't actually execute untrusted code
      if (typeof code === 'string' && code.length < 10000) {
        // Just log and simulate
        console.log(`[Sandbox] Code length: ${code.length} bytes`);
        result = { output: `[Agent ${agentId}] Executed spec ${specId}` };
      } else {
        throw new Error('Invalid code');
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`Execution error: ${message}`);
    }

    const durationMs = Date.now() - startTime;

    // Store result
    const sandboxResult: SandboxResult = {
      taskId,
      success: true,
      durationMs,
      stdout: JSON.stringify(result),
      stderr: '',
    };
    results.set(taskId, sandboxResult);

    return new Response(JSON.stringify({
      success: true,
      taskId,
      result,
      durationMs,
      timestamp: Date.now(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: ((error as Error)?.message || String(error)) || String(error),
      timestamp: Date.now(),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function generateId(): string {
  return crypto.randomUUID();
}

function generateFakeSha(): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < 40; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

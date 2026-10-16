/**
 * Preview Manager Worker
 * 
 * Manages Workers Builds preview deployments for candidate implementations.
 * 
 * Responsibilities:
 * - Listens for preview deployment requests from preview-artifacts-push queue
 * - Creates Workers Builds preview for each candidate
 * - Stores preview URL in Spec DO
 * - Triggers shadow comparisons via preview-scientist-comparisons queue
 */

import { authGate } from '../shared/auth';
import { WorkersBuildsClient } from './builds';
import { ArtifactsClient } from './artifacts';
import { workerVersionsClientFor } from './versions';
import { CanaryVersionRequestSchema } from './types';
import type {
  PreviewManagerEnv,
  PreviewQueueMessage,
  ArtifactsPushEvent,
  Candidate,
  PreviewDeployment,
  ExportedHandler,
  DeployPreviewRequestBody,
} from './types';
import { getSpecDoStub, type SpecDoStub } from '../shared/spec-do-auth';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_SPEC_DO_NAME = 'main';
const PREVIEW_WORKER_PREFIX = 'beehive-candidate-';

function previewUrlFor(env: { WORKERS_SUBDOMAIN?: string }, workerName: string): string {
  return env.WORKERS_SUBDOMAIN
    ? `https://${workerName}.${env.WORKERS_SUBDOMAIN}.workers.dev`
    : `https://${workerName}.workers.dev`;
}

// ============================================================================
// Worker Handler
// ============================================================================

const previewManagerHandler = {
  async fetch(request: Request, env: PreviewManagerEnv, ctx: ExecutionContext): Promise<Response> {
    // Auth gate - fail closed, applies to every route including /health
    const denied = authGate(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/health' || path === '/api/health') {
      return new Response(JSON.stringify({
        status: 'healthy',
        service: 'preview-manager',
        timestamp: Date.now(),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle preview deployment requests from queue-consumer
    if (path === '/api/preview/deploy' && request.method === 'POST') {
      return await handleDeployPreviewRequest(request, env);
    }

    // Build a canary version for a candidate (canary worker). Rollback is not
    // here: it is a Spec DO deploy-ref move.
    if (path === '/api/preview/canary' && request.method === 'POST') {
      return await handleCanaryVersionRequest(request, env);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async queue(batch: MessageBatch<PreviewQueueMessage>, env: PreviewManagerEnv, ctx: ExecutionContext): Promise<void> {
    const logger = {
      info: (msg: string, data?: object) => console.log(`[PreviewManager] ${msg}`, data || ''),
      error: (msg: string, error?: unknown) => console.error(`[PreviewManager] ${msg}`, error || ''),
      debug: (msg: string, data?: object) => console.debug(`[PreviewManager] ${msg}`, data || ''),
    };

    logger.info(`Processing batch of ${batch.messages.length} messages from queue ${batch.queue}`);

    // Get Spec DO stub for persistence
    const specDoStub = getSpecDoStub(env, DEFAULT_SPEC_DO_NAME);

    // Process each message in the batch
    const processingPromises = batch.messages.map(async (message) => {
      try {
        logger.debug(`Processing message ${message.id}`);
        
        const msg: PreviewQueueMessage = message.body;
        const event = msg.event;
        
        logger.info(`Received push event: ${event.id} for ${event.repository.full_name}@${event.commit.sha}`);

        // Find candidate by repository URL from Spec DO
        const candidate = await findCandidateByRepo(specDoStub, event.repository.full_name);
        
        if (!candidate) {
          logger.info(`No candidate found for repo ${event.repository.full_name}, skipping`);
          return;
        }

        logger.info(`Found candidate ${candidate.id} for push event`);

        // Deploy preview for this candidate
        const deployment = await deployPreview(specDoStub, candidate, event, env, logger);
        
        if (deployment.success) {
          logger.info(`Preview deployed for candidate ${candidate.id}: ${deployment.previewUrl}`);
          
          // Trigger shadow comparisons for this preview
          await triggerShadowComparisons(env, candidate, deployment, logger);
        } else {
          logger.error(`Preview deployment failed for candidate ${candidate.id}: ${deployment.error}`);
        }

        logger.debug(`Completed message ${message.id}`);
      } catch (error) {
        logger.error(`Error processing message ${message.id}:`, error);
      }
    });

    // Wait for all messages to be processed
    await Promise.allSettled(processingPromises);

    // Acknowledge all messages in the batch
    batch.ackAll();

    logger.info(`Batch processing complete`);
  },
};

// ============================================================================
// API Request Handlers
// ============================================================================

/**
 * Handle preview deployment request from queue-consumer
 */
async function handleDeployPreviewRequest(
  request: Request,
  env: PreviewManagerEnv
): Promise<Response> {
  try {
    const body = await request.json<DeployPreviewRequestBody>();
    const {
      candidateId,
      repository,
      commit,
      commitSha,
      baseCommitSha,
      timestamp,
    } = body;

    console.log(`[PreviewManager] Received deployment request for candidate ${candidateId}`);

    // Validate required fields
    if (!candidateId || !repository || !commit) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: candidateId, repository, commit',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Construct an ArtifactsPushEvent from the request body
    const event: ArtifactsPushEvent = {
      id: commitSha || `preview-${Date.now()}`,
      type: 'push',
      repository: {
        name: repository.name,
        namespace: repository.namespace,
        full_name: repository.full_name,
      },
      commit: {
        sha: commitSha || commit.sha,
        message: commit.message,
        author: commit.author,
        timestamp: commit.timestamp || new Date(timestamp || Date.now()).toISOString(),
      },
      ref: 'refs/heads/main', // Default ref, can be overridden
      base_ref: baseCommitSha ? 'base' : undefined,
      created_at: new Date(timestamp || Date.now()).toISOString(),
    };

    // Get Spec DO stub for persistence
    const specDoStub = getSpecDoStub(env, DEFAULT_SPEC_DO_NAME);

    // Find candidate by ID from Spec DO
    const candidate = await findCandidateById(specDoStub, candidateId);

    if (!candidate) {
      return new Response(JSON.stringify({
        success: false,
        error: `No candidate found with ID ${candidateId}`,
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Deploy preview for this candidate
    const deployment = await deployPreview(specDoStub, candidate, event, env, {
      info: (msg: string, data?: object) => console.log(`[PreviewManager] ${msg}`, data || ''),
      error: (msg: string, error?: unknown) => console.error(`[PreviewManager] ${msg}`, error || ''),
    });

    if (deployment.success) {
      // Trigger shadow comparisons for this preview
      await triggerShadowComparisons(env, candidate, deployment, {
        info: (msg: string, data?: object) => console.log(`[PreviewManager] ${msg}`, data || ''),
        error: (msg: string, error?: unknown) => console.error(`[PreviewManager] ${msg}`, error || ''),
      });

      return new Response(JSON.stringify({
        success: true,
        candidateId: candidate.id,
        previewUrl: deployment.previewUrl,
        previewWorkerName: deployment.workerName,
        deployedAt: deployment.deployedAt,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      return new Response(JSON.stringify({
        success: false,
        error: deployment.error || 'Preview deployment failed',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch (error) {
    console.error(`[PreviewManager] Error handling deploy preview request:`, error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Build a Workers version of a candidate for canary and return { url, versionId }.
 * Stateless: the canary worker records the deployment and moves the deploy ref.
 */
async function handleCanaryVersionRequest(request: Request, env: PreviewManagerEnv): Promise<Response> {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, 400);
  }
  const parsed = CanaryVersionRequestSchema.safeParse(raw);
  if (!parsed.success) return json({ success: false, error: parsed.error.message }, 400);
  const { candidateId, specId } = parsed.data;

  const versions = workerVersionsClientFor(env);
  if (!versions) {
    return json({
      success: false,
      error: 'Workers Versions client not implemented (unverified API, docs/OPEN-QUESTIONS.md); the local stub needs WORKER_VERSIONS_MODE=stub and BEEHIVE_LOCAL_DEV=1 (scripts/start-e2e-workers.sh)',
    }, 501);
  }

  try {
    const stub = getSpecDoStub(env, DEFAULT_SPEC_DO_NAME);
    const res = await stub.fetch(
      new Request(`https://spec-do.internal/api/candidates/${encodeURIComponent(candidateId)}`, {
        headers: { 'X-Actor-ID': 'preview-manager' },
      })
    );
    let candidate: Candidate | null = null;
    if (res.ok) {
      candidate = ((await res.json()) as { data?: Candidate }).data ?? null;
    } else if (res.status !== 404) {
      return json({ success: false, error: `Spec DO candidate lookup failed: ${res.status}` }, 502);
    }
    if (candidate && candidate.specId !== specId) {
      return json({ success: false, error: `Candidate ${candidateId} belongs to spec ${candidate.specId}, not ${specId}` }, 409);
    }

    const workerName = `${PREVIEW_WORKER_PREFIX}${candidateId}`;
    const commitSha = candidate?.commitSha ?? parsed.data.commitSha ?? null;
    const version = await versions.createVersion({ workerName, candidateId, commitSha });
    return json({
      success: true,
      candidateId,
      specId,
      workerName,
      commitSha,
      url: version.url,
      versionId: version.versionId,
      versionsClient: versions.kind,
    });
  } catch (error) {
    return json({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Find candidate by ID from Spec DO
 */
async function findCandidateById(
  specDoStub: SpecDoStub,
  candidateId: string
): Promise<Candidate | null> {
  try {
    const candidateResp = await specDoStub.fetch(
      new Request(`https://spec-do.internal/api/candidates/${candidateId}`, {
        headers: { 'X-Actor-ID': 'preview-manager' },
      })
    );

    if (!candidateResp.ok) {
      console.error(`[PreviewManager] Failed to fetch candidate ${candidateId}: ${candidateResp.status}`);
      return null;
    }

    const candidateData = await candidateResp.json() as { data?: Candidate };
    return candidateData.data || null;
  } catch (error) {
    console.error(`[PreviewManager] Error finding candidate by ID:`, error);
    return null;
  }
}

/**
 * Find candidate by repository URL from Spec DO
 */
async function findCandidateByRepo(
  specDoStub: SpecDoStub,
  repoFullName: string
): Promise<Candidate | null> {
  try {
    const candidatesResp = await specDoStub.fetch(
      new Request(`https://spec-do.internal/api/candidates?limit=100`, {
        headers: { 'X-Actor-ID': 'preview-manager' },
      })
    );

    if (!candidatesResp.ok) {
      console.error(`[PreviewManager] Failed to fetch candidates: ${candidatesResp.status}`);
      return null;
    }

    const candidatesData = await candidatesResp.json() as { data?: Candidate[] };
    const candidates = candidatesData.data || [];

    return candidates.find((c: Candidate) => c.repository?.remote_url === repoFullName) || null;
  } catch (error) {
    console.error(`[PreviewManager] Error finding candidate by repo:`, error);
    return null;
  }
}

/**
 * Deploy a preview Worker for a candidate
 * 
 * In M2, this uses Workers Builds to create a preview deployment.
 * 
 * Flow:
 * 1. Fetch candidate code from Cloudflare Artifacts
 * 2. Create Workers Builds preview via Cloudflare API
 * 3. Wait for build completion
 * 4. Store preview URL in Spec DO
 * 
 * Note: Falls back to simulated preview URL if Workers Builds API is unavailable.
 */
async function deployPreview(
  specDoStub: SpecDoStub,
  candidate: Candidate,
  event: ArtifactsPushEvent,
  env: PreviewManagerEnv,
  logger: { info: (msg: string, data?: object) => void; error: (msg: string, error?: unknown) => void }
): Promise<PreviewDeployment> {
  const startTime = Date.now();
  const workerName = `${PREVIEW_WORKER_PREFIX}${candidate.id}`;
  
  logger.info(`Starting preview deployment for candidate ${candidate.id}`, {
    workerName,
    commitSha: event.commit.sha,
    repository: event.repository.full_name,
  });

  try {
    // Check if we have Cloudflare API credentials
    if (!env.CLOUDFLARE_API_TOKEN) {
      logger.error('CLOUDFLARE_API_TOKEN not configured, falling back to simulated preview');
      return createSimulatedPreview(specDoStub, candidate, event, workerName, logger, env);
    }

    // Initialize clients
    let buildsClient: WorkersBuildsClient;
    let artifactsClient: ArtifactsClient;
    
    try {
      buildsClient = new WorkersBuildsClient(env);
      artifactsClient = new ArtifactsClient(env);
    } catch (initError) {
      logger.error(`Failed to initialize API clients: ${initError instanceof Error ? initError.message : String(initError)}, falling back to simulated preview`);
      return createSimulatedPreview(specDoStub, candidate, event, workerName, logger, env);
    }

    // Extract repository info from the event (most reliable source)
    const repoNamespace = event.repository.namespace;
    const repoName = event.repository.name;
    
    if (!repoNamespace || !repoName) {
      logger.error('Repository namespace and name are required');
      return createSimulatedPreview(specDoStub, candidate, event, workerName, logger, env);
    }

    // Step 1: Create Workers Builds preview
    logger.info(`Creating Workers Builds preview for ${repoNamespace}/${repoName}@${event.commit.sha}`);
    
    const buildResult = await buildsClient.createPreviewBuild(
      workerName,
      candidate.id,
      event.commit.sha
    );

    if (!buildResult.success) {
      logger.error(`Workers Builds creation failed: ${buildResult.error}`);
      return {
        previewUrl: '',
        workerName,
        deployedAt: Date.now(),
        success: false,
        error: `Workers Builds failed: ${buildResult.error}`,
      };
    }

    const previewUrl = buildResult.previewUrl;
    const buildId = buildResult.buildId;
    
    logger.info(`Workers Builds preview created`, {
      buildId,
      previewUrl,
      workerName,
    });

    // Step 2: Update candidate with preview information in Spec DO
    const updateResponse = await specDoStub.fetch(
      new Request(`https://spec-do.internal/api/candidates/${candidate.id}/preview`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-ID': 'preview-manager',
        },
        body: JSON.stringify({
          previewUrl,
          previewWorkerName: workerName,
          previewDeployedAt: Date.now(),
          commitSha: event.commit.sha,
          baseCommitSha: event.base_ref || candidate.baseCommitSha || candidate.base_commit_sha,
          buildId,
        }),
      })
    );

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      logger.error(`Failed to update candidate preview in Spec DO: ${updateResponse.status} - ${errorText}`);
      return {
        previewUrl,
        workerName,
        deployedAt: Date.now(),
        success: false,
        error: `Spec DO update failed: ${updateResponse.status}`,
      };
    }

    const durationMs = Date.now() - startTime;
    
    logger.info(`Preview deployment completed for candidate ${candidate.id}`, {
      workerName,
      previewUrl,
      buildId,
      durationMs,
    });

    return {
      previewUrl,
      workerName,
      deployedAt: Date.now(),
      success: true,
    };
  } catch (error) {
    logger.error(`Preview deployment error for candidate ${candidate.id}:`, error);
    return {
      previewUrl: '',
      workerName: '',
      deployedAt: Date.now(),
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Fallback: Create simulated preview when Workers Builds API is not available
 * This is used for local development and testing.
 */
async function createSimulatedPreview(
  specDoStub: SpecDoStub,
  candidate: Candidate,
  event: ArtifactsPushEvent,
  workerName: string,
  logger: { info: (msg: string, data?: object) => void; error: (msg: string, error?: unknown) => void },
  env: PreviewManagerEnv
): Promise<PreviewDeployment> {
  const previewUrl = previewUrlFor(env, workerName);
  
  logger.info(`Creating simulated preview (Workers Builds API not available)`);

  try {
    // Update candidate with preview information in Spec DO
    const updateResponse = await specDoStub.fetch(
      new Request(`https://spec-do.internal/api/candidates/${candidate.id}/preview`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-ID': 'preview-manager',
        },
        body: JSON.stringify({
          previewUrl,
          previewWorkerName: workerName,
          previewDeployedAt: Date.now(),
          commitSha: event.commit.sha,
          baseCommitSha: event.base_ref || candidate.baseCommitSha || candidate.base_commit_sha,
        }),
      })
    );

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      logger.error(`Failed to update candidate preview in Spec DO: ${updateResponse.status} - ${errorText}`);
      return {
        previewUrl,
        workerName,
        deployedAt: Date.now(),
        success: false,
        error: `Spec DO update failed: ${updateResponse.status}`,
      };
    }

    return {
      previewUrl,
      workerName,
      deployedAt: Date.now(),
      success: true,
    };
  } catch (error) {
    logger.error(`Simulated preview creation error:`, error);
    return {
      previewUrl: '',
      workerName: '',
      deployedAt: Date.now(),
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Trigger shadow comparisons for the preview candidate
 * Sends a message to the preview-scientist-comparisons queue
 */
async function triggerShadowComparisons(
  env: PreviewManagerEnv,
  candidate: Candidate,
  deployment: PreviewDeployment,
  logger: { info: (msg: string, data?: object) => void; error: (msg: string, error?: unknown) => void }
): Promise<void> {
  if (!deployment.success || !deployment.previewUrl) {
    logger.info(`Skipping shadow comparisons - deployment failed for candidate ${candidate.id}`);
    return;
  }

  try {
    // Create a ping message to test the preview
    const testMessage = {
      type: 'preview-deployed',
      candidateId: candidate.id,
      specId: candidate.specId,
      previewUrl: deployment.previewUrl,
      previewWorkerName: deployment.workerName,
      deployedAt: deployment.deployedAt,
      commitSha: candidate.commitSha,
      timestamp: Date.now(),
    };

    // Send to preview-scientist-comparisons queue
    // In production, the Shadow Router will send actual comparison messages
    // For now, we just send a deployment notification
    await env.PREVIEW_SCIENTIST_QUEUE.send(testMessage);
    
    logger.info(`Shadow comparisons triggered for candidate ${candidate.id}`, {
      previewUrl: deployment.previewUrl,
    });
  } catch (error) {
    logger.error(`Failed to trigger shadow comparisons for candidate ${candidate.id}:`, error);
  }
}

// ============================================================================
// Cloudflare Workers Builds Integration (Stub for future implementation)
// ============================================================================

/**
 * STUB: Create Workers Builds preview (to be implemented with Cloudflare API)
 * 
 * This function would:
 * 1. Get the candidate's source code from Artifacts/Repository
 * 2. Create a Workers Builds preview deployment
 * 3. Return the preview URL
 * 
 * Requires:
 * - CLOUDFLARE_API_TOKEN with Workers:Edit permissions
 * - Account-level Workers Builds enabled
 */
async function createWorkersBuildsPreview(
  accountId: string,
  apiToken: string,
  namespace: string,
  repoName: string,
  commitSha: string,
  workerName: string
): Promise<{ previewUrl: string; success: boolean; error?: string }> {
  // TODO: Implement with Cloudflare Workers Builds API
  // See: https://developers.cloudflare.com/workers/platform/workers-builds/
  
  console.log(`[PreviewManager] Workers Builds integration not yet implemented`);
  console.log(`[PreviewManager] Would create preview: ${workerName} from ${namespace}/${repoName}@${commitSha}`);
  
  // For now, return a simulated preview URL
  return {
    previewUrl: `https://${workerName}.${namespace}.workers.dev`,
    success: true,
  };
}

// ============================================================================
// Exports
// ============================================================================

export default previewManagerHandler satisfies ExportedHandler<PreviewManagerEnv>;

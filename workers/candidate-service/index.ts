/**
 * Candidate Service Worker
 * 
 * Handles candidate-specific operations for the Beehive platform.
 * 
 * API Endpoints:
 * - POST /api/candidates/{candidateId}/preview - Deploy preview for candidate
 * - GET /api/candidates/{candidateId}/preview - Get preview info
 * - PUT /api/candidates/{candidateId}/preview - Update preview info
 * - GET /api/candidates/{candidateId}/health - Check candidate health
 * - GET /api/candidates/{candidateId} - Get candidate details
 */

import { authGate } from '../shared/auth';
import type {
  CandidateServiceEnv,
  Candidate,
  DeployPreviewRequest,
  DeployPreviewResponse,
  HealthCheckRequest,
  HealthCheckResponse,
  GetCandidateRequest,
  GetCandidateResponse,
  UpdatePreviewRequest,
  UpdatePreviewResponse,
  ExportedHandler,
} from './types';
import {
  DeployPreviewRequestSchema,
  UpdatePreviewRequestSchema,
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

const candidateServiceHandler = {
  async fetch(request: Request, env: CandidateServiceEnv, ctx: ExecutionContext): Promise<Response> {
    // Auth gate - fail closed, applies to every route including /health
    const denied = authGate(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Health check
    if (path === '/health' || path === '/api/health') {
      return handleHealthCheck();
    }

    // ==========================================================================
    // CANDIDATE ENDPOINTS
    // ==========================================================================

    // Extract candidateId from path: /api/candidates/{candidateId}/...
    const candidateIdMatch = path.match(/^\/api\/candidates\/([^\/]+)/);
    const candidateId = candidateIdMatch ? candidateIdMatch[1] : null;

    if (!candidateId) {
      return new Response(JSON.stringify({ error: 'Candidate ID required in path' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get Spec DO stub
    const specDoStub = getSpecDoStub(env, DEFAULT_SPEC_DO_NAME);

    // ==========================================================================
    // Deploy Preview: POST /api/candidates/{candidateId}/preview
    // ==========================================================================

    if (path === `/api/candidates/${candidateId}/preview` && method === 'POST') {
      const parsed = DeployPreviewRequestSchema.safeParse(await request.json().catch(() => ({})));
      if (!parsed.success) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid request body', details: parsed.error }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return handleDeployPreview(specDoStub, candidateId, parsed.data, env);
    }

    // ==========================================================================
    // Get Preview: GET /api/candidates/{candidateId}/preview
    // ==========================================================================

    if (path === `/api/candidates/${candidateId}/preview` && method === 'GET') {
      return handleGetPreview(specDoStub, candidateId);
    }

    // ==========================================================================
    // Update Preview: PUT /api/candidates/{candidateId}/preview
    // ==========================================================================

    if (path === `/api/candidates/${candidateId}/preview` && method === 'PUT') {
      const parsed = UpdatePreviewRequestSchema.safeParse(await request.json().catch(() => ({})));
      if (!parsed.success) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid request body', details: parsed.error }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return handleUpdatePreview(specDoStub, candidateId, parsed.data);
    }

    // ==========================================================================
    // Health Check: GET /api/candidates/{candidateId}/health
    // ==========================================================================

    if (path === `/api/candidates/${candidateId}/health` && method === 'GET') {
      const queryParams: HealthCheckRequest = {
        candidateId,
        previewUrl: url.searchParams.get('previewUrl') || undefined,
      };
      return handleHealthCheckCandidate(specDoStub, queryParams);
    }

    // ==========================================================================
    // Get Candidate: GET /api/candidates/{candidateId}
    // ==========================================================================

    if (path === `/api/candidates/${candidateId}` && method === 'GET') {
      return handleGetCandidate(specDoStub, candidateId);
    }

    // ==========================================================================
    // 404 for unknown routes
    // ==========================================================================

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

// ============================================================================
// Handler Functions
// ============================================================================

/**
 * Handle health check
 */
function handleHealthCheck(): Response {
  return new Response(JSON.stringify({
    status: 'healthy',
    service: 'candidate-service',
    timestamp: Date.now(),
    version: '1.0.0',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handle deploy preview request
 */
async function handleDeployPreview(
  specDoStub: SpecDoStub,
  candidateId: string,
  requestBody: DeployPreviewRequest,
  env: CandidateServiceEnv
): Promise<Response> {
  const logger = {
    info: (msg: string) => console.log(`[CandidateService] ${msg}`),
    error: (msg: string, error?: unknown) => console.error(`[CandidateService] ${msg}`, error || ''),
  };

  try {
    // Get candidate from Spec DO
    const candidate = await getCandidateById(specDoStub, candidateId);
    
    if (!candidate) {
      return new Response(JSON.stringify({
        success: false,
        error: `Candidate ${candidateId} not found`,
      } as DeployPreviewResponse), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    logger.info(`Deploying preview for candidate ${candidateId}`);

    // Check if we already have a preview and forceRedeploy is not set
    if (candidate.previewUrl && !requestBody.forceRedeploy) {
      logger.info(`Candidate ${candidateId} already has preview: ${candidate.previewUrl}`);
      
      return new Response(JSON.stringify({
        success: true,
        previewUrl: candidate.previewUrl,
        previewWorkerName: candidate.previewWorkerName,
        deployedAt: candidate.previewDeployedAt,
        candidate,
      } as DeployPreviewResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Generate preview worker name and URL
    const workerName = `${PREVIEW_WORKER_PREFIX}${candidateId}`;
    const previewUrl = previewUrlFor(env, workerName);
    const commitSha = requestBody.commitSha || candidate.commitSha;

    // Update candidate with preview info in Spec DO
    const updateResponse = await specDoStub.fetch(
      new Request(`https://spec-do.internal/api/candidates/${candidateId}/preview`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-ID': 'candidate-service',
        },
        body: JSON.stringify({
          previewUrl,
          previewWorkerName: workerName,
          previewDeployedAt: Date.now(),
          commitSha,
        }),
      })
    );

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      logger.error(`Failed to update candidate preview: ${updateResponse.status} - ${errorText}`);
      
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to update preview: ${errorText}`,
      } as DeployPreviewResponse), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get updated candidate
    const updatedCandidate = await getCandidateById(specDoStub, candidateId);

    logger.info(`Preview deployed for candidate ${candidateId}: ${previewUrl}`);

    return new Response(JSON.stringify({
      success: true,
      previewUrl,
      previewWorkerName: workerName,
      deployedAt: Date.now(),
      candidate: updatedCandidate,
    } as DeployPreviewResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error(`[CandidateService] Deploy preview error for ${candidateId}:`, error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    } as DeployPreviewResponse), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle get preview request
 */
async function handleGetPreview(
  specDoStub: SpecDoStub,
  candidateId: string
): Promise<Response> {
  try {
    const candidate = await getCandidateById(specDoStub, candidateId);
    
    if (!candidate) {
      return new Response(JSON.stringify({
        error: `Candidate ${candidateId} not found`,
      } as DeployPreviewResponse), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!candidate.previewUrl) {
      return new Response(JSON.stringify({
        error: `Candidate ${candidateId} has no preview deployed`,
      } as DeployPreviewResponse), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      previewUrl: candidate.previewUrl,
      previewWorkerName: candidate.previewWorkerName,
      deployedAt: candidate.previewDeployedAt,
      candidate,
    } as DeployPreviewResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    } as DeployPreviewResponse), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle update preview request
 */
async function handleUpdatePreview(
  specDoStub: SpecDoStub,
  candidateId: string,
  requestBody: UpdatePreviewRequest
): Promise<Response> {
  try {
    // Verify candidate exists
    const candidate = await getCandidateById(specDoStub, candidateId);
    
    if (!candidate) {
      return new Response(JSON.stringify({
        success: false,
        error: `Candidate ${candidateId} not found`,
      } as UpdatePreviewResponse), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update candidate with new preview info
    const updateResponse = await specDoStub.fetch(
      new Request(`https://spec-do.internal/api/candidates/${candidateId}/preview`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-ID': 'candidate-service',
        },
        body: JSON.stringify({
          previewUrl: requestBody.previewUrl,
          previewWorkerName: requestBody.previewWorkerName,
          previewDeployedAt: Date.now(),
        }),
      })
    );

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to update preview: ${errorText}`,
      } as UpdatePreviewResponse), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get updated candidate
    const updatedCandidate = await getCandidateById(specDoStub, candidateId);

    return new Response(JSON.stringify({
      success: true,
      candidate: updatedCandidate,
    } as UpdatePreviewResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    } as UpdatePreviewResponse), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle health check for a candidate
 */
async function handleHealthCheckCandidate(
  specDoStub: SpecDoStub,
  queryParams: HealthCheckRequest
): Promise<Response> {
  const startTime = Date.now();
  
  try {
    const candidate = await getCandidateById(specDoStub, queryParams.candidateId);
    
    if (!candidate) {
      return new Response(JSON.stringify({
        healthy: false,
        candidateId: queryParams.candidateId,
        error: 'Candidate not found',
        checkedAt: Date.now(),
      } as HealthCheckResponse), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const previewUrl = queryParams.previewUrl || candidate.previewUrl;
    
    if (!previewUrl) {
      return new Response(JSON.stringify({
        healthy: false,
        candidateId: queryParams.candidateId,
        error: 'No preview URL available',
        checkedAt: Date.now(),
      } as HealthCheckResponse), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Perform health check
    const { healthy, statusCode, latencyMs, error } = await checkPreviewHealth(previewUrl);
    const checkedAt = Date.now();
    const durationMs = checkedAt - startTime;

    const response: HealthCheckResponse = {
      healthy,
      candidateId: queryParams.candidateId,
      previewUrl,
      latencyMs,
      statusCode,
      error,
      checkedAt,
    };

    return new Response(JSON.stringify(response), {
      status: healthy ? 200 : 503,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      healthy: false,
      candidateId: queryParams.candidateId,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    } as HealthCheckResponse), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Handle get candidate request
 */
async function handleGetCandidate(
  specDoStub: SpecDoStub,
  candidateId: string
): Promise<Response> {
  try {
    const candidate = await getCandidateById(specDoStub, candidateId);
    
    if (!candidate) {
      return new Response(JSON.stringify({
        error: `Candidate ${candidateId} not found`,
      } as GetCandidateResponse), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      candidate,
    } as GetCandidateResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    } as GetCandidateResponse), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get candidate by ID from Spec DO
 */
async function getCandidateById(
  specDoStub: SpecDoStub,
  candidateId: string
): Promise<Candidate | null> {
  try {
    const response = await specDoStub.fetch(
      new Request(`https://spec-do.internal/api/candidates/${candidateId}`, {
        headers: { 'X-Actor-ID': 'candidate-service' },
      })
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch candidate: ${response.status}`);
    }

    const data = await response.json() as { data?: Candidate };
    return data.data || null;
  } catch (error) {
    console.error(`[CandidateService] Error getting candidate ${candidateId}:`, error);
    return null;
  }
}

/**
 * Check the health of a preview Worker
 */
async function checkPreviewHealth(
  previewUrl: string
): Promise<{ healthy: boolean; statusCode?: number; latencyMs?: number; error?: string }> {
  const startTime = Date.now();
  
  try {
    const healthUrl = `${previewUrl}/health`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(healthUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    
    const latencyMs = Date.now() - startTime;
    
    if (response.ok) {
      return {
        healthy: true,
        statusCode: response.status,
        latencyMs,
      };
    }
    
    return {
      healthy: false,
      statusCode: response.status,
      latencyMs,
      error: `Health check returned status ${response.status}`,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    return {
      healthy: false,
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

export default candidateServiceHandler satisfies ExportedHandler<CandidateServiceEnv>;

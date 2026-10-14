/**
 * Beehive Promotion Worker
 * Main entry point for the M3 Promotion Implementation
 * 
 * This worker implements the promotion train with tournament and merge-train modes.
 * It handles both HTTP requests and queue messages for candidate promotion.
 */

import { PromotionWorker } from './promotion';
import { TournamentManager } from './tournament';
import { MergeTrainManager } from './merge-train';
import { authGate, AuthEnv } from '../shared/auth';
import { Env, PromotionMode, Rung } from './types';

// Extend Env with auth requirements
export interface PromotionEnv extends Env, AuthEnv {}

/**
 * Create promotion worker instance
 */
function createWorker(env: PromotionEnv): PromotionWorker {
  return new PromotionWorker(env);
}

/**
 * Main fetch handler
 */
async function handleFetch(
  request: Request,
  env: PromotionEnv,
  ctx: ExecutionContext
): Promise<Response> {
  // Auth gate - fail closed, applies to every route
  const denied = authGate(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const worker = createWorker(env);
  const tournament = new TournamentManager(env);
  const mergeTrain = new MergeTrainManager(env);

  // ============================================================================
  // HEALTH CHECK
  // ============================================================================

  if (path === '/health' || path === '/promotion/health') {
    return new Response(JSON.stringify({
      status: 'healthy',
      worker: 'promotion-worker',
      timestamp: Date.now(),
      mode: worker.getMode(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ============================================================================
  // PROMOTION OPERATIONS
  // ============================================================================

  // POST /promote - Promote a candidate
  if (path === '/promote' && method === 'POST') {
    try {
      const body = await request.json() as { candidateId: string; specId: string; fromRung: Rung; toRung: Rung; actorId?: string };
      return await worker.promoteCandidate(body);
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid request body',
        timestamp: new Date().toISOString()
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // GET /promote - Get promotion status
  if (path === '/promote' && method === 'GET') {
    return await worker.getPromotionStatus();
  }

  // GET /promote/:candidateId - Get status for specific candidate
  if (path.match(/^\/promote\/[^\/]+$/) && method === 'GET') {
    const candidateId = path.split('/').pop() || '';
    return await worker.getCandidatePromotionStatus(decodeURIComponent(candidateId));
  }

  // POST /promote/:candidateId/retry - Retry a failed promotion
  if (path.match(/^\/promote\/[^\/]+\/retry$/) && method === 'POST') {
    const parts = path.split('/');
    const candidateId = decodeURIComponent(parts[2]);
    
    try {
      const body = await request.json() as { actorId?: string };
      return await worker.retryPromotion(candidateId, body.actorId);
    } catch (error) {
      return await worker.retryPromotion(candidateId);
    }
  }

  // POST /promote/:candidateId/cancel - Cancel a pending promotion
  if (path.match(/^\/promote\/[^\/]+\/cancel$/) && method === 'POST') {
    const parts = path.split('/');
    const candidateId = decodeURIComponent(parts[2]);
    
    try {
      const body = await request.json() as { reason?: string };
      return await worker.cancelPromotion(candidateId, body.reason);
    } catch (error) {
      return await worker.cancelPromotion(candidateId);
    }
  }

  // ============================================================================
  // MODE MANAGEMENT
  // ============================================================================

  // GET /mode - Get current promotion mode
  if (path === '/mode' && method === 'GET') {
    return await worker.getCurrentMode();
  }

  // POST /mode - Set promotion mode
  if (path === '/mode' && method === 'POST') {
    try {
      const body = await request.json() as { mode: PromotionMode };
      return await worker.setMode(body);
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid request body',
        timestamp: new Date().toISOString()
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // ============================================================================
  // TOURNAMENT MODE
  // ============================================================================

  // GET /tournament/status - Get tournament status
  if (path === '/tournament/status' || path === '/tournament') {
    const specId = url.searchParams.get('specId') || undefined;
    return await tournament.getTournamentStatus(specId);
  }

  // GET /tournament/list - List all tournaments
  if (path === '/tournament/list') {
    return await tournament.getTournamentStatus();
  }

  // ============================================================================
  // MERGE-TRAIN MODE
  // ============================================================================

  // GET /merge-train/status - Get merge train status
  if (path === '/merge-train/status' || path === '/merge-train') {
    const specId = url.searchParams.get('specId') || undefined;
    return await mergeTrain.getMergeTrainStatus(specId);
  }

  // GET /merge-train/list - List all merge trains
  if (path === '/merge-train/list') {
    return await mergeTrain.getMergeTrainStatus();
  }

  // ============================================================================
  // MERGE OPERATIONS
  // ============================================================================

  // POST /merge/retry - Retry failed merge
  if (path === '/merge/retry' && method === 'POST') {
    try {
      const body = await request.json() as { candidateId: string; specId: string };
      const { candidateId, specId } = body;
      
      if (!candidateId || !specId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing candidateId or specId',
          timestamp: new Date().toISOString()
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const result = await mergeTrain.retryFailedMerge(candidateId, specId);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid request body',
        timestamp: new Date().toISOString()
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // POST /merge/rollback - Rollback merged candidate
  if (path === '/merge/rollback' && method === 'POST') {
    try {
      const body = await request.json() as { candidateId: string; specId: string; reason?: string };
      const { candidateId, specId, reason } = body;
      
      if (!candidateId || !specId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing candidateId or specId',
          timestamp: new Date().toISOString()
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const result = await mergeTrain.rollbackMergedCandidate(candidateId, specId, reason || 'Manual rollback');
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid request body',
        timestamp: new Date().toISOString()
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // ============================================================================
  // STATISTICS
  // ============================================================================

  // GET /stats - Get promotion statistics
  if (path === '/stats' && method === 'GET') {
    try {
      const workerStatus = await worker.getPromotionStatus();
      const workerData = await workerStatus.json();

      return new Response(JSON.stringify({
        success: true,
        promotionStats: workerData,
        timestamp: new Date().toISOString()
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // ============================================================================
  // 404
  // ============================================================================

  return new Response(JSON.stringify({
    success: false,
    error: 'Not found',
    timestamp: new Date().toISOString()
  }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Queue message handler
 */
async function handleQueue(
  batch: MessageBatch<string>,
  env: PromotionEnv
): Promise<void> {
  const worker = createWorker(env);

  for (const message of batch.messages) {
    try {
      await worker.processQueueMessage({
        id: message.id,
        body: message.body,
        timestamp: message.timestamp.getTime(),
      });
    } catch (error) {
      console.error('Failed to process queue message:', error);
    }
  }
}

/**
 * Exported handler for Cloudflare Workers
 */
export default {
  fetch: handleFetch,
  queue: handleQueue,
};

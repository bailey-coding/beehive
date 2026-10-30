/**
 * Beehive Canary Worker
 * Handles canary deployments with SLO monitoring and auto-rollback
 */

import { authGate } from '../shared/auth';
import { CanaryWorker, CANARY_ACTOR_ID, deployRefsClient, jsonResponse } from './canary';
import { RollbackManager } from './rollback';
import { SLOMonitor } from './slo';
import { handleRollbackQueue } from './queues';
import type { Env, RollbackTrigger, CanaryConfig } from './types';
import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';

async function readBody<T>(request: Request): Promise<T | Response> {
  try {
    return (await request.json()) as T;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
}

// Not exported: workerd treats every named export of the entry module as an entrypoint, and a string is not one
// (local `wrangler dev` fails with "Incorrect type for map entry").
const SLO_TICK_QUEUE = 'canary-slo-ticks';

/** One SLO pass over every live canary; run for each batch of the tick queue. Never throws. */
export async function runSloCycle(env: Env): Promise<void> {
  try {
    await new SLOMonitor(env).runCycle(new RollbackManager(env));
  } catch (error) {
    // No verdict (bad config, live canaries unreadable): never a rollback. The next tick retries.
    console.error('[Canary] SLO cycle skipped:', error instanceof Error ? error.message : String(error));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Auth gate - fail closed, applies to every route including /health
    const denied = await authGate(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'healthy', timestamp: Date.now() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Pass env as-is. SPEC_DO must stay the namespace: the classes call
    // idFromName()/get() on it. A stub in its place turns idFromName() into an
    // RPC call returning an RpcPromise, and get(RpcPromise) throws DataCloneError.
    const canary = new CanaryWorker(env);
    const rollback = new RollbackManager(env);
    const slo = new SLOMonitor(env);

    // Handle canary deployment requests
    if (path === '/deploy-canary' && request.method === 'POST') {
      const config = await readBody<CanaryConfig>(request);
      if (config instanceof Response) return config;
      return await canary.deployCanary(config);
    }
    
    // Handle rollback requests
    if (path === '/rollback' && request.method === 'POST') {
      const trigger = await readBody<RollbackTrigger>(request);
      if (trigger instanceof Response) return trigger;
      return await rollback.triggerRollback(trigger);
    }
    
    // Get SLO status
    if (path === '/slo-status' && request.method === 'GET') {
      return await slo.getSLOStatus();
    }

    // List a candidate's canary deployments (newest first)
    if (path === '/canary-deployments' && request.method === 'GET') {
      const candidateId = url.searchParams.get('candidateId');
      if (!candidateId) return jsonResponse({ error: 'candidateId required' }, 400);
      const res = await deployRefsClient(env).listCanaryDeployments(candidateId);
      return res.ok ? jsonResponse({ success: true, deployments: res.data }) : jsonResponse({ error: res.error }, res.status);
    }
    
    // Get canary deployment by deployment ID
    const deploymentMatch = path.match(/^\/canary-deployments\/([^\/]+)$/);
    if (deploymentMatch && request.method === 'GET') {
      const result = await canary.getCanaryDeployment(decodeURIComponent(deploymentMatch[1]));
      return result.deployment
        ? jsonResponse({ success: true, deployment: result.deployment })
        : jsonResponse({ error: result.status === 404 ? 'Deployment not found' : result.error }, result.status);
    }

    // Auto-rollback switch of a candidate's live canary: GET reads it, POST { enabled } sets it.
    // A manual POST /rollback always runs; automatic (SLO) triggers respect the switch.
    const autoRollbackMatch = path.match(/^\/canary\/([^\/]+)\/auto-rollback$/);
    if (autoRollbackMatch && (request.method === 'GET' || request.method === 'POST')) {
      const candidateId = decodeURIComponent(autoRollbackMatch[1]);
      let enabled: boolean | undefined;
      if (request.method === 'POST') {
        const body = await readBody<{ enabled?: unknown }>(request);
        if (body instanceof Response) return body;
        if (typeof body?.enabled !== 'boolean') return jsonResponse({ error: 'enabled (boolean) is required' }, 400);
        enabled = body.enabled;
      }
      let live;
      try {
        live = await canary.getLiveCanary(candidateId);
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 502);
      }
      if (!live) return jsonResponse({ error: 'No live canary deployment for this candidate' }, 404);
      let deployment = live;
      if (enabled !== undefined) {
        const res = await deployRefsClient(env).setAutoRollback(live.id, enabled, CANARY_ACTOR_ID);
        if (!res.ok) return jsonResponse({ error: res.error }, res.status);
        deployment = res.data;
      }
      return jsonResponse({ success: true, candidateId, deploymentId: deployment.id, enabled: deployment.autoRollback });
    }
    
    // Default response - return 404 for unknown routes
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  },
  
  // Queue consumer for rollback triggers and SLO ticks
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    if (batch.queue === SLO_TICK_QUEUE) {
      // One cycle per batch however many ticks piled up; ack all (the next alarm sends a fresh tick)
      await runSloCycle(env);
      batch.ackAll();
      return;
    }
    // Same rule as fetch: SPEC_DO stays the namespace
    await handleRollbackQueue(batch, env);
  }
} satisfies ExportedHandler<Env>;

type ExportedHandler<E = unknown> = {
  fetch: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;
  queue: (batch: MessageBatch, env: E, ctx: ExecutionContext) => Promise<void>;
};

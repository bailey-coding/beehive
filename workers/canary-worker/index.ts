/**
 * Beehive Canary Worker
 * Handles canary deployments with SLO monitoring and auto-rollback
 */

import { authGate } from '../shared/auth';
import { CanaryWorker } from './canary';
import { RollbackManager } from './rollback';
import { SLOMonitor } from './slo';
import { handleRollbackQueue } from './queues';
import type { Env, RollbackTrigger, CanaryConfig } from './types';
import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';

const DEFAULT_SPEC_DO_NAME = 'main';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Auth gate - fail closed, applies to every route including /health
    const denied = authGate(request, env);
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

    // Initialize services
    const specDoId = env.SPEC_DO.idFromName(DEFAULT_SPEC_DO_NAME);
    const specDoStub = env.SPEC_DO.get(specDoId);
    const canary = new CanaryWorker({ ...env, SPEC_DO: specDoStub } as unknown as Env);
    const rollback = new RollbackManager({ ...env, SPEC_DO: specDoStub } as unknown as Env);
    const slo = new SLOMonitor({ ...env, SPEC_DO: specDoStub } as unknown as Env);

    // Handle canary deployment requests
    if (path === '/deploy-canary' && request.method === 'POST') {
      try {
        const config: CanaryConfig = await request.json();
        return await canary.deployCanary(config);
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // Handle rollback requests
    if (path === '/rollback' && request.method === 'POST') {
      try {
        const trigger: RollbackTrigger = await request.json();
        return await rollback.triggerRollback(trigger);
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    // Get SLO status
    if (path === '/slo-status' && request.method === 'GET') {
      return await slo.getSLOStatus();
    }
    
    // Get canary deployment by candidate ID
    if (path.startsWith('/canary-deployments/') && request.method === 'GET') {
      const candidateId = path.split('/').pop();
      if (!candidateId) {
        return new Response(JSON.stringify({ error: 'Candidate ID required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const deployment = await canary.getCanaryDeployment(candidateId);
      if (!deployment) {
        return new Response(JSON.stringify({ error: 'Deployment not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify(deployment), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Default response
    return new Response('Canary Worker - Beehive Platform', { status: 200 });
  },
  
  // Queue consumer for rollback triggers
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    const specDoId = env.SPEC_DO.idFromName(DEFAULT_SPEC_DO_NAME);
    const specDoStub = env.SPEC_DO.get(specDoId);
    
    // Process rollback queue messages
    await handleRollbackQueue(
      batch,
      { ...env, SPEC_DO: specDoStub } as unknown as Env
    );
  }
} satisfies ExportedHandler<Env>;

type ExportedHandler<E = unknown> = {
  fetch: (request: Request, env: E, ctx: ExecutionContext) => Promise<Response>;
  queue: (batch: MessageBatch, env: E, ctx: ExecutionContext) => Promise<void>;
};

import { RollbackTrigger, Env } from './types';
import { CanaryWorker, CANARY_ACTOR_ID, deployRefsClient, jsonResponse } from './canary';
import type { Message } from '@cloudflare/workers-types';

/**
 * Rollback is a ref operation (AGENTS.md rule 7): the Spec DO moves the spec's
 * canary deploy ref back to its previous target, in one transaction with the
 * deployment and promotion status updates. Nothing is redeployed; the shadow
 * router follows the ref.
 */
export class RollbackManager {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async triggerRollback(trigger: RollbackTrigger): Promise<Response> {
    try {
      if (!trigger?.candidateId || !trigger.reason) {
        return jsonResponse({ error: 'candidateId and reason are required' }, 400);
      }

      // specId 'all' comes from SLOMonitor's aggregate violations
      const specId = trigger.specId && trigger.specId !== 'all' ? trigger.specId : undefined;
      const deployment = await new CanaryWorker(this.env).getLiveCanary(trigger.candidateId, specId);
      if (!deployment) {
        return jsonResponse({ error: 'Canary deployment not found' }, 404);
      }

      // Automatic triggers respect the per-canary switch; a manual rollback always runs
      if (trigger.reason !== 'manual' && !deployment.autoRollback) {
        return jsonResponse({ error: 'Auto-rollback is disabled for this canary', deployment }, 409);
      }

      const moved = await deployRefsClient(this.env).rollbackCanary(deployment.id, trigger.reason, CANARY_ACTOR_ID);
      if (!moved.ok) {
        return jsonResponse({ success: false, error: moved.error }, moved.status);
      }

      this.logAnalytics('canary_rollback', {
        candidateId: trigger.candidateId,
        reason: trigger.reason
      });

      return jsonResponse({ success: true, deployment: moved.data.deployment, deployRef: moved.data.ref });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return jsonResponse({ error: errorMessage }, 500);
    }
  }

  async handleQueueMessage(message: { id: string; body: unknown; timestamp: number }): Promise<Response> {
    try {
      const body = JSON.parse(String(message.body)) as RollbackTrigger;
      return await this.triggerRollback(body);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return jsonResponse({ error: errorMessage }, 500);
    }
  }

  async processQueueMessage(message: Message): Promise<void> {
    try {
      const body = JSON.parse(String(message.body)) as RollbackTrigger;
      await this.triggerRollback(body);
    } catch (error) {
      console.error('Failed to process rollback message:', error);
    }
  }

  private logAnalytics(event: string, data: Record<string, unknown>) {
    try {
      this.env.ANALYTICS.writeDataPoint({
        indexes: [{ event }],
        blobs: [{ event: JSON.stringify(data) }],
        doubles: Object.entries(data)
          .filter(([_, v]) => typeof v === 'number')
          .map(([k, v]) => ({ [k]: v as number }))
      });
    } catch (error) {
      console.error('[Canary] Failed to write analytics:', error);
    }
  }
}

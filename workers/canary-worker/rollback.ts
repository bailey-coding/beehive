import { RollbackTrigger, CanaryDeployment, Env } from './types';
import type { Message } from '@cloudflare/workers-types';

export class RollbackManager {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async triggerRollback(trigger: RollbackTrigger): Promise<Response> {
    try {
      // Get current canary deployment
      const canaryWorker = new (await import('./canary')).CanaryWorker(this.env);
      const deployment = await canaryWorker.getCanaryDeployment(trigger.candidateId);
      
      if (!deployment) {
        return new Response(JSON.stringify({ error: 'Canary deployment not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Update deployment status
      deployment.status = 'rolling_back';
      deployment.updatedAt = new Date().toISOString();

      const specDoId = this.env.SPEC_DO.idFromName('main');
      const specDoStub = this.env.SPEC_DO.get(specDoId);

      await specDoStub.fetch(
        `https://spec-do.internal/api/canary-deployments/${deployment.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(deployment)
        }
      );

      // Trigger rollback via Preview Manager
      const rollbackResponse = await this.env.PREVIEW_MANAGER.fetch(
        'https://preview-manager.internal/api/rollback',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidateId: trigger.candidateId,
            reason: trigger.reason
          })
        }
      );

      if (!rollbackResponse.ok) {
        const errorText = await rollbackResponse.text();
        throw new Error(`Failed to trigger preview rollback: ${errorText}`);
      }

      // Update status to rolled_back
      deployment.status = 'rolled_back';
      await specDoStub.fetch(
        `https://spec-do.internal/api/canary-deployments/${deployment.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(deployment)
        }
      );

      // Log rollback to Analytics Engine
      await this.logAnalytics('canary_rollback', {
        candidateId: trigger.candidateId,
        reason: trigger.reason
      });

      return new Response(JSON.stringify({ 
        success: true, 
        deployment: deployment 
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ error: errorMessage }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  async handleQueueMessage(message: { id: string; body: unknown; timestamp: number }): Promise<Response> {
    try {
      const body = JSON.parse(String(message.body)) as RollbackTrigger;
      return await this.triggerRollback(body);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ error: errorMessage }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
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

  private async logAnalytics(event: string, data: Record<string, unknown>) {
    await this.env.ANALYTICS.writeDataPoint({
      indexes: [{ event }],
      blobs: [{ event: JSON.stringify(data) }],
      doubles: Object.entries(data)
        .filter(([_, v]) => typeof v === 'number')
        .map(([k, v]) => ({ [k]: v as number }))
    });
  }
}

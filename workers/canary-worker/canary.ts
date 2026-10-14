import { CanaryConfig, CanaryDeployment, Env } from './types';

interface PreviewDeploymentResponse {
  url: string;
  id: string;
}

export class CanaryWorker {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async deployCanary(config: CanaryConfig): Promise<Response> {
    try {
      // Validate configuration
      if (!this.validateConfig(config)) {
        return new Response(JSON.stringify({ error: 'Invalid configuration' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Create canary deployment via Preview Manager
      const previewResponse = await this.env.PREVIEW_MANAGER.fetch(
        'https://preview-manager.internal/api/deploy',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidateId: config.candidateId,
            specId: config.specId,
            isCanary: true,
            trafficPercentage: config.trafficPercentage
          })
        }
      );

      if (!previewResponse.ok) {
        const errorText = await previewResponse.text();
        throw new Error(`Failed to create preview deployment: ${errorText}`);
      }

      const previewData = await previewResponse.json() as PreviewDeploymentResponse;

      // Store canary deployment in Spec DO
      const deployment: CanaryDeployment = {
        id: this.generateId(),
        candidateId: config.candidateId,
        specId: config.specId,
        status: 'active',
        url: previewData.url,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const specDoId = this.env.SPEC_DO.idFromName('main');
      const specDoStub = this.env.SPEC_DO.get(specDoId);

      await specDoStub.fetch(
        'https://spec-do.internal/api/canary-deployments',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(deployment)
        }
      );

      // Log to Analytics Engine
      await this.logAnalytics('canary_deploy', {
        candidateId: config.candidateId,
        specId: config.specId,
        trafficPercentage: config.trafficPercentage
      });

      return new Response(JSON.stringify(deployment), {
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

  async getCanaryDeployment(candidateId: string): Promise<CanaryDeployment | null> {
    const specDoId = this.env.SPEC_DO.idFromName('main');
    const specDoStub = this.env.SPEC_DO.get(specDoId);

    const response = await specDoStub.fetch(
      `https://spec-do.internal/api/canary-deployments?candidateId=${candidateId}`
    );
    
    if (!response.ok) {
      return null;
    }

    const deployments = await response.json() as CanaryDeployment[];
    return deployments[0] || null;
  }

  private validateConfig(config: CanaryConfig): boolean {
    return (
      !!config.candidateId &&
      !!config.specId &&
      config.trafficPercentage > 0 &&
      config.trafficPercentage <= 100 &&
      config.holdoutPercentage >= 0 &&
      config.holdoutPercentage <= 100
    );
  }

  private generateId(): string {
    return `canary_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
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

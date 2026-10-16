import { DeployRefsClient, type CanaryDeployment } from '../shared/deploy-refs';
import { CanaryConfig, Env } from './types';

export const CANARY_ACTOR_ID = 'canary-worker';

// Answer of preview-manager POST /api/preview/canary
interface CanaryVersionResponse {
  success: boolean;
  url?: string;
  versionId?: string;
  commitSha?: string | null;
  error?: string;
}

/** Typed Spec DO client over the env's SPEC_DO namespace (never a stub in env). */
export function deployRefsClient(env: Env): DeployRefsClient {
  const stub = env.SPEC_DO.get(env.SPEC_DO.idFromName('main'));
  return new DeployRefsClient({
    fetch: (path, init) => stub.fetch(`https://spec-do.internal${path}`, init),
  });
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export class CanaryWorker {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Build a version via the preview manager, then record the canary and move
   * the spec's canary deploy ref to it (one Spec DO transaction).
   */
  async deployCanary(config: CanaryConfig): Promise<Response> {
    try {
      if (!this.validateConfig(config)) {
        return jsonResponse({ error: 'Invalid configuration' }, 400);
      }

      const previewResponse = await this.env.PREVIEW_MANAGER.fetch(
        'https://preview-manager.internal/api/preview/canary',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.env.API_AUTH_TOKEN || ''}`,
          },
          body: JSON.stringify({ candidateId: config.candidateId, specId: config.specId }),
        }
      );

      if (!previewResponse.ok) {
        const errorText = await previewResponse.text();
        // 4xx and 501 (no Versions client) pass through; other 5xx are an upstream failure
        const status = previewResponse.status < 500 || previewResponse.status === 501 ? previewResponse.status : 502;
        return jsonResponse({ success: false, error: `Failed to build canary version: ${errorText}` }, status);
      }

      const version = (await previewResponse.json()) as CanaryVersionResponse;
      if (!version.url || !version.versionId) {
        return jsonResponse({ success: false, error: 'Preview manager returned no url/versionId' }, 502);
      }

      const moved = await deployRefsClient(this.env).deployCanary(
        {
          candidateId: config.candidateId,
          specId: config.specId,
          url: version.url,
          workerVersionId: version.versionId,
          commitSha: version.commitSha ?? null,
          trafficPercentage: config.trafficPercentage,
          holdoutPercentage: config.holdoutPercentage,
          autoRollback: config.autoRollback,
        },
        CANARY_ACTOR_ID
      );
      if (!moved.ok) {
        return jsonResponse({ success: false, error: moved.error }, moved.status);
      }

      // The ref has moved; a metrics failure must not report the deploy as failed
      this.logAnalytics('canary_deploy', {
        candidateId: config.candidateId,
        specId: config.specId,
        trafficPercentage: config.trafficPercentage,
      });

      return jsonResponse({ success: true, deployment: moved.data.deployment, deployRef: moved.data.ref });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return jsonResponse({ success: false, error: errorMessage }, 500);
    }
  }

  async getCanaryDeployment(id: string): Promise<{ status: number; deployment?: CanaryDeployment; error?: string }> {
    const res = await deployRefsClient(this.env).getCanaryDeployment(id);
    return res.ok ? { status: 200, deployment: res.data } : { status: res.status, error: res.error };
  }

  /** The candidate's live canary (status 'deployed'), optionally for one spec, or null. */
  async getLiveCanary(candidateId: string, specId?: string): Promise<CanaryDeployment | null> {
    const res = await deployRefsClient(this.env).listCanaryDeployments(candidateId);
    if (!res.ok) throw new Error(res.error);
    return res.data.find((d) => d.status === 'deployed' && (!specId || d.specId === specId)) ?? null;
  }

  private validateConfig(config: CanaryConfig): boolean {
    return (
      !!config.candidateId &&
      !!config.specId &&
      config.trafficPercentage > 0 &&
      config.trafficPercentage <= 100 &&
      config.holdoutPercentage >= 0 &&
      config.holdoutPercentage <= 100 &&
      config.trafficPercentage + config.holdoutPercentage <= 100 &&
      (config.autoRollback === undefined || typeof config.autoRollback === 'boolean')
    );
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

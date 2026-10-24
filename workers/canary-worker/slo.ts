import { CANARY_METRICS_MAX_WINDOW_MINUTES, CANARY_METRICS_DEFAULT_WINDOW_MINUTES, type CanaryDeployment } from '../shared/deploy-refs';
import { deployRefsClient } from './canary';
import type { RollbackManager } from './rollback';
import type { DeploymentVerdict, Env, RollbackTrigger, SLOStatus } from './types';

export const DEFAULT_SLO_LATENCY_P95_MS = 1000;
export const DEFAULT_SLO_ERROR_RATE = 0.01;

function numberVar(name: string, raw: string | undefined, fallback: number, ok: (n: number) => boolean): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !ok(n)) throw new Error(`Invalid ${name}: ${JSON.stringify(raw)}`);
  return n;
}

/**
 * SLO thresholds from the environment. Unset or blank takes the default (the wrangler.toml values);
 * a value that is set but unusable throws, so there is no verdict and no rollback. It must never
 * degrade to NaN: `x > NaN` is false, which reads as "healthy" (fail open).
 */
export function sloThresholds(env: Pick<Env, 'CANARY_SLO_LATENCY_P95' | 'CANARY_SLO_ERROR_RATE'>): {
  latencyP95: number;
  errorRate: number;
} {
  return {
    latencyP95: numberVar('CANARY_SLO_LATENCY_P95', env.CANARY_SLO_LATENCY_P95, DEFAULT_SLO_LATENCY_P95_MS, (n) => n > 0),
    errorRate: numberVar('CANARY_SLO_ERROR_RATE', env.CANARY_SLO_ERROR_RATE, DEFAULT_SLO_ERROR_RATE, (n) => n > 0 && n <= 1),
  };
}

export const DEFAULT_SLO_MIN_REQUESTS = 50;

export interface SloConfig {
  latencyP95: number;
  errorRate: number;
  minRequests: number;
  windowMinutes: number;
  source: 'shadow' | 'canary';
}

/** All SLO settings, validated. Throws on a set-but-unusable value: no verdict, no rollback. */
export function sloConfig(env: Env): SloConfig {
  const { latencyP95, errorRate } = sloThresholds(env);
  const source = (env.CANARY_SLO_SOURCE ?? '').trim() || 'shadow';
  if (source !== 'shadow' && source !== 'canary') throw new Error(`Invalid CANARY_SLO_SOURCE: ${JSON.stringify(source)}`);
  return {
    latencyP95,
    errorRate,
    minRequests: numberVar('CANARY_SLO_MIN_REQUESTS', env.CANARY_SLO_MIN_REQUESTS, DEFAULT_SLO_MIN_REQUESTS, (n) => Number.isInteger(n) && n >= 1),
    windowMinutes: numberVar(
      'CANARY_SLO_WINDOW_MINUTES',
      env.CANARY_SLO_WINDOW_MINUTES,
      CANARY_METRICS_DEFAULT_WINDOW_MINUTES,
      (n) => Number.isInteger(n) && n >= 1 && n <= CANARY_METRICS_MAX_WINDOW_MINUTES
    ),
    source,
  };
}

export interface CycleResult {
  checked: number;
  rolledBack: string[];
  alreadyHandled: string[];
  skipped: string[];
  errors: string[];
}

export class SLOMonitor {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async getSLOStatus(): Promise<Response> {
    try {
      const status = await this.checkSLOs();

      return new Response(JSON.stringify(status), {
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

  /**
   * Verdicts for every live canary deployment, read from the Spec DO's canary metrics. Throws when the list of
   * live canaries cannot be read (the caller treats that as "no verdict").
   */
  async checkSLOs(): Promise<SLOStatus> {
    const cfg = sloConfig(this.env);
    const live = await deployRefsClient(this.env).liveRefs('canary');
    if (!live.ok) throw new Error(`Live canaries unavailable: ${live.error}`);

    const deployments: DeploymentVerdict[] = [];
    for (const { deployment } of live.data) {
      if (deployment && deployment.status === 'deployed') deployments.push(await this.evaluate(deployment, cfg));
    }
    const violations = deployments.flatMap((d) => d.violations);
    return {
      healthy: violations.length === 0,
      violations,
      source: cfg.source,
      windowMinutes: cfg.windowMinutes,
      minRequests: cfg.minRequests,
      deployments,
    };
  }

  /** One deployment's verdict. An unreadable metric is 'unavailable' (never 0, never healthy). */
  async evaluate(deployment: CanaryDeployment, cfg: SloConfig): Promise<DeploymentVerdict> {
    const base = {
      deploymentId: deployment.id,
      candidateId: deployment.candidateId,
      specId: deployment.specId,
      autoRollback: deployment.autoRollback,
      source: cfg.source,
      violations: [] as RollbackTrigger[],
    };
    let res;
    try {
      res = await deployRefsClient(this.env).canaryMetrics(deployment.id, cfg.source, cfg.windowMinutes);
    } catch (error) {
      return { ...base, verdict: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
    }
    // Any non-ok (old Spec DO 404, error, malformed body) is "unavailable", not "no traffic"
    if (!res.ok) return { ...base, verdict: 'unavailable', detail: `${res.status} ${res.error}` };

    const m = res.data;
    const metrics = { latencyP95: m.latencyP95Ms, errorRate: m.errorRate, requestCount: m.requests };
    if (m.requests < cfg.minRequests) {
      return { ...base, verdict: 'insufficient_data', metrics, detail: `${m.requests} of ${cfg.minRequests} requests` };
    }
    const timestamp = new Date().toISOString();
    const trigger = (reason: 'latency' | 'error_rate'): RollbackTrigger => ({
      candidateId: deployment.candidateId,
      specId: deployment.specId,
      reason,
      timestamp,
      metrics: { latencyP95: m.latencyP95Ms ?? undefined, errorRate: m.errorRate ?? undefined, requestCount: m.requests },
    });
    const violations: RollbackTrigger[] = [];
    if (m.latencyP95Ms !== null && m.latencyP95Ms > cfg.latencyP95) violations.push(trigger('latency'));
    if (m.errorRate !== null && m.errorRate > cfg.errorRate) violations.push(trigger('error_rate'));
    return { ...base, verdict: violations.length ? 'violation' : 'healthy', violations, metrics };
  }

  /**
   * One cron tick: evaluate every live canary and roll back the ones in violation whose auto-rollback is on.
   * Rollback is a ref move through RollbackManager. 404/409 from a rollback mean it already happened (a repeat or a
   * race) and are not errors. One deployment failing never stops the others. Throws only when there is no verdict
   * at all (bad config, live canaries unreadable).
   */
  async runCycle(rollback: RollbackManager): Promise<CycleResult> {
    const status = await this.checkSLOs();
    const result: CycleResult = { checked: status.deployments.length, rolledBack: [], alreadyHandled: [], skipped: [], errors: [] };
    for (const d of status.deployments) {
      if (d.verdict === 'unavailable') result.errors.push(`${d.deploymentId}: metrics unavailable (${d.detail})`);
      if (d.verdict !== 'violation') continue;
      if (!d.autoRollback) {
        result.skipped.push(d.deploymentId);
        continue;
      }
      try {
        const res = await rollback.triggerRollback(d.violations[0]);
        if (res.ok) result.rolledBack.push(d.deploymentId);
        else if (res.status === 404 || res.status === 409) result.alreadyHandled.push(d.deploymentId);
        else result.errors.push(`${d.deploymentId}: rollback answered ${res.status}`);
      } catch (error) {
        result.errors.push(`${d.deploymentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(JSON.stringify({ event: 'canary_slo_cycle', source: status.source, ...result }));
    return result;
  }
}

import { SLOStatus, RollbackTrigger, Env } from './types';

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

  async checkSLOs(): Promise<SLOStatus> {
    // Get current metrics from Analytics Engine
    const latencyP95 = await this.getMetric('latency_p95');
    const errorRate = await this.getMetric('error_rate');
    const requestCount = await this.getMetric('request_count');

    // Get SLO thresholds from environment
    const latencyThreshold = parseInt(this.env.CANARY_SLO_LATENCY_P95);
    const errorRateThreshold = parseFloat(this.env.CANARY_SLO_ERROR_RATE);

    // Check for violations
    const violations: RollbackTrigger[] = [];
    
    if (latencyP95 > latencyThreshold) {
      violations.push({
        candidateId: 'all',
        specId: 'all',
        reason: 'latency',
        timestamp: new Date().toISOString(),
        metrics: { latencyP95, errorRate, requestCount }
      });
    }

    if (errorRate > errorRateThreshold) {
      violations.push({
        candidateId: 'all',
        specId: 'all',
        reason: 'error_rate',
        timestamp: new Date().toISOString(),
        metrics: { latencyP95, errorRate, requestCount }
      });
    }

    return {
      healthy: violations.length === 0,
      violations,
      currentMetrics: { latencyP95, errorRate, requestCount }
    };
  }

  private async getMetric(metricName: string): Promise<number> {
    // Query Analytics Engine for metric
    // This is a simplified implementation
    // In production, we'd query the actual Analytics Engine
    // For now, return 0 as placeholder
    // Note: Analytics Engine API is not directly accessible in Workers
    // This would be replaced with actual query logic in production
    return 0;
  }

  // Check SLOs and trigger rollback if violated
  async monitorAndTriggerRollback(candidateId: string, specId: string): Promise<void> {
    const status = await this.checkSLOs();
    
    if (!status.healthy && status.violations.length > 0) {
      // Import RollbackManager dynamically to avoid circular dependency
      const { RollbackManager } = await import('./rollback');
      const rollback = new RollbackManager(this.env);
      await rollback.triggerRollback({
        candidateId,
        specId,
        reason: 'slo_violation',
        timestamp: new Date().toISOString(),
        metrics: status.currentMetrics
      });
    }
  }
}

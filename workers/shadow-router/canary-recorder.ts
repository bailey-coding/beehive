/**
 * Records mirrored-candidate outcomes as canary metrics in the Spec DO (docs/M3-CANARY-SLO-PLAN.md).
 *
 * Samples are aggregated in the isolate per (deployment, epoch minute) and flushed in batches, so the
 * Spec DO (the single serialization point) sees a few writes per isolate instead of one per mirrored
 * request. Isolates recycle: a few lost shadow samples are acceptable. Everything here is best effort:
 * a failure is logged and dropped, and never reaches the router's response.
 *
 * source is always 'shadow': the router mirrors traffic and discards the answers, so these are not
 * canary SLOs until real canary traffic exists.
 */
import {
  CANARY_METRICS_MAX_SAMPLES_PER_POST,
  LATENCY_BUCKET_COUNT,
  latencyBucketIndex,
  DeployRefsClient,
  type CanaryMetricSample,
  type SpecDoFetcher,
} from '../shared/deploy-refs';

export const FLUSH_AFTER_SAMPLES = 20;
export const FLUSH_AFTER_MS = 10_000;

interface Bucket {
  requests: number;
  errors: number;
  latencySumMs: number;
  latencyMaxMs: number;
  latencyBuckets: number[];
}

export class CanaryMetricsRecorder {
  private pending = new Map<string, Map<number, Bucket>>(); // deploymentId -> minute -> bucket
  private pendingSamples = 0;
  private firstAddAt = 0;
  private tailFlushScheduled = false;

  /** An outcome counts as an error when the candidate answered 5xx (a transport failure is already a synthetic 500). */
  add(deploymentId: string, status: number, latencyMs: number, nowMs = Date.now()): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    const minute = Math.floor(nowMs / 60_000);
    let byMinute = this.pending.get(deploymentId);
    if (!byMinute) this.pending.set(deploymentId, (byMinute = new Map()));
    let b = byMinute.get(minute);
    if (!b) {
      byMinute.set(minute, (b = { requests: 0, errors: 0, latencySumMs: 0, latencyMaxMs: 0, latencyBuckets: new Array(LATENCY_BUCKET_COUNT).fill(0) }));
    }
    if (this.pendingSamples === 0) this.firstAddAt = nowMs;
    this.pendingSamples++;
    b.requests++;
    if (status >= 500) b.errors++;
    b.latencySumMs += latencyMs;
    b.latencyMaxMs = Math.max(b.latencyMaxMs, latencyMs);
    b.latencyBuckets[latencyBucketIndex(latencyMs)]++;
  }

  shouldFlush(nowMs = Date.now()): boolean {
    return this.pendingSamples > 0 && (this.pendingSamples >= FLUSH_AFTER_SAMPLES || nowMs - this.firstAddAt >= FLUSH_AFTER_MS);
  }

  /**
   * Promise for `ctx.waitUntil`: after `waitMs`, flush whatever is still pending. `shouldFlush()` is only asked when another sample
   * is added, so without this the tail of a burst (fewer than FLUSH_AFTER_SAMPLES samples) stays in the isolate until the next
   * canary request, and is lost if the isolate recycles first. At most one is outstanding per recorder; returns null when nothing
   * is pending or one is already scheduled. Resolves after the flush and never rejects. The wait must stay well under the ~30 s
   * the platform gives `waitUntil` work after the response, which is why it equals FLUSH_AFTER_MS (10 s).
   */
  scheduleTailFlush(specDo: SpecDoFetcher | null, waitMs = FLUSH_AFTER_MS): Promise<void> | null {
    if (this.pendingSamples === 0 || this.tailFlushScheduled) return null;
    this.tailFlushScheduled = true;
    return new Promise<void>((resolve) => setTimeout(resolve, waitMs))
      .then(() => this.flush(specDo))
      .catch(() => undefined)
      .finally(() => { this.tailFlushScheduled = false; });
  }

  /** Send what is pending. The pending set is taken first, so concurrent requests never double-send. Never throws. */
  async flush(specDo: SpecDoFetcher | null): Promise<void> {
    const taken = this.pending;
    this.pending = new Map();
    this.pendingSamples = 0;
    if (!specDo || taken.size === 0) return;
    const client = new DeployRefsClient(specDo);
    for (const [deploymentId, byMinute] of taken) {
      const samples: CanaryMetricSample[] = [...byMinute].map(([minuteBucket, b]) => ({ minuteBucket, ...b }));
      for (let i = 0; i < samples.length; i += CANARY_METRICS_MAX_SAMPLES_PER_POST) {
        try {
          const res = await client.recordCanaryMetrics(
            { deploymentId, source: 'shadow', samples: samples.slice(i, i + CANARY_METRICS_MAX_SAMPLES_PER_POST) },
            'shadow-router'
          );
          // 404 (old Spec DO without the route, or an unknown deployment) and 409 (rolled back) just drop the batch
          if (!res.ok) console.warn(`[Shadow] canary metrics not recorded for ${deploymentId}: ${res.status} ${res.error}`);
        } catch (error) {
          console.warn('[Shadow] canary metrics flush failed:', error instanceof Error ? error.message : String(error));
        }
      }
    }
  }
}

let shared: CanaryMetricsRecorder | null = null;
/** One recorder per isolate. */
export function getCanaryMetricsRecorder(): CanaryMetricsRecorder {
  return (shared ??= new CanaryMetricsRecorder());
}

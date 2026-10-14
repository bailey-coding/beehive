/**
 * Performance Comparison
 * 
 * Compares latency and other performance metrics between baseline and candidate
 * according to the declared delta surface rules.
 */

import type {
  PerformanceComparisonResult,
  PerformanceIssue,
  DeltaSurface,
  PathDeltaSurface,
} from '../types';
import { matchPath } from '../delta-surface';

// ============================================================================
// Performance Comparison
// ============================================================================

/**
 * Compare performance between baseline and candidate
 * 
 * @param baselineLatencyMs - Latency of baseline response in milliseconds
 * @param candidateLatencyMs - Latency of candidate response in milliseconds
 * @param deltaSurface - The declared delta surface
 * @param path - The request path (for path-specific rules)
 * @returns Performance comparison result
 */
export function comparePerformance(
  baselineLatencyMs: number,
  candidateLatencyMs: number,
  deltaSurface: DeltaSurface,
  path: string
): PerformanceComparisonResult {
  // Get the path-specific configuration
  const pathConfig = matchPath(deltaSurface, path);

  // Get performance configuration (path-specific or default)
  const perfConfig = pathConfig.performance || deltaSurface.defaults.performance;

  // Default values if not specified
  const maxLatencyDeltaMs = perfConfig?.maxLatencyDeltaMs ?? 100;
  const maxLatencyRatio = perfConfig?.maxLatencyRatio ?? 2.0;

  // Calculate metrics
  const latencyDeltaMs = candidateLatencyMs - baselineLatencyMs;
  const latencyRatio = baselineLatencyMs > 0 
    ? candidateLatencyMs / baselineLatencyMs
    : Infinity;

  const issues: PerformanceIssue[] = [];

  // Check absolute delta
  if (Math.abs(latencyDeltaMs) > maxLatencyDeltaMs) {
    issues.push({
      type: 'absolute_delta_exceeded',
      deltaMs: latencyDeltaMs,
      threshold: maxLatencyDeltaMs,
      severity: 'warning',
    });
  }

  // Check ratio
  if (latencyRatio > maxLatencyRatio) {
    issues.push({
      type: 'ratio_exceeded',
      ratio: latencyRatio,
      threshold: maxLatencyRatio,
      severity: 'warning',
    });
  }

  return {
    match: issues.length === 0,
    baselineLatencyMs,
    candidateLatencyMs,
    latencyDeltaMs,
    latencyRatio,
    issues,
  };
}

// ============================================================================
// Performance Classification
// ============================================================================

/**
 * Classify performance based on latency
 */
export type PerformanceCategory =
  | 'excellent'
  | 'good'
  | 'acceptable'
  | 'slow'
  | 'very_slow';

/**
 * Classify candidate performance relative to baseline
 */
export function classifyPerformance(
  baselineLatencyMs: number,
  candidateLatencyMs: number
): PerformanceCategory {
  if (baselineLatencyMs === 0) {
    return candidateLatencyMs < 10 ? 'excellent' : 'good';
  }

  const ratio = candidateLatencyMs / baselineLatencyMs;

  if (ratio <= 0.8) {
    return 'excellent'; // 20% faster or more
  }
  if (ratio <= 1.0) {
    return 'good'; // Within baseline latency
  }
  if (ratio <= 1.2) {
    return 'acceptable'; // Up to 20% slower
  }
  if (ratio <= 2.0) {
    return 'slow'; // Up to 2x slower
  }
  return 'very_slow'; // More than 2x slower
}

/**
 * Get performance recommendation based on comparison
 */
export function getPerformanceRecommendation(
  result: PerformanceComparisonResult
): string {
  if (result.match) {
    return 'Performance is within acceptable limits';
  }

  const recommendations: string[] = [];

  for (const issue of result.issues) {
    switch (issue.type) {
      case 'absolute_delta_exceeded':
        recommendations.push(
          `Latency difference (${issue.deltaMs}ms) exceeds threshold (${issue.threshold}ms)`
        );
        break;
      case 'ratio_exceeded':
        recommendations.push(
          `Latency ratio (${issue.ratio ? issue.ratio.toFixed(2) : 'N/A'}x) exceeds threshold (${issue.threshold}x)`
        );
        break;
    }
  }

  if (recommendations.length === 0) {
    return 'Performance comparison inconclusive';
  }

  return recommendations.join('; ') + '.';
}

// ============================================================================
// Performance Statistics
// ============================================================================

/**
 * Calculate aggregate performance statistics from multiple comparisons
 */
export interface PerformanceStats {
  count: number;
  averageLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  averageRatio: number;
  matchRate: number; // 0-1
  improvementRate: number; // 0-1 (candidate faster than baseline)
  degradationRate: number; // 0-1 (candidate slower than baseline)
}

/**
 * Calculate performance statistics from an array of latencies
 */
export function calculatePerformanceStats(
  baselineLatencies: number[],
  candidateLatencies: number[]
): PerformanceStats {
  if (baselineLatencies.length === 0 || candidateLatencies.length === 0) {
    return {
      count: 0,
      averageLatencyMs: 0,
      minLatencyMs: 0,
      maxLatencyMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
      averageRatio: 0,
      matchRate: 0,
      improvementRate: 0,
      degradationRate: 0,
    };
  }

  // Calculate ratios
  const ratios = candidateLatencies.map((cl, i) => {
    const bl = baselineLatencies[i];
    return bl > 0 ? cl / bl : (cl > 0 ? Infinity : 0);
  });

  // Calculate match rate (within 2x and 100ms)
  const matches = candidateLatencies.filter((cl, i) => {
    const bl = baselineLatencies[i];
    const delta = Math.abs(cl - bl);
    const ratio = bl > 0 ? cl / bl : Infinity;
    return delta <= 100 && ratio <= 2.0;
  }).length;

  // Calculate improvement rate (candidate faster)
  const improvements = candidateLatencies.filter((cl, i) => {
    const bl = baselineLatencies[i];
    return bl > 0 && cl < bl;
  }).length;

  // Calculate degradation rate (candidate slower)
  const degradations = candidateLatencies.filter((cl, i) => {
    const bl = baselineLatencies[i];
    return bl > 0 && cl > bl;
  }).length;

  // Sort latencies for percentile calculation
  const sortedCandidateLatencies = [...candidateLatencies].sort((a, b) => a - b);

  return {
    count: candidateLatencies.length,
    averageLatencyMs: sortedCandidateLatencies.reduce((a, b) => a + b, 0) / sortedCandidateLatencies.length,
    minLatencyMs: Math.min(...sortedCandidateLatencies),
    maxLatencyMs: Math.max(...sortedCandidateLatencies),
    p50LatencyMs: percentile(sortedCandidateLatencies, 50),
    p95LatencyMs: percentile(sortedCandidateLatencies, 95),
    p99LatencyMs: percentile(sortedCandidateLatencies, 99),
    averageRatio: ratios.reduce((a, b) => a + (isFinite(b) ? b : 0), 0) / ratios.length,
    matchRate: matches / candidateLatencies.length,
    improvementRate: improvements / candidateLatencies.length,
    degradationRate: degradations / candidateLatencies.length,
  };
}

/**
 * Calculate percentile from sorted array
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const pos = (sorted.length - 1) * (p / 100);
  const base = Math.floor(pos);
  const rest = pos - base;

  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

// ============================================================================
// Exports
// ============================================================================

export type { PerformanceComparisonResult, PerformanceIssue, DeltaSurface, PathDeltaSurface };

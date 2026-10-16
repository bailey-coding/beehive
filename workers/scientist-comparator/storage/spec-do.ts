/**
 * Spec DO Storage Client
 * 
 * Provides utilities for interacting with the Spec DO to store comparison results.
 */

import type {
  ScientistQueueMessage,
  CandidateComparisonResult,
  RequestComparisonResult,
  CandidateShadowUpdate,
  ShadowMetrics,
} from '../types';
import { getSpecDoStub, type SpecDoCallerEnv, type SpecDoStub } from '../../shared/spec-do-auth';

// ============================================================================
// Spec DO Client
// ============================================================================

/**
 * Client for interacting with Spec DO
 */
export class SpecDOClient {
  private readonly env: SpecDoCallerEnv;

  constructor(env: SpecDoCallerEnv) {
    this.env = env;
  }

  /**
   * Get the Spec DO stub for the main namespace
   */
  private async getStub(): Promise<SpecDoStub> {
    // The Spec DO is namespaced by the main branch; calls carry this worker's internal token
    return getSpecDoStub(this.env);
  }

  /**
   * Get spec definition by ID
   */
  async getSpec(specId: string): Promise<{ id: string; declaredDeltaSurface: string } | null> {
    try {
      const stub = await this.getStub();
      const response = await stub.fetch(`/api/specs/${specId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.status === 200) {
        return await response.json();
      }
      return null;
    } catch (error) {
      console.error('[SpecDO] Failed to get spec:', error);
      return null;
    }
  }

  /**
   * Get candidate by ID
   */
  async getCandidate(candidateId: string): Promise<{
    id: string;
    specId: string;
    shadowScore?: number;
    shadowMatch?: boolean;
    shadowMetrics?: string;
  } | null> {
    try {
      const stub = await this.getStub();
      const response = await stub.fetch(`/api/candidates/${candidateId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.status === 200) {
        return await response.json();
      }
      return null;
    } catch (error) {
      console.error('[SpecDO] Failed to get candidate:', error);
      return null;
    }
  }

  /**
   * Get spec ID for a candidate
   */
  async getCandidateSpecId(candidateId: string): Promise<string | null> {
    const candidate = await this.getCandidate(candidateId);
    return candidate?.specId || null;
  }

  /**
   * Get declared delta surface for a spec
   */
  async getDeclaredDeltaSurface(specId: string): Promise<string | null> {
    const spec = await this.getSpec(specId);
    return spec?.declaredDeltaSurface || null;
  }

  /**
   * Update candidate shadow metrics
   */
  async updateCandidateShadowMetrics(
    candidateId: string,
    update: Partial<CandidateShadowUpdate>
  ): Promise<boolean> {
    try {
      const stub = await this.getStub();
      const response = await stub.fetch(`/api/candidates/${candidateId}/shadow`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });

      return response.status === 200;
    } catch (error) {
      console.error('[SpecDO] Failed to update candidate shadow metrics:', error);
      return false;
    }
  }

  /**
   * Record shadow gate verdict
   */
  async recordShadowVerdict(
    candidateId: string,
    verdict: {
      status: 'pass' | 'fail' | 'pending';
      score: number;
      notes: string;
    }
  ): Promise<boolean> {
    try {
      const stub = await this.getStub();
      const response = await stub.fetch(`/api/gate-verdicts/shadow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId,
          gate: 'shadow',
          ...verdict,
        }),
      });

      return response.status === 201;
    } catch (error) {
      console.error('[SpecDO] Failed to record shadow verdict:', error);
      return false;
    }
  }

  /**
   * Record comparison result for a single request
   * Updates the candidate's shadow metrics
   */
  async recordComparisonResult(
    result: CandidateComparisonResult
  ): Promise<boolean> {
    const candidate = await this.getCandidate(result.candidateId);
    if (!candidate) {
      console.error(`[SpecDO] Candidate ${result.candidateId} not found`);
      return false;
    }

    // Parse existing metrics
    const existingMetrics: ShadowMetrics = candidate.shadowMetrics
      ? JSON.parse(candidate.shadowMetrics)
      : {
          averageScore: 0,
          totalRequests: 0,
          matchedRequests: 0,
          aggregateDiffs: { total: 0, byType: {}, bySeverity: { error: 0, warning: 0, info: 0 } },
          lastComparisonAt: 0,
          lastRequestId: '',
        };

    // Update metrics
    const newMetrics: ShadowMetrics = {
      ...existingMetrics,
      totalRequests: existingMetrics.totalRequests + 1,
      
      // Update average score (rolling average)
      averageScore: updateRollingAverage(
        existingMetrics.averageScore,
        existingMetrics.totalRequests,
        result.score
      ).newScore,
      
      // Update match count
      matchedRequests: existingMetrics.matchedRequests + (result.matched ? 1 : 0),
      
      // Update aggregate diffs
      aggregateDiffs: {
        total: existingMetrics.aggregateDiffs.total + result.diffs.length,
        byType: aggregateByType(existingMetrics.aggregateDiffs.byType, result.diffs),
        bySeverity: aggregateBySeverity(
          existingMetrics.aggregateDiffs.bySeverity,
          result.diffs
        ),
      },
      
      lastComparisonAt: result.timestamp,
      lastRequestId: result.requestId,
    };

    // Update candidate
    const update: Partial<CandidateShadowUpdate> = {
      score: Math.round(newMetrics.averageScore),
      match: result.matched,
      metrics: newMetrics,
    };

    return await this.updateCandidateShadowMetrics(result.candidateId, update);
  }

  /**
   * Record comparison results for all candidates in a request
   */
  async recordRequestComparison(
    message: ScientistQueueMessage,
    results: RequestComparisonResult
  ): Promise<void> {
    // Record each candidate's result
    for (const candidateResult of results.candidates) {
      await this.recordComparisonResult(candidateResult);
    }

    // Optionally: update shadow gate verdict based on aggregate results
    const avgScore = results.candidates.reduce(
      (sum, c) => sum + c.score,
      0
    ) / results.candidates.length;

    for (const candidateResult of results.candidates) {
      // Update shadow gate verdict if score has changed significantly
      const candidate = await this.getCandidate(candidateResult.candidateId);
      const existingVerdict = candidate?.shadowScore !== undefined
        ? classifyScore(candidate.shadowScore)
        : 'pending';
      const newClassification = classifyScore(candidateResult.score);

      // Only update verdict if classification changed or this is the first result
      if (existingVerdict !== newClassification || !candidate?.shadowScore) {
        await this.recordShadowVerdict(candidateResult.candidateId, {
          status: newClassification === 'failing' ? 'fail' : 'pass',
          score: candidateResult.score,
          notes: `Shadow comparison: ${candidateResult.matched ? 'matched' : 'differences found'}`,
        });
      }
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Simple rolling average update
 */
function updateRollingAverage(
  current: number,
  count: number,
  newValue: number
): { newScore: number; newCount: number } {
  const newCount = count + 1;
  const newScore = (current * count + newValue) / newCount;
  return { newScore, newCount };
}

/**
 * Aggregate diffs by type
 */
function aggregateByType(
  existing: Record<string, number>,
  newDiffs: Array<{ type: string }>
): Record<string, number> {
  const result = { ...existing };
  for (const diff of newDiffs) {
    result[diff.type] = (result[diff.type] || 0) + 1;
  }
  return result;
}

/**
 * Aggregate diffs by severity
 */
function aggregateBySeverity(
  existing: Record<'error' | 'warning' | 'info', number>,
  newDiffs: Array<{ severity: 'error' | 'warning' | 'info' }>
): Record<'error' | 'warning' | 'info', number> {
  const result = { ...existing };
  for (const diff of newDiffs) {
    result[diff.severity] = (result[diff.severity] || 0) + 1;
  }
  return result;
}

/**
 * Classify score for verdict
 */
function classifyScore(score: number): 'excellent' | 'good' | 'acceptable' | 'poor' | 'failing' {
  if (score >= 95) return 'excellent';
  if (score >= 80) return 'good';
  if (score >= 60) return 'acceptable';
  if (score >= 40) return 'poor';
  return 'failing';
}

// ============================================================================
// Exports
// ============================================================================

export type { ScientistQueueMessage, CandidateComparisonResult, RequestComparisonResult };

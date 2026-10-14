/**
 * Score Calculator
 * 
 * Calculates the overall comparison score (0-100) based on individual comparison results.
 * The score reflects how well a candidate matches the baseline according to the
 * declared delta surface.
 */

import type {
  CandidateComparisonResult,
  ComparisonDiff,
  StatusResult,
  HeaderComparisonResult,
  BodyComparisonResult,
  PerformanceComparisonResult,
} from '../types';

// ============================================================================
// Scoring Weights
// ============================================================================

/**
 * Scoring weights configuration
 * Defines how much each component contributes to the overall score
 */
export interface ScoringWeights {
  // Status code matching (0-100 scale)
  status: {
    match: number; // Points for matching status
    mismatch: number; // Points deducted for non-matching status
    forbidden: number; // Points deducted for forbidden status
  };
  
  // Header matching
  header: {
    match: number; // Points per matching header
    error: number; // Points deducted per header error
    warning: number; // Points deducted per header warning
  };
  
  // Body matching
  body: {
    match: number; // Points per matching field
    error: number; // Points deducted per body error
    warning: number; // Points deducted per body warning
  };
  
  // Performance matching
  performance: {
    match: number; // Points for matching performance
    error: number; // Points deducted per performance error
    warning: number; // Points deducted per performance warning
  };
  
  // Maximum points per category
  maxPoints: {
    status: number;
    headers: number;
    body: number;
    performance: number;
  };
}

/**
 * Default scoring weights
 */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  status: {
    match: 40,
    mismatch: 20,
    forbidden: 40,
  },
  header: {
    match: 2,
    error: 10,
    warning: 5,
  },
  body: {
    match: 2,
    error: 15,
    warning: 5,
  },
  performance: {
    match: 20,
    error: 10,
    warning: 5,
  },
  maxPoints: {
    status: 40,
    headers: 20,
    body: 40,
    performance: 20,
  },
};

// ============================================================================
// Score Calculation
// ============================================================================

/**
 * Calculate score for status comparison
 */
export function calculateStatusScore(result: StatusResult): { score: number; max: number } {
  const weights = DEFAULT_WEIGHTS;
  const max = weights.maxPoints.status;

  if (result.match) {
    return { score: max, max };
  }

  if (result.severity === 'error') {
    return { score: Math.max(0, max - weights.status.forbidden), max };
  }

  return { score: Math.max(0, max - weights.status.mismatch), max };
}

/**
 * Calculate score for header comparison
 */
export function calculateHeaderScore(result: HeaderComparisonResult): { score: number; max: number } {
  const weights = DEFAULT_WEIGHTS;
  const max = weights.maxPoints.headers;

  if (result.match) {
    return { score: max, max };
  }

  // Count errors and warnings
  const errors = result.diffs.filter(d => d.severity === 'error').length;
  const warnings = result.diffs.filter(d => d.severity === 'warning').length;

  const deductions = errors * weights.header.error + warnings * weights.header.warning;
  return { score: Math.max(0, max - deductions), max };
}

/**
 * Calculate score for body comparison
 */
export function calculateBodyScore(result: BodyComparisonResult): { score: number; max: number } {
  const weights = DEFAULT_WEIGHTS;
  const max = weights.maxPoints.body;

  if (result.match) {
    return { score: max, max };
  }

  // Count errors and warnings
  const errors = result.diffs.filter(d => d.severity === 'error').length;
  const warnings = result.diffs.filter(d => d.severity === 'warning').length;

  const deductions = errors * weights.body.error + warnings * weights.body.warning;
  return { score: Math.max(0, max - deductions), max };
}

/**
 * Calculate score for performance comparison
 */
export function calculatePerformanceScore(result: PerformanceComparisonResult): { score: number; max: number } {
  const weights = DEFAULT_WEIGHTS;
  const max = weights.maxPoints.performance;

  if (result.match) {
    return { score: max, max };
  }

  // Count errors and warnings
  const errors = result.issues.filter(i => i.severity === 'error').length;
  const warnings = result.issues.filter(i => i.severity === 'warning').length;

  const deductions = errors * weights.performance.error + warnings * weights.performance.warning;
  return { score: Math.max(0, max - deductions), max };
}

/**
 * Calculate overall score from individual comparison results
 */
export function calculateOverallScore(
  statusResult: StatusResult,
  headerResult: HeaderComparisonResult,
  bodyResult: BodyComparisonResult,
  performanceResult: PerformanceComparisonResult
): number {
  const statusScore = calculateStatusScore(statusResult);
  const headerScore = calculateHeaderScore(headerResult);
  const bodyScore = calculateBodyScore(bodyResult);
  const performanceScore = calculatePerformanceScore(performanceResult);

  const totalScore = 
    statusScore.score +
    headerScore.score +
    bodyScore.score +
    performanceScore.score;

  const totalMax = 
    statusScore.max +
    headerScore.max +
    bodyScore.max +
    performanceScore.max;

  // Round to nearest integer
  return Math.round((totalScore / totalMax) * 100);
}

/**
 * Calculate the overall score for a candidate comparison
 */
export function calculateCandidateScore(result: CandidateComparisonResult): number {
  return calculateOverallScore(
    result.statusComparison,
    result.headerComparison,
    result.bodyComparison,
    result.performanceComparison
  );
}

// ============================================================================
// Score Aggregation
// ============================================================================

/**
 * Calculate rolling average score for a candidate
 * 
 * @param currentScore - Current rolling average score
 * @param currentCount - Number of requests used in current average
 * @param newScore - New score to incorporate
 * @param maxHistory - Maximum number of requests to keep in history
 */
export function updateRollingAverage(
  currentScore: number,
  currentCount: number,
  newScore: number,
  maxHistory: number = 100
): { newScore: number; newCount: number } {
  // If we have enough history, use fixed window
  if (currentCount >= maxHistory) {
    // For simplicity, we'll just average with the new score
    // A more sophisticated implementation would track all scores
    const alpha = 1.0 / maxHistory;
    const newAvg = currentScore * (1 - alpha) + newScore * alpha;
    return { newScore: newAvg, newCount: maxHistory };
  }

  // Otherwise, use simple average
  const newCount = currentCount + 1;
  const newAvg = (currentScore * currentCount + newScore) / newCount;
  return { newScore: newAvg, newCount };
}

/**
 * Track scores for multiple requests and calculate aggregate statistics
 */
export interface ScoreTracker {
  scores: number[];
  maxHistory: number;
}

/**
 * Create a new score tracker
 */
export function createScoreTracker(maxHistory: number = 100): ScoreTracker {
  return {
    scores: [],
    maxHistory,
  };
}

/**
 * Add a new score to the tracker
 */
export function addScore(tracker: ScoreTracker, score: number): void {
  tracker.scores.push(score);
  
  // Trim if exceeds max history
  while (tracker.scores.length > tracker.maxHistory) {
    tracker.scores.shift();
  }
}

/**
 * Get current average score from tracker
 */
export function getAverageScore(tracker: ScoreTracker): number {
  if (tracker.scores.length === 0) {
    return 0;
  }
  
  const sum = tracker.scores.reduce((a, b) => a + b, 0);
  return sum / tracker.scores.length;
}

/**
 * Get score statistics from tracker
 */
export interface ScoreStats {
  count: number;
  average: number;
  min: number;
  max: number;
  median: number;
  stdDev: number;
  passRate: number; // Percentage of scores >= 80
  excellentRate: number; // Percentage of scores >= 95
}

/**
 * Calculate statistics from a score tracker
 */
export function getScoreStats(tracker: ScoreTracker): ScoreStats {
  if (tracker.scores.length === 0) {
    return {
      count: 0,
      average: 0,
      min: 0,
      max: 0,
      median: 0,
      stdDev: 0,
      passRate: 0,
      excellentRate: 0,
    };
  }

  const sorted = [...tracker.scores].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const average = sum / sorted.length;
  const min = Math.min(...sorted);
  const max = Math.max(...sorted);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  // Calculate standard deviation
  const squaredDiffs = sorted.map(score => Math.pow(score - average, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / sorted.length;
  const stdDev = Math.sqrt(variance);

  // Calculate pass rates
  const passCount = sorted.filter(s => s >= 80).length;
  const excellentCount = sorted.filter(s => s >= 95).length;

  return {
    count: sorted.length,
    average,
    min,
    max,
    median,
    stdDev,
    passRate: passCount / sorted.length,
    excellentRate: excellentCount / sorted.length,
  };
}

// ============================================================================
// Score Interpretation
// ============================================================================

/**
 * Score range classification
 */
export type ScoreClassification =
  | 'excellent'
  | 'good'
  | 'acceptable'
  | 'poor'
  | 'failing';

/**
 * Classify a score into a quality category
 */
export function classifyScore(score: number): ScoreClassification {
  if (score >= 95) return 'excellent';
  if (score >= 80) return 'good';
  if (score >= 60) return 'acceptable';
  if (score >= 40) return 'poor';
  return 'failing';
}

/**
 * Get human-readable description of a score classification
 */
export function getScoreDescription(score: number): string {
  const classification = classifyScore(score);
  
  switch (classification) {
    case 'excellent':
      return 'Excellent match - candidate behaves almost identically to baseline';
    case 'good':
      return 'Good match - minor differences within acceptable limits';
    case 'acceptable':
      return 'Acceptable - some differences but overall compatible';
    case 'poor':
      return 'Poor match - significant differences detected';
    case 'failing':
      return 'Failing - major differences or errors';
    default:
      return 'Unknown score classification';
  }
}

/**
 * Get color for score classification (for UI)
 */
export function getScoreColor(score: number): string {
  const classification = classifyScore(score);
  
  switch (classification) {
    case 'excellent':
      return '#22c55e'; // Green
    case 'good':
      return '#84cc16'; // Light green
    case 'acceptable':
      return '#eab308'; // Yellow/amber
    case 'poor':
      return '#f97316'; // Orange
    case 'failing':
      return '#ef4444'; // Red
    default:
      return '#6b7280'; // Gray
  }
}

// ============================================================================
// Exports
// ============================================================================


/**
 * Shadow Router Configuration
 * Statsig Traffic Splitting Presets for M3
 */

import type { TrafficSplitConfig, ShadowConfig } from './types';
import { DeployRefsClient, type SpecDoFetcher } from '../shared/deploy-refs';

// ============================================================================
// Statsig Traffic Split Presets
// ============================================================================

/**
 * Default Statsig configuration for conservative canary deployments
 * - 1% to canary
 * - 1% to holdout
 * - 98% to baseline
 */
export const DEFAULT_STATSIG_CONFIG: TrafficSplitConfig = {
  canaryPercentage: 1,
  holdoutPercentage: 1,
  baselinePercentage: 98
};

/**
 * Predefined Statsig traffic split presets for different deployment strategies
 */
export const STATSIG_PRESETS: Record<string, TrafficSplitConfig> = {
  // Ultra-conservative: minimal canary exposure
  'conservative': {
    canaryPercentage: 1,
    holdoutPercentage: 1,
    baselinePercentage: 98
  },
  
  // Default moderate: balanced canary testing
  'moderate': {
    canaryPercentage: 5,
    holdoutPercentage: 5,
    baselinePercentage: 90
  },
  
  // Aggressive: higher canary exposure
  'aggressive': {
    canaryPercentage: 10,
    holdoutPercentage: 10,
    baselinePercentage: 80
  },
  
  // Balanced with larger holdout: good for A/B testing
  'balanced': {
    canaryPercentage: 25,
    holdoutPercentage: 5,
    baselinePercentage: 70
  },
  
  // 50/50 split: even distribution for major version comparisons
  'half-half': {
    canaryPercentage: 50,
    holdoutPercentage: 0,
    baselinePercentage: 50
  },
  
  // Quarter split: 25% canary, no holdout
  'quarter': {
    canaryPercentage: 25,
    holdoutPercentage: 0,
    baselinePercentage: 75
  },
  
  // Full canary: all traffic to canary (essentially a rollout)
  'full-canary': {
    canaryPercentage: 100,
    holdoutPercentage: 0,
    baselinePercentage: 0
  },
  
  // Test presets for specific scenarios
  'test-1pct': {
    canaryPercentage: 1,
    holdoutPercentage: 0,
    baselinePercentage: 99
  },
  
  'test-10pct': {
    canaryPercentage: 10,
    holdoutPercentage: 0,
    baselinePercentage: 90
  },
};

// ============================================================================
// Default Shadow Router Configuration
// ============================================================================

/**
 * Get default Shadow Router configuration with Statsig enabled
 */
export function getDefaultShadowConfig(): ShadowConfig {
  return {
    candidatePreviews: new Map(),
    sampleRate: 1.0,
    mirrorPaths: ['*'],
    excludePaths: ['/health', '/api/health', '/statsig'],
    statsig: {
      enabled: true,
      splits: {},
      defaultSplit: DEFAULT_STATSIG_CONFIG,
    },
  };
}

/**
 * Get local development Shadow Router configuration
 * Uses localhost ports for candidate Workers
 */
export function getLocalDevShadowConfig(): ShadowConfig {
  return {
    candidatePreviews: new Map([
      ['beehive-main', 'http://localhost:8787'],
      ['beehive-gate', 'http://localhost:8788'],
      ['beehive-queue', 'http://localhost:8789'],
      ['beehive-sandbox', 'http://localhost:8790'],
    ]),
    sampleRate: 1.0,
    mirrorPaths: ['*'],
    excludePaths: ['/health', '/api/health', '/statsig'],
    statsig: {
      enabled: true,
      splits: {
        // Example: specific config for beehive-main
        'beehive-main': STATSIG_PRESETS.moderate,
      },
      defaultSplit: DEFAULT_STATSIG_CONFIG,
    },
  };
}

/**
 * Get production Shadow Router configuration
 * Uses production worker URLs
 */
export function getProductionShadowConfig(): ShadowConfig {
  return {
    candidatePreviews: new Map([
      ['beehive-main', 'https://beehive.bz23711.workers.dev'],
    ]),
    sampleRate: 1.0,
    mirrorPaths: ['*'],
    excludePaths: ['/health', '/api/health', '/statsig'],
    statsig: {
      enabled: true,
      splits: {},
      defaultSplit: STATSIG_PRESETS.conservative,
    },
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate that a TrafficSplitConfig has valid percentages
 * @returns true if valid, false otherwise
 */
export function isValidTrafficSplitConfig(config: TrafficSplitConfig): boolean {
  const total = config.canaryPercentage + config.holdoutPercentage + config.baselinePercentage;
  return total === 100 && 
         config.canaryPercentage >= 0 && config.canaryPercentage <= 100 &&
         config.holdoutPercentage >= 0 && config.holdoutPercentage <= 100 &&
         config.baselinePercentage >= 0 && config.baselinePercentage <= 100;
}

/**
 * Normalize a TrafficSplitConfig to ensure percentages sum to 100
 * Adjusts baseline percentage to match
 */
export function normalizeTrafficSplitConfig(config: TrafficSplitConfig): TrafficSplitConfig {
  const canary = Math.max(0, Math.min(100, config.canaryPercentage));
  const holdout = Math.max(0, Math.min(100, config.holdoutPercentage));
  const baseline = 100 - canary - holdout;
  
  return {
    canaryPercentage: canary,
    holdoutPercentage: holdout,
    baselinePercentage: baseline,
  };
}

/**
 * Get a TrafficSplitConfig by preset name
 * @returns the preset config or DEFAULT_STATSIG_CONFIG if not found
 */
export function getPresetByName(name: string): TrafficSplitConfig {
  return STATSIG_PRESETS[name.toLowerCase()] || DEFAULT_STATSIG_CONFIG;
}

// ============================================================================
// Deploy refs (the canary traffic pointer)
// ============================================================================

/**
 * Overlay the live canary deploy refs from the Spec DO: each candidate a canary
 * ref points at is mirrored to at its version URL, with the deployment's split.
 * The ref is the only source of canary targets, so a rollback (ref move) takes
 * the candidate out on the next request. Without a SPEC_DO binding the static
 * config is returned unchanged; if the read fails, no canary target is added.
 */
export async function applyCanaryRefs(config: ShadowConfig, specDo: SpecDoFetcher | null): Promise<ShadowConfig> {
  if (!specDo) return config;
  let live;
  try {
    live = await new DeployRefsClient(specDo).liveRefs('canary');
  } catch (error) {
    live = { ok: false as const, status: 500, error: error instanceof Error ? error.message : String(error) };
  }
  if (!live.ok) {
    console.error('[Shadow] Deploy refs unavailable, no canary targets:', live.error);
    return config;
  }

  const candidatePreviews = new Map(config.candidatePreviews);
  const splits = { ...config.statsig.splits };
  for (const { ref, deployment } of live.data) {
    if (!ref.candidateId || !deployment) continue;
    candidatePreviews.set(ref.candidateId, deployment.url);
    splits[ref.candidateId] = normalizeTrafficSplitConfig({
      canaryPercentage: deployment.trafficPercentage,
      holdoutPercentage: deployment.holdoutPercentage,
      baselinePercentage: 0,
    });
  }
  return { ...config, candidatePreviews, statsig: { ...config.statsig, splits } };
}

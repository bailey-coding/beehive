---
category: integration
status: active
audience: human,agent
tags:
  - statsig
  - metrics
---

# Statsig Integration for Beehive Platform

> **Document Status:** Draft | **Version:** 1.0 | **Last Updated:** 2026-10-13 | **Author:** Vibe Code Agent
>
> **Task:** Investigate Statsig integration | **Spec:** Competition | **Confidence:** 1.0

---

## Executive Summary

This document provides a comprehensive analysis of how **Statsig** should be integrated with the **Beehive Platform**, specifically focusing on:

1. **Shadow Router** - For traffic splitting and classification
2. **Promotion Train** - For canary deployments and SLO-based decisions
3. **Architecture alignment** with the Oracle Ladder pattern

**Key Finding:** The current implementation has a **custom traffic splitting implementation** that mimics Statsig's functionality but does **NOT use the actual Statsig SDK**. The STATSIG_SERVER_SECRET in `.env` is present but unused. This is a **gap that needs addressing** for production deployment.

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Statsig Overview](#2-statsig-overview)
3. [Integration Architecture](#3-integration-architecture)
4. [Shadow Router Integration](#4-shadow-router-integration)
5. [Promotion Train Integration](#5-promotion-train-integration)
6. [Implementation Roadmap](#6-implementation-roadmap)
7. [Configuration Management](#7-configuration-management)
8. [Metrics and Monitoring](#8-metrics-and-monitoring)
9. [Security Considerations](#9-security-considerations)
10. [Testing Strategy](#10-testing-strategy)
11. [Appendices](#11-appendices)

---

## 1. Current State Analysis

### 1.1 Existing Implementation

The codebase currently implements a **custom traffic splitting solution** in the Shadow Router:

- **File:** `workers/shadow-router/index.ts`
- **Config:** `workers/shadow-router/config.ts`
- **Types:** `workers/shadow-router/types.ts`

**Key Components:**

```typescript
// Custom Statsig-like configuration
interface TrafficSplitConfig {
  canaryPercentage: number;    // 0-100
  holdoutPercentage: number;   // 0-100
  baselinePercentage: number;  // Calculated: 100 - canary - holdout
}

// Classification function (custom, not using Statsig SDK)
function classifyRequest(
  request: Request,
  config: ShadowConfig,
  candidateId?: string
): RequestClassification {
  // Uses deterministic hashing instead of Statsig's SDK
  const randomValue = Math.abs(hash) % 10000 / 10000;
  // Classifies based on percentages
  // ...
}
```

**Current Traffic Flow:**
```
Request → Shadow Router → classifyRequest() → [canary/holdout/baseline/shadow] → Fan-out to candidates
```

### 1.2 What's Missing

1. **No Statsig SDK integration** - Custom implementation exists but doesn't use `STATSIG_SERVER_SECRET`
2. **No feature flags** - Only traffic splitting is implemented
3. **No experimentation framework** - No A/B testing or dynamic configuration
4. **No Statsig Dashboard integration** - Metrics are written to Analytics Engine, not Statsig
5. **No remote configuration** - All configs are hardcoded or in wrangler.toml

### 1.3 Statsig credential status

- The server SDK used on Workers (`statsig-node-lite`) authenticates with a **server secret key** (`secret-...`), not a client SDK key (`client-...`).
- A client key exists in the gitignored `.env` as `STATSIG_CLIENT_TOKEN`, but it is unused and is the wrong credential type for a Worker. Do not copy it into code, docs, or `wrangler.toml`.
- Provision the server secret as a Workers secret (`wrangler secret put STATSIG_SERVER_SECRET`) and in `.dev.vars` for local dev. Never commit either value.
- No worker currently reads either credential, and none is configured in any `wrangler.toml`.

---

## 2. Statsig Overview

### 2.1 Statsig Core Capabilities

Statsig provides four main services relevant to Beehive:

| Capability | Description | Relevance to Beehive |
|------------|-------------|---------------------|
| **Feature Flags** | Remote feature toggles | Enable/disable candidate deployments |
| **Experimentation** | A/B testing framework | Compare candidate vs baseline |
| **Feature Gates** | Percentage-based rollouts | Traffic splitting for canary |
| **Metrics** | Custom metrics & dashboards | SLO monitoring |
| **Autosuggest** | AI-powered insights | Optional enhancement |

### 2.2 Statsig SDKs

**For Cloudflare Workers (ES Modules):** use the server-side edge SDK, `statsig-node-lite`.
`statsig-js` is the browser client SDK (expects `window`/`localStorage`, uses a client key) and is **not** suitable for Workers.

```bash
npm install statsig-node-lite
```

**Compatibility:** ES Modules, designed for edge runtimes
**Credential:** server secret key (`STATSIG_SERVER_SECRET`), kept as a Workers secret
**Evaluation model:** server SDK; every check takes an explicit `StatsigUser` and is `async`
**Flush:** call `Statsig.flush()` inside `ctx.waitUntil()` so queued exposure/log events are sent before the isolate is torn down

### 2.3 Statsig Concepts Map to Beehive

| Statsig Concept | Beehive Equivalent | Usage |
|----------------|-------------------|-------|
| Feature Gate | Traffic Split Config | Canary/holdout/baseline percentages |
| Experiment | Trial (head-to-head) | Candidate comparison |
| User | Request | Classification by request attributes |
| Group | Candidate/Spec | Traffic grouping |
| Metric | SLO | Latency, error rate |

---

## 3. Integration Architecture

### 3.1 Oracle Ladder Alignment

The Beehive **Oracle Ladder** (from AGENTS.md):

| Rung | Traffic | Oracle | Failure Action |
|------|---------|--------|----------------|
| Pre-merge | none | tests, property/fuzz, spec conformance | never board the train |
| **Shadow** | **mirrored, discarded** | **Scientist diff vs spec's declared delta surface** | **hold, iterate** |
| Train | projection slice | combined-candidate conformance | drop car, re-project |
| **Canary** | **small % live** | **SLOs via Statsig + Analytics Engine** | **auto-rollback (ref op)** |
| Full | 100% | drift, holdouts | alarm, bisect by diff |

**Statsig integrates at two critical rungs:**

1. **Shadow** - Traffic classification for mirroring
2. **Canary** - Traffic splitting and SLO monitoring

### 3.2 Recommended Integration Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                         Beehive with Statsig                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│  │  Edge Router  │    │ Gate Workflow│    │ Sandbox      │     │
│  │  (beehive)    │    │              │    │ Runner       │     │
│  └──────┬───────┘    └──────────────┘    └──────────────┘     │
│         │                                                            │
│         ▼                                                            │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Shadow Router Worker                        │  │
│  │  ┌─────────────────────────────────────────────────────────┐│  │
│  │  │  Statsig SDK:                                      ││  │
│  │  │  - Feature Gates (traffic splitting)       ││  │
│  │  │  - Classification (canary/holdout/baseline) ││  │
│  │  │  - Remote Config (per-candidate splits)    ││  │
│  │  └─────────────────────────────────────────────────────────┘│  │
│  │              ┌───────────────────┐  ┌──────────────────┐   │  │
│  │              │ Fan-out to        │  │ Trigger          │   │  │
│  │              │ Candidates        │  │ Scientist Queue  │   │  │
│  │              └───────────────────┘  └──────────────────┘   │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Canary Worker                              │  │
│  │  ┌─────────────────────────────────────────────────────────┐│  │
│  │  │  Statsig SDK:                                      ││  │
│  │  │  - Metrics (SLO tracking)         ││  │
│  │  │  - Auto-rollback triggers         ││  │
│  │  │  - Feature flags (enable/disable) ││  │
│  │  └─────────────────────────────────────────────────────────┘│  │
│  │  ┌─────────────────────────────────────────────────────────┐│  │
│  │  │  Analytics Engine:                                 ││  │
│  │  │  - SLO metrics (latency, errors)  ││  │
│  │  │  - Rollback events                ││  │
│  │  └─────────────────────────────────────────────────────────┘│  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Promotion Worker                            │  │
│  │  - Uses Statsig Metrics for decision making                    │  │
│  │  - Checks SLO compliance before promotion                       │  │
│  │  - Reads Statsig Feature Gates for promotion readiness          │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Integration Decision Matrix

| Component | Use Statsig SDK? | Use Custom? | Recommendation |
|-----------|----------------|-------------|----------------|
| Shadow Router - Traffic Splitting | ✅ Yes | ❌ No | Use Statsig Feature Gates |
| Shadow Router - Classification | ✅ Yes | ❌ No | Use Statsig SDK |
| Canary Worker - SLO Monitoring | ⚠️ Partial | ✅ Yes | Hybrid: Statsig Metrics + AE |
| Canary Worker - Auto-rollback | ⚠️ Partial | ✅ Yes | Use Statsig Conditions |
| Promotion Worker - Decisions | ✅ Yes | ⚠️ Partial | Use Statsig Experiments |
| Promotion Worker - Analytics | ❌ No | ✅ Yes | Keep Analytics Engine |

---

## 4. Shadow Router Integration

### 4.1 Current Implementation Analysis

The current Shadow Router (`workers/shadow-router/index.ts`) implements:

1. **Traffic Classification** - Custom deterministic hashing
2. **Traffic Splitting** - Custom percentage-based routing
3. **Fan-out Logic** - Send to candidates based on classification
4. **Metrics** - Write to Analytics Engine

**Problems with Current Approach:**

1. **No Remote Configuration** - All splits are hardcoded or require redeployment
2. **No Dynamic Adjustment** - Cannot change traffic percentages without code changes
3. **No Statsig Integration** - Missing feature flag capabilities
4. **No User Targeting** - Cannot classify based on user attributes
5. **No Experiment Tracking** - No built-in A/B test tracking

### 4.2 Recommended Statsig Integration

#### 4.2.1 SDK Initialization

```typescript
// workers/shared/statsig.ts
import Statsig from 'statsig-node-lite';

let initPromise: Promise<void> | null = null;

/** Initialize once per isolate; callers must still handle failure (fail-closed defaults). */
export function ensureStatsig(env: { STATSIG_SERVER_SECRET?: string; STATSIG_ENVIRONMENT?: string }): Promise<void> {
  if (!env.STATSIG_SERVER_SECRET) {
    return Promise.reject(new Error('STATSIG_SERVER_SECRET not configured'));
  }
  if (!initPromise) {
    initPromise = Statsig.initialize(env.STATSIG_SERVER_SECRET, {
      environment: { tier: env.STATSIG_ENVIRONMENT || 'production' },
    }).then(() => undefined);
    // Allow retry on the next request if init fails
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}
```

#### 4.2.2 Feature Gate Configuration

**Statsig Console Setup:**

1. Create a **Feature Gate** called `beehive_shadow_traffic`
2. Configure with **three groups**:
   - `canary` - X% of traffic
   - `holdout` - Y% of traffic  
   - `baseline` - Z% of traffic (100 - X - Y)

3. Set **Evaluation Rules**:
   - Use `userID` (derived via `buildStatsigUser`, below) as the ID type
   - Add custom properties for candidate classification

**Code Integration:**

```typescript
// workers/shadow-router/statsig.ts
import Statsig from 'statsig-node-lite';
import type { RequestClassification } from './types';
import { buildStatsigUser } from '../shared/statsig';

/**
 * Classify request using Statsig Feature Gates.
 * The decision is deterministic per (candidate, request key): the same
 * user ID always lands in the same bucket, so retries classify identically.
 */
export async function classifyRequestWithStatsig(
  request: Request,
  candidateId: string,
  fallback: () => RequestClassification,
): Promise<RequestClassification> {
  try {
    const user = await buildStatsigUser(request, candidateId);
    const gate = await Statsig.getFeatureGate(user, 'beehive_shadow_traffic');

    if (!gate.value) {
      // Gate off or not found - fall back to the custom splitter
      return fallback();
    }

    // Group is identified by the rule that matched (rule IDs configured in the console)
    switch (gate.getRuleID()) {
      case 'canary':
        return { type: 'canary', candidateId, weight: 1 };
      case 'holdout':
        return { type: 'holdout', weight: 1 };
      case 'baseline':
        return { type: 'baseline', weight: 1 };
      default:
        return fallback();
    }
  } catch (error) {
    console.error('[Statsig] classification failed, using fallback:', error);
    return fallback();
  }
}
```

**Stable ID (required):** Statsig buckets on `user.userID`. It must be a *deterministic* function
of the request, never `crypto.randomUUID()` — a random ID re-rolls the bucket on every call, so
retries flip groups and the configured percentages are only met by luck. Derive it from
`x-request-id` when present, otherwise from method + path (+ candidate ID):

```typescript
// workers/shared/statsig.ts
import type { StatsigUser } from 'statsig-node-lite';

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildStatsigUser(request: Request, candidateId?: string): Promise<StatsigUser> {
  const url = new URL(request.url);
  const requestKey = request.headers.get('x-request-id') ?? `${request.method}:${url.pathname}`;
  const userID = await sha256Hex(`${candidateId ?? 'none'}:${requestKey}`);
  return { userID, customIDs: candidateId ? { candidateId } : undefined };
}
```

#### 4.2.3 Per-Candidate Configuration

**Statsig Dynamic Config:**

```typescript
// Define a Dynamic Config for per-candidate splits
interface CandidateTrafficConfig {
  canaryPercentage: number;
  holdoutPercentage: number;
  baselinePercentage: number;
}

// In Statsig Console:
// 1. Create Dynamic Config: beehive_candidate_traffic
// 2. Add JSON schema matching CandidateTrafficConfig
// 3. Create rules for each candidate

// In Code:
export async function getCandidateTrafficConfig(
  request: Request,
  candidateId: string
): Promise<CandidateTrafficConfig> {
  const user = await buildStatsigUser(request, candidateId);
  const config = await Statsig.getConfig(user, 'beehive_candidate_traffic');
  
  // Get candidate-specific config
  const candidateConfig = config.get(
    `candidate_${candidateId}`,
    DEFAULT_STATSIG_CONFIG
  );
  
  return normalizeTrafficSplitConfig(candidateConfig);
}
```

#### 4.2.4 Wrangler Configuration

```toml
# workers/shadow-router/wrangler.toml
[vars]
STATSIG_SERVER_SECRET = "@STATSIG_SERVER_SECRET"
STATSIG_ENVIRONMENT = "production"
```

#### 4.2.5 Updated Shadow Router Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Shadow Router with Statsig                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Request Arrives                                                    │
│       │                                                            │
│       ▼                                                            │
│  ┌─────────────────┐                                              │
│  │ Initialize       │                                              │
│  │ Statsig SDK      │                                              │
│  └────────┬────────┘                                              │
│            │                                                         │
│            ▼                                                         │
│  ┌─────────────────┐                                              │
│  │ Get Dynamic     │                                              │
│  │ Config          │◄──────────────────────────────────────────┐  │
│  │ (per-candidate) │                                     │         │
│  └────────┬────────┘                                     │         │
│            │                                              │         │
│            ▼                                              │         │
│  ┌─────────────────┐                                    │         │
│  │ Classify        │◄───────────────────────────┘         │
│  │ Request         │                                        │
│  │ (Feature Gate)  │                                        │
│  └────────┬────────┘                                        │
│            │                                                │
│   ┌────────▼────────┐    ┌─────────────────┐              │
│   │ canary/holdout/  │    │ Fan-out Logic    │              │
│   │ baseline/shadow │───►│ (filtered by     │              │
│   └─────────────────┘    │ classification)  │              │
│                         └────────┬────────────┘              │
│                                          │                      │
│                                          ▼                      │
│                        ┌─────────────────────────┐          │
│                        │ Send to Candidates       │          │
│                        │ (canary + shadow only)   │          │
│                        └────────┬────────────────┘          │
│                                 │                           │
│                                 ▼                           │
│                        ┌─────────────────────────┐          │
│                        │ Write Metrics to         │          │
│                        │ Analytics Engine         │          │
│                        │ + Statsig (optional)     │          │
│                        └─────────────────────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 API Endpoints for Statsig Management

Add these endpoints to the Shadow Router:

```typescript
// GET /statsig/status
// Returns: { enabled: boolean, initialized: boolean, version: string }

// GET /statsig/gates
// Returns: List of all feature gates with current allocations

// POST /statsig/gates/{name}/override
// Temporarily override a gate for testing (dev only)

// GET /statsig/configs
// Returns: List of all dynamic configs

// GET /statsig/configs/{name}
// Returns: Current value of a specific config
```

---

## 5. Promotion Train Integration

### 5.1 Current Implementation Analysis

The Promotion Worker (`workers/promotion-worker/promotion.ts`) implements:

1. **Tournament Mode** - Head-to-head comparison of candidates
2. **Merge Train Mode** - Sequential promotion with projection
3. **Rung System** - pre-merge → shadow → train → canary → full
4. **State Management** - Track promotion progress

**Current Metrics:**
- Uses Analytics Engine for promotion events
- No SLO checking integrated
- No auto-rollback based on SLO violations

### 5.2 Statsig Integration Points

#### 5.2.1 SLO Monitoring with Statsig Metrics

**Create Statsig Metrics:**

1. **Latency P95** - `beehive_canary_latency_p95`
   - Type: Timestamped Number
   - Unit: milliseconds
   - Aggregation: p95

2. **Error Rate** - `beehive_canary_error_rate`
   - Type: Fraction
   - Numerator: error_count
   - Denominator: request_count

3. **Request Count** - `beehive_canary_request_count`
   - Type: Counter

**Code Integration:**

```typescript
// workers/canary-worker/slo.ts
import Statsig from 'statsig-node-lite';

export class SLOMonitor {
  private sloConfig: {
    latencyP95: number;  // ms
    errorRate: number;   // 0-1
  };
  
  constructor(env: any) {
    this.sloConfig = {
      latencyP95: parseInt(env.CANARY_SLO_LATENCY_P95 || '1000'),
      errorRate: parseFloat(env.CANARY_SLO_ERROR_RATE || '0.01'),
    };
  }
  
  /**
   * Check if candidate is meeting SLOs
   */
  async checkSLO(candidateId: string): Promise<{
    healthy: boolean;
    violations: string[];
    metrics: {
      latencyP95: number;
      errorRate: number;
      requestCount: number;
    };
  }> {
    // The server SDK has no metric-query API. Read the SLO inputs from
    // Analytics Engine (the live source of truth) and emit them to Statsig
    // as events so Statsig dashboards/alerts see the same numbers.
    const result = await this.queryAnalyticsEngine(candidateId); // { latencyP95, errorRate, requestCount }
    const violations: string[] = [];
    Statsig.logEvent({ userID: 'beehive-canary-worker' }, 'beehive_canary_metrics', result.latencyP95, {
      candidateId,
      errorRate: String(result.errorRate),
      requestCount: String(result.requestCount),
    });
    
    if (result.latencyP95 > this.sloConfig.latencyP95) {
      violations.push(`latency_p95: ${result.latencyP95}ms > ${this.sloConfig.latencyP95}ms`);
    }
    
    if (result.errorRate > this.sloConfig.errorRate) {
      violations.push(`error_rate: ${result.errorRate} > ${this.sloConfig.errorRate}`);
    }
    
    return {
      healthy: violations.length === 0,
      violations,
      metrics: result,
    };
  }
}
```

#### 5.2.2 Auto-Rollback with Statsig Conditions

**Statsig Console Setup:**

1. Create **Metrics**:
   - `beehive_latency_p95` (number)
   - `beehive_error_rate` (fraction)

2. Create **Conditions**:
   - `latency_violation`: `beehive_latency_p95 > 1000` for 5 minutes
   - `error_rate_violation`: `beehive_error_rate > 0.01` for 5 minutes

3. Create **Alerts** that trigger webhooks to Canary Worker

**Code Integration:**

```typescript
// workers/canary-worker/rollback.ts
import Statsig from 'statsig-node-lite';

export class RollbackManager {
  constructor(private env: any) {}
  
  /**
   * Check if auto-rollback should be triggered
   */
  async checkAutoRollback(candidateId: string): Promise<boolean> {
    // Rollback can be disabled remotely via a gate (fail-closed default: false)
    const enabled = await safeCheckGate({ userID: 'beehive-canary-worker' }, 'beehive_auto_rollback_enabled', false);
    if (!enabled) return false;

    // SLO evaluation stays local (SLOMonitor over Analytics Engine); Statsig
    // alerts reach this worker as webhooks, not via an SDK query.
    const slo = await new SLOMonitor(this.env).checkSLO(candidateId);
    const shouldRollback = !slo.healthy;
    
    if (shouldRollback) {
      await this.triggerRollback({
        candidateId,
        reason: 'slo_violation',
        metrics: slo.metrics,
      });
    }
    
    return shouldRollback;
  }
}
```

#### 5.2.3 Feature Flags for Promotion Control

**Statsig Console Setup:**

1. Create **Feature Flags**:
   - `beehive_promotion_enabled` - Global kill switch
   - `beehive_canary_enabled` - Enable canary deployments
   - `beehive_auto_rollback_enabled` - Enable auto-rollback

**Code Integration:**

```typescript
// workers/promotion-worker/promotion.ts
// Org-level gates have no per-request subject: use one fixed, deterministic user.
const PROMOTION_USER = { userID: 'beehive-promotion-worker' };

export class PromotionWorker {
  // ...
  
  private async isPromotionEnabled(): Promise<boolean> {
    return Statsig.checkGate(PROMOTION_USER, 'beehive_promotion_enabled');
  }
  
  private async isCanaryEnabled(): Promise<boolean> {
    return Statsig.checkGate(PROMOTION_USER, 'beehive_canary_enabled');
  }
  
  private async isAutoRollbackEnabled(): Promise<boolean> {
    return Statsig.checkGate(PROMOTION_USER, 'beehive_auto_rollback_enabled');
  }
  
  async promoteCandidate(request: PromotionRequest): Promise<Response> {
    // Check if promotion is enabled
    if (!(await this.isPromotionEnabled())) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Promotion is currently disabled',
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // Check if canary is enabled for this promotion
    if (request.toRung === 'canary' && !(await this.isCanaryEnabled())) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Canary deployments are currently disabled',
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    // ... rest of promotion logic
  }
}
```

#### 5.2.4 Wrangler Configuration

```toml
# workers/promotion-worker/wrangler.toml
[vars]
STATSIG_SERVER_SECRET = "@STATSIG_SERVER_SECRET"
STATSIG_ENVIRONMENT = "production"

# Existing configs...
```

### 5.3 Updated Promotion Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Promotion with Statsig                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Candidate Passes Pre-merge Gates                                   │
│       │                                                            │
│       ▼                                                            │
│  ┌─────────────────┐                                              │
│  │ Check Feature   │                                              │
│  │ Gate:           │                                              │
│  │ beehive_        │                                              │
│  │ promotion_      │                                              │
│  │ enabled?        │                                              │
│  └────────┬────────┘                                              │
│            │                                                         │
│            ▼                                                         │
│  ┌─────────────────┐                                              │
│  │ Promotion       │                                              │
│  │ Worker          │                                              │
│  │ - Check SLOs    │                                              │
│  │ - Tournament    │                                              │
│  │   or Merge Train│                                              │
│  └────────┬────────┘                                              │
│            │                                                         │
│            ▼                                                         │
│  ┌─────────────────┐                                              │
│  │ Canary          │                                              │
│  │ Worker          │                                              │
│  │ - Deploy        │─────────────────────────────────┐           │
│  │ - Monitor SLOs  │                                 │           │
│  │ - Check Statsig │                                 │           │
│  └────────┬────────┘                                 │           │
│            │                                         │           │
│            ▼                                         ▼           │
│  ┌─────────────────┐                      ┌─────────────────┐        │
│  │ Statsig         │                      │ Analytics       │        │
│  │ Metrics        │                      │ Engine          │        │
│  │ - SLO tracking  │                      │ - Raw metrics    │        │
│  │ - Conditions    │                      │ - Long-term     │        │
│  └────────┬────────┘                      │   storage        │        │
│            │                                       └─────────────────┘        │
│            ▼                                                                │
│  ┌─────────────────┐                                                │
│  │ Check Auto-     │                                                │
│  │ Rollback       │                                                │
│  │ Conditions     │                                                │
│  └────────┬────────┘                                                │
│            │                                                         │
│   ┌────────▼────────┐                                              │
│   │ Violation?     │                                              │
│   │                │                                              │
│   └────────┬────────┘                                              │
│            │                                                         │
│      ┌─────▼─────┐                                                   │
│      │ Rollback │◄──────────────────────────────────────────┘     │
│      │ Candidate│                                                   │
│      └───────────┘                                                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Implementation Roadmap

### 6.1 Phase 1: SDK Integration (Priority: HIGH)

**Goal:** Add Statsig SDK to the project and initialize it in workers

**Tasks:**

1. **Add Statsig dependency**
   ```bash
   npm install statsig-node-lite
   ```

2. **Create Statsig utility module**
   - `workers/shared/statsig.ts`
   - SDK initialization
   - Error handling
   - Mock for local development

3. **Add STATSIG_SERVER_SECRET to wrangler.toml files**
   - Shadow Router
   - Canary Worker
   - Promotion Worker

4. **Add environment variable to .dev.vars** (for local dev)

**Estimated Time:** 1-2 hours

**Success Criteria:**
- Statsig SDK initializes without errors
- Feature gates can be checked
- Metrics can be written (optional for Phase 1)

### 6.2 Phase 2: Shadow Router Statsig Integration (Priority: HIGH)

**Goal:** Replace custom traffic splitting with Statsig Feature Gates

**Tasks:**

1. **Create Statsig Feature Gates**
   - `beehive_shadow_traffic` with canary/holdout/baseline groups
   - `beehive_shadow_enabled` (kill switch)

2. **Update classifyRequest function**
   - Use Statsig SDK instead of custom hashing
   - Add fallback to custom implementation

3. **Add Dynamic Config support**
   - Create `beehive_candidate_traffic` config
   - Implement per-candidate split configuration

4. **Add Statsig management endpoints**
   - `/statsig/status`
   - `/statsig/gates`
   - `/statsig/configs`

**Estimated Time:** 2-4 hours

**Success Criteria:**
- Traffic classification uses Statsig
- Per-candidate configuration works
- Custom implementation still available as fallback

### 6.3 Phase 3: Canary Worker Statsig Integration (Priority: MEDIUM)

**Goal:** Add Statsig Metrics and Conditions for SLO monitoring

**Tasks:**

1. **Create Statsig Metrics**
   - Latency P95
   - Error Rate
   - Request Count

2. **Create Statsig Conditions**
   - Latency violation
   - Error rate violation

3. **Update SLOMonitor**
   - Query Statsig for current metrics
   - Check SLO violations using Statsig Conditions

4. **Update RollbackManager**
   - Trigger rollback on Statsig condition violations
   - Add webhook support (future)

**Estimated Time:** 2-3 hours

**Success Criteria:**
- SLOs can be checked via Statsig Metrics
- Conditions trigger correctly
- Auto-rollback works with Statsig

### 6.4 Phase 4: Promotion Worker Statsig Integration (Priority: MEDIUM)

**Goal:** Add feature flags for promotion control

**Tasks:**

1. **Create Statsig Feature Flags**
   - `beehive_promotion_enabled`
   - `beehive_canary_enabled`
   - `beehive_auto_rollback_enabled`

2. **Update PromotionWorker**
   - Check gates before promotion
   - Add gate checks at each rung

3. **Add Statsig Experimentation (Optional)**
   - Create experiments for candidate comparisons
   - Track promotion outcomes

**Estimated Time:** 1-2 hours

**Success Criteria:**
- Promotions can be enabled/disabled via Statsig
- Canary deployments respect feature flags
- Promotion flow respects Statsig gates

### 6.5 Phase 5: Testing & Validation (Priority: HIGH)

**Tasks:**

1. **Unit Tests**
   - Mock Statsig SDK
   - Test classification logic
   - Test fallback behavior

2. **Integration Tests**
   - Test with real Statsig (staging environment)
   - Verify metrics flow
   - Verify conditions trigger correctly

3. **E2E Tests**
   - Update existing M3 tests to use Statsig
   - Add Statsig-specific test cases

**Estimated Time:** 2-4 hours

**Success Criteria:**
- All tests pass
- Fallback behavior works without Statsig
- Statsig integration works in staging

---

## 7. Configuration Management

### 7.1 Token Management

**Production:**
```bash
# Set on each worker
wrangler secret put STATSIG_SERVER_SECRET -n beehive-shadow-router
wrangler secret put STATSIG_SERVER_SECRET -n beehive-canary-worker
wrangler secret put STATSIG_SERVER_SECRET -n beehive-promotion-worker
```

**Local Development:**
```bash
# .dev.vars (gitignored)
STATSIG_SERVER_SECRET=<your-statsig-server-secret-key>
STATSIG_ENVIRONMENT=development
```

### 7.2 Environment Configuration

```toml
# All workers that use Statsig:
[vars]
STATSIG_ENVIRONMENT = "production"
# STATSIG_SERVER_SECRET is a secret: set with `wrangler secret put`, never in [vars].
```

### 7.3 Feature Gate Configuration

**Statsig Console Setup:**

| Gate Name | Type | Default Value | Description |
|-----------|------|---------------|-------------|
| `beehive_shadow_enabled` | Feature Gate | ON | Master switch for shadow traffic |
| `beehive_shadow_traffic` | Feature Gate | OFF | Traffic splitting (canary/holdout/baseline) |
| `beehive_canary_enabled` | Feature Gate | ON | Enable canary deployments |
| `beehive_auto_rollback_enabled` | Feature Gate | ON | Enable auto-rollback on SLO violations |
| `beehive_promotion_enabled` | Feature Gate | ON | Master switch for promotions |

### 7.4 Dynamic Config Configuration

**Statsig Console Setup:**

| Config Name | Type | Schema | Description |
|-------------|------|--------|-------------|
| `beehive_candidate_traffic` | Dynamic Config | `{ canary: number, holdout: number, baseline: number }` | Per-candidate traffic splits |
| `beehive_slo_thresholds` | Dynamic Config | `{ latencyP95: number, errorRate: number }` | SLO thresholds by candidate |

### 7.5 Statsig SDK Configuration

See `ensureStatsig` in 4.2.1 and `buildStatsigUser` in 4.2.2 (both in `workers/shared/statsig.ts`).
Flush is per-request on Workers:

```typescript
ctx.waitUntil(Statsig.flush());
```

---

## 8. Metrics and Monitoring

### 8.1 Statsig Metrics Strategy

**Primary Metrics (Statsig):**

| Metric Name | Type | Description | Aggregation |
|-------------|------|-------------|-------------|
| `beehive_shadow_requests` | Counter | Total shadow requests | Sum |
| `beehive_shadow_canary` | Counter | Canary traffic count | Sum |
| `beehive_shadow_holdout` | Counter | Holdout traffic count | Sum |
| `beehive_shadow_baseline` | Counter | Baseline traffic count | Sum |
| `beehive_canary_latency_p95` | Number | P95 latency | p95 |
| `beehive_canary_error_rate` | Fraction | Error rate | Mean |
| `beehive_canary_request_count` | Counter | Total requests | Sum |
| `beehive_promotion_attempts` | Counter | Promotion attempts | Sum |
| `beehive_promotion_success` | Counter | Successful promotions | Sum |
| `beehive_promotion_failure` | Counter | Failed promotions | Sum |
| `beehive_rollback_count` | Counter | Rollback events | Sum |

**Secondary Metrics (Analytics Engine):**
- Detailed Scientist comparison metrics
- Queue processing metrics
- Gate workflow execution metrics
- Raw request/response data (sampled)

### 8.2 Metrics Collection Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                    Metrics Collection Architecture                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                      Statsig Metrics                          │  │
│  │  - Traffic classification counts                            │  │
│  │  - SLO metrics (latency, error rate)                           │  │
│  │  - Promotion events                                           │  │
│  │  - Rollback events                                            │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                   Analytics Engine                             │  │
│  │  - Detailed Scientist comparisons                             │  │
│  │  - Request/response bodies (sampled)                          │  │
│  │  - Queue processing metrics                                   │  │
│  │  - Gate workflow execution metrics                            │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                       │
│                              ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Cloudflare Logs                             │  │
│  │  - Debug logs (info, warn, error)                             │  │
│  │  - Full request tracing                                        │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 8.3 Metrics Implementation

```typescript
// workers/shared/statsig-metrics.ts
import Statsig from 'statsig-node-lite';

export class StatsigMetrics {
  /**
   * Log shadow traffic classification
   */
  static logShadowClassification(
    classification: 'canary' | 'holdout' | 'baseline' | 'shadow',
    candidateId: string,
    specId: string
  ): void {
    // Metadata values are strings; user ID is the candidate (deterministic, not random)
    Statsig.logEvent(
      { userID: candidateId },
      'beehive_shadow_classification',
      classification,
      { classification, candidateId, specId }
    );
  }
  
  /**
   * Log canary SLO metrics
   */
  static logCanaryMetrics(
    candidateId: string,
    specId: string,
    metrics: {
      latencyP95: number;
      errorRate: number;
      requestCount: number;
    }
  ): void {
    Statsig.logEvent(
      { userID: `${candidateId}` },
      'beehive_canary_metrics',
      null,
      {
        candidateId,
        specId,
        latencyP95: String(metrics.latencyP95),
        errorRate: String(metrics.errorRate),
      }
    );
  }
  
  /**
   * Log promotion event
   */
  static logPromotion(
    candidateId: string,
    specId: string,
    fromRung: string,
    toRung: string,
    success: boolean,
    error?: string
  ): void {
    Statsig.logEvent(
      { userID: `${candidateId}` },
      `beehive_promotion_${success ? 'success' : 'failure'}`,
      null,
      {
        candidateId,
        specId,
        fromRung,
        toRung,
        error: error || '',
      }
    );
  }
  
  /**
   * Log rollback event
   */
  static logRollback(
    candidateId: string,
    specId: string,
    reason: string,
    metrics: {
      latencyP95?: number;
      errorRate?: number;
    }
  ): void {
    Statsig.logEvent(
      { userID: candidateId },
      'beehive_rollback',
      reason,
      {
        candidateId,
        specId,
        reason,
        latencyP95: String(metrics.latencyP95 ?? ''),
        errorRate: String(metrics.errorRate ?? ''),
      }
    );
  }
}
```

---

## 9. Security Considerations

### 9.1 Token Security

**STATSIG_SERVER_SECRET** is a **server-side token** that should:

- ✅ Be stored in Cloudflare Workers Secrets
- ✅ NOT be exposed to client-side code
- ✅ Have appropriate scopes (read/write for metrics, gates, configs)
- ✅ Be rotated periodically (every 90 days)
- ❌ NOT be committed to Git (already in .gitignore via .env)

**Current Status:**
```
```

### 9.2 Token Scopes

**Required Statsig Token Scopes:**

| Scope | Required For | Description |
|-------|--------------|-------------|
| `read:feature_gates` | All workers | Read feature gate values |
| `read:dynamic_configs` | Shadow Router, Promotion Worker | Read dynamic configurations |
| `read:metrics` | Canary Worker | Read metrics for SLO checking |
| `write:metrics` | All workers | Write custom metrics |
| `write:feature_gates` | Dev only | Update feature gates (via API) |

**Recommended Token:**
- **Server Secret Key** (`secret-...`), never a client key
- **Scopes:** Read all, Write metrics only
- **Environment:** Production + Development

### 9.3 Network Security

**Statsig API:**
- **Protocol:** HTTPS only
- **Endpoint:** `https://api.statsig.com/v1`
- **CORS:** Not applicable (server-side)
- **Rate Limiting:** Statsig applies rate limits

**Cloudflare Workers:**
- All outbound requests go through Cloudflare's network
- No additional security needed beyond HTTPS
- Workers environment is isolated

### 9.4 Fail-Closed Behavior

**Statsig Integration Principle:** Always fail-closed

```typescript
// Pattern for safe Statsig usage
async function safeCheckGate(user: StatsigUser, gateName: string, defaultValue: boolean): Promise<boolean> {
  try {
    return await Statsig.checkGate(user, gateName);
  } catch (error) {
    console.error(`[Statsig] Error checking gate ${gateName}:`, error);
    // Fail closed - use default that's safe
    return defaultValue;
  }
}

async function safeGetConfig(user: StatsigUser, configName: string, defaultValue: any): Promise<any> {
  try {
    const config = await Statsig.getConfig(user, configName);
    return config ? config.get() : defaultValue;
  } catch (error) {
    console.error(`[Statsig] Error getting config ${configName}:`, error);
    return defaultValue;
  }
}
```

**Default Values (Fail-Closed):**

| Gate/Config | Safe Default | Reasoning |
|-------------|--------------|-----------|
| `beehive_shadow_enabled` | `false` | Disable shadow if Statsig fails |
| `beehive_shadow_traffic` | Use custom implementation | Fallback to existing behavior |
| `beehive_canary_enabled` | `false` | Disable canary if Statsig fails |
| `beehive_promotion_enabled` | `false` | Disable promotions if Statsig fails |
| `beehive_auto_rollback_enabled` | `false` | Disable auto-rollback if Statsig fails |
| Traffic split config | Custom defaults | Use hardcoded conservative values |

---

## 10. Testing Strategy

### 10.1 Unit Tests

**Mock Statsig SDK:**

```typescript
// workers/shared/statsig-mock.ts
// Mock Statsig for testing
export const MockStatsig = {
  gates: {} as Record<string, boolean | string>,
  configs: {} as Record<string, Record<string, any>>,
  metrics: [] as Array<{ name: string; value: number; tags: Record<string, string> }>,
  
  initialize: vi.fn(),
  shutdown: vi.fn(),
  checkGate: vi.fn(async (_user: unknown, gateName: string) => !!MockStatsig.gates[gateName]),
  getFeatureGate: vi.fn(async (_user: unknown, gateName: string) => ({
    value: !!MockStatsig.gates[gateName],
    getRuleID: () => (typeof MockStatsig.gates[gateName] === 'string' ? MockStatsig.gates[gateName] : 'default'),
  })),
  getConfig: vi.fn(async (_user: unknown, configName: string) => ({
    get: (key?: string) => key ? MockStatsig.configs[configName]?.[key] : MockStatsig.configs[configName],
  })),
  logEvent: vi.fn((_user: unknown, eventName: string, _value: unknown, tags: any) => {
    MockStatsig.metrics.push({ name: eventName, value: 1, tags });
  }),
  flush: vi.fn(),
  
  // Helper to reset mock
  reset: () => {
    MockStatsig.gates = {};
    MockStatsig.configs = {};
    MockStatsig.metrics = [];
    vi.clearAllMocks();
  },
  
  // Helper to set gate value
  setGate: (gateName: string, value: boolean | string) => {
    MockStatsig.gates[gateName] = value;
  },
  
  // Helper to set config value
  setConfig: (configName: string, value: Record<string, any>) => {
    MockStatsig.configs[configName] = value;
  },
};

// Use in tests:
vi.mock('statsig-node-lite', () => MockStatsig);
```

**Test Cases:**

```typescript
// workers/shadow-router/tests/statsig.test.ts
describe('Statsig Integration', () => {
  beforeEach(() => {
    MockStatsig.reset();
  });
  
  describe('Feature Gates', () => {
    it('should classify as canary when gate allocation is canary', () => {
      MockStatsig.setGate('beehive_shadow_traffic', 'canary');
      
      const classification = classifyRequestWithStatsig(
        createMockRequest('/test'),
        'candidate-001',
        'spec-001'
      );
      
      expect(classification.type).toBe('canary');
    });
    
    it('should fallback to custom classification when Statsig fails', () => {
      MockStatsig.setGate('beehive_shadow_traffic', false);
      
      const classification = classifyRequestWithStatsig(
        createMockRequest('/test'),
        'candidate-001',
        'spec-001'
      );
      
      // Should use custom implementation
      expect(classification.type).toBeOneOf(['canary', 'holdout', 'baseline', 'shadow']);
    });
  });
  
  describe('Dynamic Configs', () => {
    it('should get per-candidate traffic config', () => {
      MockStatsig.setConfig('beehive_candidate_traffic', {
        candidate_001: { canary: 10, holdout: 10, baseline: 80 },
      });
      
      const config = getCandidateTrafficConfig('candidate-001');
      
      expect(config.canaryPercentage).toBe(10);
      expect(config.holdoutPercentage).toBe(10);
      expect(config.baselinePercentage).toBe(80);
    });
    
    it('should fallback to default when config not found', () => {
      const config = getCandidateTrafficConfig('unknown-candidate');
      
      expect(config).toEqual(DEFAULT_STATSIG_CONFIG);
    });
  });
});
```

### 10.2 Integration Tests

**Test with Local Statsig Server (for development):**

1. Run Statsig locally using Docker
2. Point Statsig SDK to local server
3. Test feature gates, configs, and metrics

**Test Configuration:**

```toml
# wrangler.toml for testing
[vars]
STATSIG_SERVER_SECRET = "test-token"
STATSIG_API_URL = "http://localhost:8000/v1"
STATSIG_ENVIRONMENT = "testing"
```

### 10.3 E2E Tests

**Update existing M3 tests:**

```typescript
// tests/e2e/m3-features.test.ts - Updated with Statsig

// Test Statsig initialization
it('should initialize Statsig SDK in shadow router', async () => {
  const response = await callHandler(
    mockShadowRouterHandler,
    '/statsig/status'
  );
  
  expect(response.status).toBe(200);
  const data = await readJson(response);
  expect(data.initialized).toBe(true);
});

// Test Statsig classification
it('should classify requests using Statsig gates', async () => {
  // Setup mock Statsig
  MockStatsig.setGate('beehive_shadow_traffic', 'canary');
  
  const response = await callHandler(
    mockShadowRouterHandler,
    '/statsig/classify',
    'POST',
    { candidateId: 'candidate-001' }
  );
  
  expect(response.status).toBe(200);
  const data = await readJson(response);
  expect(data.type).toBe('canary');
});
```

---

## 11. Appendices

### 11.1 Appendix A: Statsig SDK Quick Reference

**Basic Usage:**

```typescript
import Statsig from 'statsig-node-lite';

// Initialize once per isolate with the SERVER secret key
await Statsig.initialize(env.STATSIG_SERVER_SECRET, {
  environment: { tier: 'production' },
});

const user = { userID: 'deterministic-id' }; // never a random per-call ID

// Check feature gate
const isEnabled = await Statsig.checkGate(user, 'my_feature');

// Get dynamic config
const config = await Statsig.getConfig(user, 'my_config');
const value = config.get('my_key', 'default');

// Log event
Statsig.logEvent(user, 'my_event', 'value', { tag: 'value' });

// Flush before the isolate exits
ctx.waitUntil(Statsig.flush());
```

### 11.2 Appendix B: Statsig vs Custom Implementation Comparison

| Feature | Statsig SDK | Custom Implementation |
|---------|-------------|----------------------|
| Traffic Splitting | ✅ Dynamic, remote-controlled | ❌ Hardcoded, requires redeploy |
| A/B Testing | ✅ Built-in | ❌ Not available |
| Feature Flags | ✅ Built-in | ❌ Not available |
| Metrics | ✅ Built-in | ❌ Custom implementation needed |
| Dashboards | ✅ Built-in | ❌ Need custom solution |
| Alerts | ✅ Built-in | ❌ Need custom solution |
| Per-user Targeting | ✅ Built-in | ❌ Not available |
| Gradual Rollouts | ✅ Built-in | ❌ Custom implementation |
| Fallback Support | ⚠️ Requires custom code | ✅ Built-in (existing) |
| Cost | ⚠️ Paid service | ✅ Free |
| Vendor Lock-in | ⚠️ Medium | ✅ None |

### 11.3 Appendix C: Migration Checklist

- [ ] Add `statsig-node-lite` dependency to package.json
- [ ] Create `workers/shared/statsig.ts` utility module
- [ ] Create `workers/shared/statsig-mock.ts` for testing
- [ ] Add STATSIG_SERVER_SECRET to all worker wrangler.toml files
- [ ] Update Shadow Router to use Statsig for classification
- [ ] Update Canary Worker to use Statsig for metrics
- [ ] Update Promotion Worker to use Statsig for gates
- [ ] Add Statsig management endpoints to Shadow Router
- [ ] Update unit tests with Statsig mocks
- [ ] Update E2E tests for Statsig integration
- [ ] Create Statsig Console configuration (gates, configs, metrics)
- [ ] Set STATSIG_SERVER_SECRET as Workers secrets
- [ ] Test locally with Statsig
- [ ] Test in staging environment
- [ ] Deploy to production

### 11.4 Appendix D: Error Codes and Recovery

| Error Code | Description | Recovery Action |
|------------|-------------|-----------------|
| `STATSIG_NOT_INITIALIZED` | SDK not initialized | Initialize SDK, use fallback |
| `STATSIG_INVALID_TOKEN` | Invalid server secret key | Check token, use fallback |
| `STATSIG_NETWORK_ERROR` | Network request failed | Retry with exponential backoff, use fallback |
| `STATSIG_RATE_LIMITED` | Rate limit exceeded | Wait and retry, use fallback |
| `STATSIG_CONFIG_NOT_FOUND` | Config/gate not found | Use default value, log warning |
| `STATSIG_SHUTDOWN` | SDK shut down | Reinitialize or use fallback |

### 11.5 Appendix E: References

- [Statsig Documentation](https://docs.statsig.com/)
- [Statsig Node Lite SDK (Workers/edge)](https://www.npmjs.com/package/statsig-node-lite)
- [Statsig Feature Gates](https://docs.statsig.com/feature-gates)
- [Statsig Dynamic Configs](https://docs.statsig.com/dynamic-config)
- [Statsig Metrics](https://docs.statsig.com/metrics)
- [Cloudflare Workers Statsig Integration](https://developers.cloudflare.com/workers/examples/third-party/statsig/)
- [Beehive AGENTS.md](../AGENTS.md)
- [Beehive ARCHITECTURE.md](../ARCHITECTURE.md)

---

## Summary and Recommendations

### Key Findings

1. **Current implementation uses custom traffic splitting** that mimics Statsig but doesn't use the actual Statsig SDK
2. **STATSIG_SERVER_SECRET exists but is unused** in the codebase
3. **Integration is feasible and recommended** for production deployment
4. **Hybrid approach is best** - use Statsig where it adds value, keep custom where appropriate

### Recommendations

| Priority | Action | Rationale |
|----------|--------|-----------|
| HIGH | Add Statsig SDK and initialize in workers | Foundation for all Statsig features |
| HIGH | Integrate Statsig Feature Gates in Shadow Router | Enable dynamic traffic splitting |
| HIGH | Add fallback to custom implementation | Maintain existing behavior if Statsig fails |
| MEDIUM | Add Statsig Metrics in Canary Worker | Enable SLO monitoring with Statsig |
| MEDIUM | Add Statsig Feature Flags in Promotion Worker | Enable remote control of promotions |
| MEDIUM | Update tests with Statsig mocks | Ensure reliability |
| LOW | Add Statsig Experiments for candidate comparison | Optional enhancement |
| LOW | Add Statsig Dashboards for monitoring | Optional enhancement |

### Next Steps

1. **Immediate (Today):**
   - Add `statsig-node-lite` dependency
   - Create Statsig utility module with mock support
   - Add STATSIG_SERVER_SECRET to wrangler.toml files

2. **Short Term (This Week):**
   - Update Shadow Router to use Statsig Feature Gates
   - Add Statsig management endpoints
   - Update unit tests

3. **Medium Term (Next Week):**
   - Update Canary Worker to use Statsig Metrics
   - Update Promotion Worker to use Statsig Feature Flags
   - Update E2E tests

4. **Long Term (Next Sprint):**
   - Add Statsig Experiments
   - Create Statsig Dashboards
   - Monitor and optimize Statsig usage

---

**Document Version:** 1.0  
**Last Updated:** 2026-10-13  
**Author:** Vibe Code Agent  
**Task:** Investigate Statsig integration | **Spec:** Competition | **Confidence:** 1.0

---
category: feature
status: active
audience: human,agent
tags:
  - scientist
  - comparison
---

# Scientist Comparator Design

**Status:** Planning Phase  
**Owner:** @bailey  
**Created:** 2026-10-11  
**Milestone:** M2 - Empirical Oracle  

---

## Overview

The **Scientist Comparator** implements the **Shadow rung** of the oracle ladder. It receives mirrored production traffic responses from candidate Workers and compares them against baseline responses to determine if a candidate's behavior matches the spec's **declared delta surface**.

### Key Concepts

1. **Declared Delta Surface**: A spec defines what changes are *expected* or *allowed* between implementations. This is a JSON schema or path-based declaration that specifies:
   - Which API endpoints can have behavioral differences
   - What response fields can change
   - What response fields must remain identical
   - What status code ranges are acceptable
   - Performance/SLA tolerances

2. **Scientist Pattern**: Originating from GitHub, this pattern:
   - Mirrors live production traffic to a candidate implementation
   - Compares responses between production and candidate
   - Logs differences without affecting production users
   - Uses the comparison to build confidence in the candidate

3. **Shadow Traffic**: Traffic that is mirrored from production to candidates. The actual user sees the production response; candidate responses are discarded after comparison.

---

## Architecture

### Component Relationships

```
┌─────────────────────────────────────────────────────────────────┐
│                        Scientist Comparator Flow                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│  │  Shadow      │    │ Scientist    │    │ Spec DO       │     │
│  │  Router      │────►│ Comparator   │◄───►│ (Durable      │     │
│  │              │    │ Queue        │    │  Object)      │     │
│  │ - Mirrors    │    │ Consumer     │    │              │     │
│  │   traffic    │    │ Worker       │    │ - Spec        │     │
│  │ - Fans out   │    │              │    │   definitions │     │
│  │   to candidates│  └──────┬───────┘    │ - Declared   │     │
│  └──────────────┘         │              │   delta       │     │
│                            │              │   surface     │     │
│                            ▼              └──────────────┘     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Comparison Logic                              │ │
│  │  1. Retrieve baseline response (from production Worker)       │ │
│  │  2. Retrieve candidate responses (from Worker Previews)      │ │
│  │  3. Compare responses against declared delta surface          │ │
│  │  4. Calculate match score (0-100)                               │ │
│  │  5. Write metrics to Analytics Engine                         │ │
│  │  6. Update candidate shadow_score in Spec DO                    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Analytics Engine                              │ │
│  │  - Per-request comparison metrics                             │ │
│  │  - Aggregate candidate scores                                   │ │
│  │  - SLO tracking                                                  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
1. User Request → Production Worker → Response
   │
   ▼
2. Shadow Router receives copy of request
   │
   ▼
3. Shadow Router fans out to N candidate Workers
   │
   ▼
4. Shadow Router discards candidate responses
   │
   ▼
5. Shadow Router sends comparison request to Scientist Queue
   │  (includes: requestId, path, method, baselineResponse, candidateResponses)
   │
   ▼
6. Scientist Comparator Queue Consumer processes request
   │
   ▼
7. Scientist Comparator:
   a. Fetches spec's declared_delta_surface from Spec DO
   b. Compares baseline vs each candidate using delta surface rules
   c. Calculates match score
   d. Writes detailed metrics to Analytics Engine
   e. Updates candidate.shadow_score in Spec DO
   f. Creates/updates gate_verdicts record for 'shadow' gate
   │
   ▼
8. Results stored and visible in:
   - Spec DO: candidate.shadow_score, candidate.shadow_match
   - Analytics Engine: per-request comparison metrics
   - Spec DO: gate_verdicts table (shadow gate results)
```

---

## Declared Delta Surface Format

The `specs.declared_delta_surface` field is a JSON document that defines acceptable differences:

### Schema

```json
{
  "version": "1.0",
  "paths": {
    "/api/users/{id}": {
      "statusCodes": {
        "allowed": [200, 404],
        "forbidden": [500]
      },
      "response": {
        "body": {
          "allowedDiffs": ["data.email", "data.createdAt"],
          "forbiddenDiffs": ["data.id", "data.type"],
          "newFieldsAllowed": false
        },
        "headers": {
          "allowedDiffs": ["X-RateLimit-Reset"],
          "forbiddenDiffs": ["Content-Type", "Authorization"]
        }
      },
      "performance": {
        "maxLatencyDeltaMs": 50,
        "maxLatencyRatio": 1.5
      }
    },
    "/api/users": {
      "statusCodes": {
        "allowed": [200, 201],
        "forbidden": []
      },
      "response": {
        "body": {
          "allowedDiffs": ["*.id", "*.createdAt"],
          "forbiddenDiffs": [],
          "newFieldsAllowed": true
        }
      }
    }
  },
  "defaults": {
    "statusCodes": {
      "allowed": [200, 201, 204, 400, 401, 403, 404],
      "forbidden": [500, 502, 503, 504]
    },
    "response": {
      "body": {
        "allowedDiffs": [],
        "forbiddenDiffs": ["id", "type", "createdAt"],
        "newFieldsAllowed": false
      },
      "headers": {
        "allowedDiffs": ["X-*", "Cache-Control"],
        "forbiddenDiffs": ["Content-Type", "Authorization", "Set-Cookie"]
      }
    },
    "performance": {
      "maxLatencyDeltaMs": 100,
      "maxLatencyRatio": 2.0
    }
  }
}
```

### Path Matching

- Exact match: `/api/users`
- Parameterized: `/api/users/{id}` matches `/api/users/123`
- Wildcard: `/api/*` matches any path under `/api/`
- Glob patterns: `/api/users/*/settings`

### Field Paths

- Simple: `data.name`
- Nested: `data.user.address.city`
- Array: `data.items[0].id` or `data.items[*].name`
- Wildcard: `*.createdAt` matches any object's createdAt field

---

## Comparison Logic

### Input

For each mirrored request, the Scientist Comparator receives:

```typescript
interface ComparisonInput {
  requestId: string;
  timestamp: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  
  baseline: {
    candidateId: 'production' | string;
    status: number;
    headers: Record<string, string>;
    body?: string;
    latencyMs: number;
  };
  
  candidates: Array<{
    candidateId: string;
    specId: string;
    status: number;
    headers: Record<string, string>;
    body?: string;
    latencyMs: number;
  }>;
}
```

### Comparison Steps

1. **Normalize Responses**
   - Parse JSON bodies (if content-type is JSON)
   - Normalize headers (case-insensitive)
   - Sort array fields for consistent comparison

2. **Status Code Comparison**
   ```typescript
   function compareStatusCodes(baseline: number, candidate: number, deltaSurface: DeltaSurface): StatusResult {
     const pathConfig = getPathConfig(deltaSurface, path);
     const allowed = pathConfig.statusCodes?.allowed || deltaSurface.defaults.statusCodes.allowed;
     const forbidden = pathConfig.statusCodes?.forbidden || deltaSurface.defaults.statusCodes.forbidden;
     
     // If both are in allowed, they match
     if (allowed.includes(baseline) && allowed.includes(candidate)) {
       return { match: true, type: 'status_match' };
     }
     
     // If candidate is forbidden, it's a failure
     if (forbidden.includes(candidate)) {
       return { match: false, type: 'status_forbidden', severity: 'error' };
     }
     
     // If baseline and candidate differ
     if (baseline !== candidate) {
       return { match: false, type: 'status_mismatch', severity: 'warning' };
     }
     
     return { match: true, type: 'status_match' };
   }
   ```

3. **Header Comparison**
   ```typescript
   function compareHeaders(
     baselineHeaders: Record<string, string>,
     candidateHeaders: Record<string, string>,
     deltaSurface: DeltaSurface
   ): HeaderComparisonResult {
     const pathConfig = getPathConfig(deltaSurface, path);
     const headerConfig = pathConfig.response?.headers || deltaSurface.defaults.response.headers;
     
     const results: HeaderDiff[] = [];
     const allHeaders = new Set([
       ...Object.keys(baselineHeaders),
       ...Object.keys(candidateHeaders)
     ]);
     
     for (const headerName of allHeaders) {
       const normalizedName = headerName.toLowerCase();
       const baselineValue = baselineHeaders[headerName];
       const candidateValue = candidateHeaders[headerName];
       
       // Check if this header is forbidden to differ
       const isForbidden = headerConfig.forbiddenDiffs?.some(f => 
         headerName.toLowerCase().match(wildcardToRegex(f.toLowerCase()))
       );
       
       if (isForbidden && baselineValue !== candidateValue) {
         results.push({
           header: normalizedName,
           baselineValue,
           candidateValue,
           type: 'forbidden_diff',
           severity: 'error'
         });
         continue;
       }
       
       // Check if this header is allowed to differ
       const isAllowed = headerConfig.allowedDiffs?.some(a => 
         headerName.toLowerCase().match(wildcardToRegex(a.toLowerCase()))
       );
       
       if (!isAllowed && baselineValue !== candidateValue) {
         results.push({
           header: normalizedName,
           baselineValue,
           candidateValue,
           type: 'unexpected_diff',
           severity: 'warning'
         });
       }
     }
     
     return {
       match: results.length === 0,
       diffs: results
     };
   }
   ```

4. **Body Comparison**
   ```typescript
   function compareBodies(
     baselineBody: unknown,
     candidateBody: unknown,
     deltaSurface: DeltaSurface
   ): BodyComparisonResult {
     const pathConfig = getPathConfig(deltaSurface, path);
     const bodyConfig = pathConfig.response?.body || deltaSurface.defaults.response.body;
     
     const results: BodyDiff[] = [];
     
     // Parse and normalize both bodies
     const baseline = normalizeBody(baselineBody);
     const candidate = normalizeBody(candidateBody);
     
     // Find all paths in both bodies
     const allPaths = new Set([
       ...getAllPaths(baseline, ''),
       ...getAllPaths(candidate, '')
     ]);
     
     for (const path of allPaths) {
       const baselineValue = getPathValue(baseline, path);
       const candidateValue = getPathValue(candidate, path);
       
       // Check if new field in candidate
       if (baselineValue === undefined && candidateValue !== undefined) {
         if (!bodyConfig.newFieldsAllowed) {
           results.push({
             path,
             baselineValue,
             candidateValue,
             type: 'new_field',
             severity: 'error'
           });
         }
         continue;
       }
       
       // Check if field removed in candidate
       if (baselineValue !== undefined && candidateValue === undefined) {
         results.push({
           path,
           baselineValue,
           candidateValue,
           type: 'missing_field',
           severity: 'error'
         });
         continue;
       }
       
       // Values differ
       if (!deepEqual(baselineValue, candidateValue)) {
         // Check if this path is explicitly allowed to differ
         const isAllowed = bodyConfig.allowedDiffs?.some(a => 
           path.match(wildcardToRegex(a))
         );
         
         if (isAllowed) {
           continue; // Allowed difference
         }
         
         // Check if this path is forbidden to differ
         const isForbidden = bodyConfig.forbiddenDiffs?.some(f => 
           path.match(wildcardToRegex(f))
         );
         
         results.push({
           path,
           baselineValue,
           candidateValue,
           type: isForbidden ? 'forbidden_diff' : 'unexpected_diff',
           severity: isForbidden ? 'error' : 'warning'
         });
       }
     }
     
     return {
       match: results.length === 0,
       diffs: results
     };
   }
   ```

5. **Performance Comparison**
   ```typescript
   function comparePerformance(
     baselineLatencyMs: number,
     candidateLatencyMs: number,
     deltaSurface: DeltaSurface
   ): PerformanceComparisonResult {
     const pathConfig = getPathConfig(deltaSurface, path);
     const perfConfig = pathConfig.performance || deltaSurface.defaults.performance;
     
     const deltaMs = candidateLatencyMs - baselineLatencyMs;
     const ratio = candidateLatencyMs / Math.max(baselineLatencyMs, 1);
     
     const results: PerformanceIssue[] = [];
     
     if (Math.abs(deltaMs) > perfConfig.maxLatencyDeltaMs) {
       results.push({
         type: 'absolute_delta_exceeded',
         deltaMs,
         threshold: perfConfig.maxLatencyDeltaMs,
         severity: 'warning'
       });
     }
     
     if (ratio > perfConfig.maxLatencyRatio) {
       results.push({
         type: 'ratio_exceeded',
         ratio,
         threshold: perfConfig.maxLatencyRatio,
         severity: 'warning'
       });
     }
     
     return {
       match: results.length === 0,
       latencyDeltaMs: deltaMs,
       latencyRatio: ratio,
       issues: results
     };
   }
   ```

6. **Overall Comparison Result**
   ```typescript
   interface ComparisonResult {
     requestId: string;
     candidateId: string;
     specId: string;
     path: string;
     method: string;
     timestamp: number;
     
     statusComparison: StatusResult;
     headerComparison: HeaderComparisonResult;
     bodyComparison: BodyComparisonResult;
     performanceComparison: PerformanceComparisonResult;
     
     // Aggregated score (0-100)
     score: number;
     
     // Did this request match?
     matched: boolean;
     
     // Error count
     errors: number;
     warnings: number;
     
     // Detailed diffs
     diffs: Array<{
       type: 'status' | 'header' | 'body' | 'performance';
       path?: string;
       severity: 'error' | 'warning' | 'info';
       message: string;
       details?: unknown;
     }>;
   }
   ```

### Scoring Algorithm

```typescript
function calculateScore(result: ComparisonResult): number {
  let score = 100;
  
  // Status code mismatches are critical errors (-40 points each)
  if (!result.statusComparison.match) {
    if (result.statusComparison.severity === 'error') {
      score -= 40;
    } else {
      score -= 20;
    }
  }
  
  // Header errors (-10 points each, max -20)
  const headerErrors = result.headerComparison.diffs.filter(
    d => d.severity === 'error'
  ).length;
  score -= Math.min(headerErrors * 10, 20);
  
  // Header warnings (-5 points each, max -10)
  const headerWarnings = result.headerComparison.diffs.filter(
    d => d.severity === 'warning'
  ).length;
  score -= Math.min(headerWarnings * 5, 10);
  
  // Body errors (-15 points each, max -40)
  const bodyErrors = result.bodyComparison.diffs.filter(
    d => d.severity === 'error'
  ).length;
  score -= Math.min(bodyErrors * 15, 40);
  
  // Body warnings (-5 points each, max -10)
  const bodyWarnings = result.bodyComparison.diffs.filter(
    d => d.severity === 'warning'
  ).length;
  score -= Math.min(bodyWarnings * 5, 10);
  
  // Performance issues (-5 points each, max -10)
  const perfIssues = result.performanceComparison.issues.length;
  score -= Math.min(perfIssues * 5, 10);
  
  // Ensure score is between 0 and 100
  return Math.max(0, Math.min(100, score));
}
```

---

## Implementation Plan

### Phase 1: Queue and Worker Setup

**Files to create:**

```
workers/scientist-comparator/
├── wrangler.toml          # Worker configuration
├── index.ts               # Main worker entry point
├── types.ts               # Type definitions
├── comparison.ts          # Core comparison logic
├── delta-surface.ts       # Delta surface parsing/matching
├── scoring.ts             # Scoring algorithm
└── metrics.ts             # Analytics Engine integration
```

**Tasks:**

1. Create `beehive-scientist-comparator` worker with queue consumer binding
2. Define queue: `beehive-scientist-comparisons`
3. Set up bindings to:
   - `SPEC_DO` Durable Object (for spec definitions and candidate updates)
   - `ANALYTICS` Analytics Engine (for metrics)
   - Queue consumer for `beehive-scientist-comparisons`

### Phase 2: Core Comparison Logic

**Tasks:**

1. Implement delta surface parser (JSON schema validation, path matching)
2. Implement response normalizers (JSON, headers, timestamps)
3. Implement comparison functions:
   - `compareStatusCodes`
   - `compareHeaders`
   - `compareBodies`
   - `comparePerformance`
4. Implement scoring algorithm
5. Implement aggregate comparison for multiple candidates

### Phase 3: Worker Implementation

**Tasks:**

1. Queue message handler that:
   - Receives comparison request from shadow router
   - Fetches spec's declared_delta_surface from Spec DO
   - Retrieves baseline response (may need to replay from production)
   - Compares each candidate response
   - Calculates scores
   - Updates Spec DO with results
   - Writes metrics to Analytics Engine

### Phase 4: Integration with Shadow Router

**Tasks:**

1. Update shadow-router to send comparison requests to scientist queue
2. Include in queue message:
   - Request metadata (path, method, headers)
   - Baseline response (or reference to fetch it)
   - All candidate responses
   - Candidate IDs and spec IDs

### Phase 5: Spec DO Integration

**Tasks:**

1. Add/update tables if needed (should be covered by existing schema)
2. Add methods to Spec DO for:
   - Recording shadow comparison results
   - Updating candidate.shadow_score (rolling average)
   - Updating candidate.shadow_match (boolean)
   - Creating/updating gate_verdicts for 'shadow' gate

### Phase 6: Metrics and Observability

**Tasks:**

1. Write detailed comparison metrics to Analytics Engine:
   - Per-request comparison results
   - Aggregate candidate scores
   - Diff counts and types
   - Performance deltas
2. Add logging for debugging
3. Add health check endpoint

---

## Queue Message Format

```typescript
interface ScientistQueueMessage {
  requestId: string;
  timestamp: number;
  
  // Request metadata
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  
  // Baseline response (from production)
  baseline: {
    candidateId: string;
    specId: string;
    status: number;
    headers: Record<string, string>;
    body?: string;
    latencyMs: number;
  };
  
  // Candidate responses
  candidates: Array<{
    candidateId: string;
    specId: string;
    status: number;
    headers: Record<string, string>;
    body?: string;
    latencyMs: number;
  }>;
}
```

---

## Spec DO Updates

### Existing Schema (No Changes Needed)

The existing schema already supports shadow comparisons:

- `candidates.shadow_score` - INTEGER (0-100, rolling average)
- `candidates.shadow_match` - BOOLEAN (true if last comparison matched)
- `candidates.shadow_metrics` - TEXT (JSON, detailed comparison stats)
- `gate_verdicts` table with `gate = 'shadow'` support

### Required Spec DO Methods

```typescript
// In SpecDO class
async recordShadowComparison(
  comparison: ComparisonResult
): Promise<void> {
  // Update candidate.shadow_score (rolling average)
  // Update candidate.shadow_match
  // Store detailed metrics in candidate.shadow_metrics
  // Create/update gate_verdict for 'shadow' gate
}

async getSpecDeltaSurface(specId: string): Promise<DeltaSurface> {
  // Fetch and parse declared_delta_surface from specs table
}

async getCandidateSpec(candidateId: string): Promise<{ specId: string }> {
  // Lookup spec_id for a candidate
}
```

---

## Metrics Schema

### Analytics Engine Datasets

All datasets are auto-created on first write.

#### 1. `shadow_comparisons` (per-request metrics)

Indexes:
- `requestId` (string)
- `candidateId` (string)
- `specId` (string)
- `path` (string)
- `timestamp` (number)

Doubles:
- `score` (0-100)
- `baselineStatus` (number)
- `candidateStatus` (number)
- `baselineLatencyMs` (number)
- `candidateLatencyMs` (number)
- `latencyDeltaMs` (number)
- `statusMatch` (0 or 1)
- `headersMatch` (0 or 1)
- `bodyMatch` (0 or 1)
- `matched` (0 or 1)
- `errorCount` (number)
- `warningCount` (number)

Blobs:
- `declaredDeltaSurface` (string, JSON)
- `diffs` (string, JSON array)

#### 2. `candidate_shadow_scores` (aggregate metrics)

Indexes:
- `candidateId` (string)
- `specId` (string)
- `timestamp` (number, hourly)

Doubles:
- `averageScore` (0-100)
- `matchRate` (0-1, percentage of matched requests)
- `totalRequests` (number)
- `matchedRequests` (number)
- `errorRate` (0-1)
- `warningRate` (0-1)

---

## Configuration

### wrangler.toml

```toml
# workers/scientist-comparator/wrangler.toml
name = "beehive-scientist-comparator"
main = "index.ts"
compatibility_date = "2026-10-09"

# Auth token (same as other workers)
[vars]
API_AUTH_TOKEN = "@api-auth-token"

# Durable Object binding for Spec DO
[[durable_objects.bindings]]
name = "SPEC_DO"
class_name = "SpecDO"
script_name = "beehive"

# Analytics Engine for metrics
[analytics_engine]
binding = "ANALYTICS"
database_name = "beehive-metrics"

# Queue consumer
[[queues.consumers]]
queue = "beehive-scientist-comparisons"
binding = "SCIENTIST_QUEUE"

[observability]
enabled = true
head_sampling_rate = 1
redact_query_string = false

[observability.logs]
enabled = true
head_sampling_rate = 1
invocation_logs = true
persist = true
```

### package.json Scripts

```json
{
  "scripts": {
    "dev:scientist": "wrangler dev --local --config workers/scientist-comparator/wrangler.toml",
    "deploy:scientist": "wrangler deploy --config workers/scientist-comparator/wrangler.toml",
    "tail:scientist": "wrangler tail --config workers/scientist-comparator/wrangler.toml"
  }
}
```

---

## Error Handling

### Queue Processing Guarantees

- At-least-once delivery (Cloudflare Queues)
- Idempotent processing: same message processed multiple times = same result
- Error handling: failed messages are retried with exponential backoff

### Retry Strategy

```typescript
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 5000, 15000];

async function processMessage(message: ScientistQueueMessage, env: Env): Promise<void> {
  let retryCount = 0;
  
  while (retryCount <= MAX_RETRIES) {
    try {
      await doComparison(message, env);
      return; // Success
    } catch (error) {
      retryCount++;
      if (retryCount > MAX_RETRIES) {
        await handleDeadLetter(message, error);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[retryCount - 1]));
    }
  }
}
```

### Dead Letter Queue

Messages that fail after max retries are written to a dead letter queue for manual inspection.

---

## Testing Strategy

### Unit Tests

1. Delta surface parser tests
   - Path matching (exact, parameterized, wildcard)
   - Field path parsing
   - Schema validation

2. Comparison logic tests
   - Status code comparison
   - Header comparison
   - Body comparison
   - Performance comparison

3. Scoring algorithm tests
   - Various diff combinations
   - Edge cases (empty bodies, missing fields)

### Integration Tests

1. Queue message processing
   - Happy path (all candidates match)
   - Partial match (some candidates match, some don't)
   - Complete failure (all candidates fail)

2. Spec DO integration
   - Score updates
   - Verdict recording

3. Analytics Engine integration
   - Metrics writing
   - Batch processing

### E2E Tests

1. End-to-end shadow flow:
   - Shadow router receives request
   - Fans out to candidates
   - Sends to scientist queue
   - Scientist processes and updates state
   - Metrics are visible in Analytics Engine

---

## Deployment Checklist

- [ ] Worker deployed: `wrangler deploy --config workers/scientist-comparator/wrangler.toml`
- [ ] API_AUTH_TOKEN set on worker
- [ ] Queue created: `wrangler queues create beehive-scientist-comparisons`
- [ ] Queue consumer binding verified
- [ ] Spec DO binding verified
- [ ] Analytics Engine binding verified
- [ ] Shadow router updated to send to queue
- [ ] Health check endpoint responds: `/health`
- [ ] First comparison processed successfully
- [ ] Metrics visible in Analytics Engine

---

## File Structure (Final)

```
workers/scientist-comparator/
├── wrangler.toml              # Worker configuration
├── package.json              # Dependencies (if any)
├── index.ts                  # Main worker with queue handler
├── types.ts                  # TypeScript type definitions
├── comparison/
│   ├── index.ts              # Main comparison orchestrator
│   ├── status.ts             # Status code comparison
│   ├── headers.ts            # Header comparison
│   ├── body.ts               # Body comparison
│   └── performance.ts        # Performance comparison
├── delta-surface/
│   ├── parser.ts             # Delta surface JSON parser
│   ├── matcher.ts            # Path matching utilities
│   └── validator.ts          # Schema validator
├── scoring/
│   ├── calculator.ts         # Score calculation
│   └── weights.ts            # Scoring weights configuration
├── storage/
│   ├── spec-do.ts            # Spec DO client
│   └── analytics.ts          # Analytics Engine client
└── utils/
    ├── normalizers.ts        # Response normalizers
    └── helpers.ts            # Utility functions
```

---

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - Overall system architecture
- [MILESTONES.md](./MILESTONES.md) - Project milestones and phases
- [AGENTS.md](../AGENTS.md) - Agent working conventions
- [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md) - Findings and open questions
- [docs/ARTIFACTS-SETUP.md](./ARTIFACTS-SETUP.md) - Artifacts configuration

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-10-11 | @bailey | Initial design document created |

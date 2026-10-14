---
category: deprecated
status: deprecated
audience: human
tags:
  - review-needed
---


# Zod Schema Migration

## Overview

This document describes the migration of Beehive types to use Zod for runtime validation at API boundaries and service-to-service calls.

## Why Zod?

Based on the debugging session where field name mismatches (camelCase vs snake_case) and missing fields caused failures, we've introduced Zod schemas to:

1. **Catch field name mismatches** at runtime before they reach the database
2. **Validate required vs optional fields** to prevent undefined behavior
3. **Provide clear error messages** for debugging type issues
4. **Maintain type safety** with full TypeScript inference

## Migration Status

### ✅ Completed

- **workers/shared/schemas.ts** - Central schema repository with all core schemas
- **workers/api/types.ts** - Added Zod schemas for all API types
- **workers/preview-manager/types.ts** - Added Zod schemas for preview types
- **workers/queue-consumer/index.ts** - Added Zod validation for queue messages
- **workers/gate-workflow/index.ts** - Added Zod validation for gate workflow requests
- **workers/scientist-comparator/types.ts** - Added Zod schemas for comparison types
- **workers/candidate-service/types.ts** - Added Zod schemas for candidate types
- **scripts/test-zod-schemas.ts** - Test script to verify schemas work

### 📝 Files Modified

| File | Changes |
|------|---------|
| `workers/shared/schemas.ts` | New file with all core Zod schemas |
| `workers/api/types.ts` | Added Zod schemas alongside existing interfaces |
| `workers/preview-manager/types.ts` | Added Zod schemas for preview types |
| `workers/queue-consumer/index.ts` | Added message validation with Zod |
| `workers/gate-workflow/index.ts` | Added request validation with Zod |
| `workers/scientist-comparator/types.ts` | Added Zod schemas for queue messages and comparison types |
| `workers/candidate-service/types.ts` | Added Zod schemas for candidate service types |

## Usage Examples

### Validating Request Bodies

```typescript
import { validateRequest, CreateCandidateRequestSchema } from '../api/types';

async function handleCreateCandidate(request: Request, env: Env) {
  // Validate and parse request body
  const body = await validateRequest(request, CreateCandidateRequestSchema);
  
  // body is now type-safe and validated
  const candidate = await createCandidate(
    body.specId,
    body.repositoryId,
    body.commitSha,
    body.baseCommitSha,
    body.agentId
  );
}
```

### Validating Queue Messages

```typescript
import { QueueMessageSchema } from '../shared/schemas';

function validateQueueMessage(message: unknown): QueueMessage {
  const result = QueueMessageSchema.safeParse(message);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `${path}: ${issue.message}`;
    });
    throw new Error(`Queue message validation failed: ${errors.join('; ')}`);
  }
  return result.data;
}
```

### Creating Custom Schemas

```typescript
import { z } from 'zod';
import { UUIDSchema, CandidateStageSchema } from '../shared/schemas';

const CustomCandidateSchema = z.object({
  id: UUIDSchema,
  stage: CandidateStageSchema,
  customField: z.string(),
});

type CustomCandidate = z.infer<typeof CustomCandidateSchema>;
```

## Key Schema Categories

### Base Types
- `UUIDSchema` - Validates UUID v4 format
- `PaginationParamsSchema` - Validates pagination parameters

### API Response Types
- `OrganizationTypeSchema`, `OrganizationResponseSchema`
- `ActorTypeSchema`, `ActorResponseSchema`
- `RepoTypeSchema`, `RepositoryResponseSchema`
- `SpecStageSchema`, `SpecResponseSchema`
- `CandidateStageSchema`, `CandidateResponseSchema`
- `GateSchema`, `GateVerdictResponseSchema`
- `TrialStageSchema`, `TrialResponseSchema`
- `PromotionStageSchema`, `PromotionResponseSchema`

### Queue Message Types
- `ArtifactsPushEventSchema` - Validates Cloudflare Artifacts push events
- `QueueMessageSchema` - Validates queue message wrapper
- `ScientistQueueMessageSchema` - Validates scientist comparison messages

### Preview Types
- `DeployPreviewRequestBodySchema` - Validates preview deployment requests
- `PreviewDeploymentSchema` - Validates preview deployment results
- `PreviewConfigSchema` - Validates preview configuration

### Gate Workflow Types
- `GateWorkflowRequestSchema` - Validates gate workflow requests
- `TestResultSchema` - Validates test results
- `ConformanceErrorSchema` - Validates conformance errors
- `GateWorkflowResultSchema` - Validates gate workflow results

## Backwards Compatibility

All existing TypeScript interfaces are **preserved**. The Zod schemas are additive and do not break existing code. You can:

1. Continue using the interfaces for type annotations
2. Use the schemas for runtime validation
3. Gradually migrate to using schemas for both

## Testing

Run the test script to verify all schemas work:

```bash
npm run test-zod-schemas
```

## Known Issues & TODO

1. **TypeScript compilation errors** - Some files still need updates to work with the new schemas
   - `workers/candidate-service/index.ts` - Needs to import and use schemas
   - `workers/queue-consumer/index.ts` - Type mismatch in queue message handling
   - `workers/scientist-comparator/types.ts` - `.extend()` method not available in Zod v4

2. **Zod v4 compatibility** - Some schemas use `.extend()` which is not available in Zod v4. Use object spread or `.and()` instead.

3. **Missing AnalyticsEngine type** - Need to add AnalyticsEngine type definition for shadow-router.

## Best Practices

1. **Validate at API boundaries** - Always validate incoming requests before processing
2. **Use safeParse for graceful handling** - Use `.safeParse()` to handle validation failures gracefully
3. **Provide clear error messages** - Format validation errors to help with debugging
4. **Keep interfaces for compatibility** - Don't remove existing interfaces, keep them alongside schemas

## Resources

- [Zod Documentation](https://zod.dev/)
- [Zod v4 Migration Guide](https://zod.dev/?id=migration-guide)

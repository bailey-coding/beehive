---
category: planning
status: draft
milestone: m6
audience: human,agent
tags:
  - security
  - ci
  - ocap
  - platform
---

# OCAP CI Security Plan

**Problem:** Monorepos complicate OCAP CI security because a single CI token typically has access to all services. Polyrepos solve this naturally but sacrifice cross-cutting change ergonomics.

**Solution:** Make **services** (not repos) the capability boundary. Beehive supports both polyrepos and monorepos, but enforces service-scoped capabilities in both cases.

---

## Background

Object-Capability (OCAP) security requires that agents/workflows have only the minimum capabilities needed for their task. In CI/CD:

- **Polyrepo model**: Each service in its own repo → CI token only needs access to that one repo → natural OCAP.
- **Monorepo model**: All services in one repo → CI token typically has access to everything → OCAP violation.

Beehive's architecture (Spec DO, Cloudflare Workers, Artifacts) already supports service isolation. The platform should **explicitly model services as capability boundaries**, independent of repo structure.

---

## Design: Service-Scoped OCAP

### Core Principle
> **Capabilities are granted to services, not repos.** A service can live in a polyrepo (1:1) or monorepo (1:N with path prefixes), but its capabilities are identical in both cases.

### Service Definition

A service in Beehive is defined by:
- `service_id`: Unique identifier (e.g., `payment-service`)
- `repo_id`: Parent repository
- `path_prefix`: Path within repo (e.g., `services/payment` or empty for repo-root)
- `deploy_target`: Worker name to deploy to
- `capabilities`: Explicit list of allowed resources (queues, D1 databases, KV namespaces, etc.)

### Capability Token Structure

Each service receives a **scoped capability token** containing:
```json
{
  "service_id": "payment-service",
  "repo_id": "acme/beehive-monorepo",
  "path_prefix": "services/payment",
  "allowed_actions": ["deploy", "test", "read:config"],
  "allowed_resources": {
    "workers": ["payment-worker"],
    "queues": ["payment-queue"],
    "d1": ["payment_db"]
  },
  "expires_at": "2026-10-15T00:00:00Z",
  "signed": "..."
}
```

---

## Implementation Phases

### Phase 1: Service Registry (M3)

**Goal:** Track services as first-class entities in Spec DO.

**Schema additions (`spec-do/schema.ts`):**
```typescript
// New tables
services: {
  id: string;           // service_id
  repo_id: string;     // references repositories.id
  path_prefix: string; // "services/payment" or ""
  deploy_target: string; // worker name
  created_at: number;
  updated_at: number;
}

service_capabilities: {
  service_id: string;  // references services.id
  resource_type: 'worker' | 'queue' | 'd1' | 'kv' | 'r2';
  resource_name: string;
  action: 'read' | 'write' | 'deploy' | 'manage';
}

// Index for path-based lookups
service_paths: {
  repo_id: string;
  path_prefix: string;
  service_id: string;
}
```

**API additions:**
- `POST /repos/:repo_id/services` - Register a service
- `GET /repos/:repo_id/services` - List services in a repo
- `GET /repos/:repo_id/services/by-path?path=:path` - Find service by file path

### Phase 2: Capability Validation in Gate Workflow (M3)

**Goal:** Gate workflow validates that changes only affect authorized services.

**Changes to `beehive-gate-workflow`:**
1. On PR, identify all modified files
2. Map files to services using `service_paths` table
3. For each service, check caller has capability for that service
4. Reject PR if any modified file is in a service the caller cannot access

**New validation function:**
```typescript
async function validateServiceCapabilities(
  actorId: string,
  repoId: string,
  modifiedFiles: string[]
): Promise<ValidationResult> {
  // 1. Find all services touched by this PR
  const touchedServices = await findServicesByPaths(repoId, modifiedFiles);
  
  // 2. Check actor has capabilities for all touched services
  const actorCaps = await getActorCapabilities(actorId);
  
  // 3. Reject if any service lacks required capability
  for (const service of touchedServices) {
    if (!actorCaps.canAccess(service.id)) {
      return { valid: false, reason: `Missing capability for service: ${service.id}` };
    }
  }
  
  return { valid: true };
}
```

### Phase 3: Scoped Token Generation (M3-M4)

**Goal:** CI workflows receive tokens scoped to specific services.

**New endpoint:**
```
POST /services/:service_id/tokens
```

Generates a short-lived JWT with claims:
```json
{
  "sub": "service:payment-service",
  "service_id": "payment-service",
  "repo_id": "acme/beehive-monorepo",
  "path_prefix": "services/payment",
  "capabilities": {
    "workers": ["payment-worker"],
    "queues": ["payment-queue"]
  },
  "exp": 1731638400
}
```

**Integration with Cloudflare:**
- Use OIDC to request Cloudflare tokens with scoped permissions
- Or generate Cloudflare API tokens with resource restrictions
- Store these as encrypted secrets, keyed by service_id

### Phase 4: Service-Aware Deployment (M4)

**Goal:** Deployment workflows can only deploy services they have capabilities for.

**Changes to `beehive` edge router:**
- Add middleware to validate service capabilities from incoming requests
- Each deployment request must include a valid service token
- Token is validated against the requested action

**New middleware:**
```typescript
export async function enforceServiceCapability(
  request: Request,
  next: NextFunction
) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  
  if (!token) {
    return new Response('Missing token', { status: 401 });
  }
  
  const claims = verifyServiceToken(token);
  const requiredService = request.headers.get('X-Service-ID');
  
  if (claims.service_id !== requiredService) {
    return new Response('Token not valid for this service', { status: 403 });
  }
  
  // Check capability for the specific action
  if (!claims.capabilities.includes(getRequiredCapability(request))) {
    return new Response('Insufficient capabilities', { status: 403 });
  }
  
  return next();
}
```

---

## User Experience

### Polyrepo User Flow

1. Create repo `acme/payment-service`
2. Beehive auto-registers service `payment-service` (path_prefix = "")
3. Generate capability token for CI
4. CI workflow uses token to deploy only `payment-worker`

### Monorepo User Flow

1. Create repo `acme/beehive-monorepo`
2. Define services in `beehive.yml`:
   ```yaml
   services:
     payment:
       path: services/payment
       deploy_target: payment-worker
       capabilities:
         - queues:payment-queue
         - d1:payment_db
     auth:
       path: services/auth
       deploy_target: auth-worker
       capabilities:
         - queues:auth-queue
   ```
3. Beehive registers both services
4. Generate separate tokens for each service's CI workflow
5. Each workflow deploys only its service with scoped access

---

## Migration Strategy

### For Existing Beehive Repos

1. **Audit phase**: Identify all services in existing repos (by worker bindings, path structure)
2. **Registration phase**: Auto-register services based on existing structure
3. **Token rotation**: Generate new scoped tokens, phase out repo-wide tokens
4. **Validation phase**: Enable capability checks in gate workflow (warn-only first, then enforce)

### For New Repos

1. Require service declaration at repo creation
2. Enforce capability validation from day one
3. Provide templates for both polyrepo and monorepo patterns

---

## Success Criteria

- [ ] Services are first-class entities in Spec DO
- [ ] Gate workflow validates service capabilities
- [ ] CI tokens are scoped to individual services
- [ ] Deployment workflows can only deploy authorized services
- [ ] Both polyrepo and monorepo patterns are fully supported
- [ ] All existing functionality remains operational
- [ ] Documentation updated with service-scoped OCAP patterns

---

## Dependencies

- Spec DO schema migration system (M2 complete)
- Gate workflow service discovery
- Cloudflare OIDC integration (optional, for dynamic token generation)
- Worker-to-Worker auth for capability validation

---

## Open Questions

1. **Token lifetime**: How long should service tokens be valid? (Proposal: 1 hour for CI, 24 hours for development)
2. **Token storage**: Where should service tokens be stored? (GitHub secrets per-service, or Beehive-managed)
3. **Capability inheritance**: Should services inherit capabilities from their repo? (Proposal: No, explicit only)
4. **Cross-service dependencies**: How to handle services that need to call each other? (Proposal: Service A's token includes capability to invoke Service B)

---

## Related Documents

- [AGENTS.md](../AGENTS.md) - Platform conventions
- [MILESTONES.md](./MILESTONES.md) - Overall project milestones
- [ARCHITECTURE.md](./ARCHITECTURE.md) - Core architecture principles

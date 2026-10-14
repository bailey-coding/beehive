---
category: reference
status: draft
milestone: m6
audience: human,agent
tags:
  - security
  - ci
  - ocap
  - implementation
---

# OCAP CI Security — Implementation Checklist

**Parent document:** [OCAP-CI-PLAN.md](./OCAP-CI-PLAN.md)

---

## Phase 1: Service Registry (M3)

- [ ] Add `services` table to Spec DO schema
  - [ ] `id` (service_id)
  - [ ] `repo_id` (foreign key to repositories)
  - [ ] `path_prefix` (e.g., "services/payment")
  - [ ] `deploy_target` (worker name)
  - [ ] `created_at`, `updated_at`
  
- [ ] Add `service_capabilities` table
  - [ ] `service_id` (foreign key)
  - [ ] `resource_type` (worker/queue/d1/kv/r2)
  - [ ] `resource_name`
  - [ ] `action` (read/write/deploy/manage)

- [ ] Add `service_paths` index table
  - [ ] `repo_id`
  - [ ] `path_prefix`
  - [ ] `service_id`

- [ ] API endpoints
  - [ ] `POST /repos/:repo_id/services`
  - [ ] `GET /repos/:repo_id/services`
  - [ ] `GET /repos/:repo_id/services/by-path?path=:path`

- [ ] Schema migration for existing repos

---

## Phase 2: Gate Workflow Validation (M3)

- [ ] Implement `findServicesByPaths(repoId, paths)` helper
- [ ] Implement `getActorCapabilities(actorId)` helper
- [ ] Create `validateServiceCapabilities()` function
- [ ] Integrate validation into gate workflow
- [ ] Add warn-only mode (initial rollout)
- [ ] Switch to enforce mode (after testing)

---

## Phase 3: Scoped Token Generation (M3-M4)

- [ ] Design token structure (JWT format)
- [ ] Implement token signing/verification
- [ ] Create `POST /services/:service_id/tokens` endpoint
- [ ] Set token TTL (proposal: 1 hour for CI, 24 hours for dev)
- [ ] Store tokens securely (encrypted in KV)

---

## Phase 4: Service-Aware Deployment (M4)

- [ ] Add capability validation middleware to beehive router
- [ ] Validate `X-Service-ID` header matches token claims
- [ ] Check action-specific capabilities
- [ ] Return 401/403 for unauthorized requests

---

## User-Facing Features

- [ ] Polyrepo: Auto-register service on repo creation
- [ ] Monorepo: Parse `beehive.yml` service definitions
- [ ] CLI: `beehive service register` command
- [ ] CLI: `beehive service token generate` command
- [ ] UI: Service list in repo dashboard
- [ ] UI: Capability editor for services

---

## Migration Tasks

- [ ] Audit existing repos for service boundaries
- [ ] Auto-register services based on worker bindings
- [ ] Generate new scoped tokens for each service
- [ ] Update CI workflows to use scoped tokens
- [ ] Phase out repo-wide tokens
- [ ] Document migration process

---

## Testing

- [ ] Unit tests for service registration
- [ ] Unit tests for capability validation
- [ ] Integration test: polyrepo service deployment
- [ ] Integration test: monorepo service deployment
- [ ] Integration test: cross-service capability check
- [ ] E2E test: full PR flow with service isolation

---

## Documentation

- [ ] Update main README with OCAP CI overview
- [ ] Add security section to docs
- [ ] Create quick-start guide (see OCAP-CI-QUICK-START.md)
- [ ] Add troubleshooting guide
- [ ] Update API documentation

---

## Dependencies

- [ ] Spec DO schema migration system (M2 complete)
- [ ] Gate workflow refactoring
- [ ] Cloudflare OIDC integration (optional)
- [ ] Worker-to-Worker auth

---

## Blockers

- [ ] #OCAP-1: Finalize token format and claims
- [ ] #OCAP-2: Decide on token storage strategy
- [ ] #OCAP-3: Design capability inheritance model (none vs explicit only)
- [ ] #OCAP-4: Handle cross-service dependencies

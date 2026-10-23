# Custom Request Types Implementation Plan

**Task:** custom-request-types-plan | **Spec:** AGENTS.md#working-conventions, AGENTS-REVIEWER.md | **Date:** 2026-10-19
**Author:** subagent/planner | **Status:** Draft for review

---

## 1. Problem Statement

Currently, handlers in `workers/api/index.ts` receive plain `Request` objects and must trust that:
- Authentication has already passed (via `authenticate()` returning `Principal`)
- Authorization has already passed (via `authorize()`)
- The `X-Actor-ID` header has been rewritten to `principal.actorId` for non-master principals

This is **runtime validation only**. There is no compile-time guarantee that a handler requires auth. A handler could omit checks and still type-check, leading to security gaps that are only caught at runtime.

The "validate by parsing" principle suggests we should encode these invariants in the type system itself.

---

## 2. Goals

1. **Compile-time safety**: Handlers that require authentication must receive a request type that proves auth passed
2. **Actor guarantee**: Handlers that need an actor receive a request with a validated `actorId`
3. **Scope guarantee**: Handlers that need specific scopes receive a request with those scopes
4. **Zero runtime overhead**: Type-level only; no additional runtime checks
5. **Backward compatible**: Existing code continues to work; migration is incremental

---

## 3. Design: Custom Request Types

### 3.1 Type Definitions (`workers/api/types.ts`)

```typescript
// Base authenticated request - carries a validated Principal
export interface AuthedRequest extends Request {
  principal: Principal;
}

// Request with a guaranteed actorId (for handlers that need actor context)
export interface ActorRequest extends AuthedRequest {
  actorId: string;  // Extracted from principal.actorId
}

// Request with scope guarantees
export interface ReadRequest extends ActorRequest {
  // Compile-time proof that 'read' scope is present
  scopes: Principal['scopes'] & ['read', ...Principal['scopes']];
}

export interface WriteRequest extends ActorRequest {
  scopes: Principal['scopes'] & ['write', ...Principal['scopes']];
}

export interface MaintainerRequest extends ActorRequest {
  scopes: Principal['scopes'] & ['maintainer', ...Principal['scopes']];
}
```

### 3.2 Wrapper Helpers (`workers/api/principal.ts`)

```typescript
// Transform a plain Request + Principal into an AuthedRequest
export function withAuth(request: Request, principal: Principal): AuthedRequest {
  return Object.assign(request, { principal }) as AuthedRequest;
}

// Transform into ActorRequest (guarantees actorId exists)
export function withActor(request: Request, principal: Principal): ActorRequest {
  if (!principal.actorId) {
    throw new Error('ActorRequest requires actorId');
  }
  return Object.assign(request, {
    principal,
    actorId: principal.actorId
  }) as ActorRequest;
}

// Scope-checked wrappers
export function withReadScope(req: AuthedRequest): ReadRequest | Response {
  if (!req.principal.scopes.includes('read')) {
    return jsonError('Forbidden', 403);
  }
  return Object.assign(req, {
    scopes: req.principal.scopes as ['read', ...Principal['scopes']]
  }) as ReadRequest;
}

export function withWriteScope(req: AuthedRequest): WriteRequest | Response {
  if (!req.principal.scopes.includes('write')) {
    return jsonError('Forbidden', 403);
  }
  return Object.assign(req, {
    scopes: req.principal.scopes as ['write', ...Principal['scopes']]
  }) as WriteRequest;
}

export function withMaintainerScope(req: AuthedRequest): MaintainerRequest | Response {
  if (!req.principal.scopes.includes('maintainer')) {
    return jsonError('Forbidden', 403);
  }
  return Object.assign(req, {
    scopes: req.principal.scopes as ['maintainer', ...Principal['scopes']]
  }) as MaintainerRequest;
}
```

### 3.3 Handler Type Signatures

**Before:**
```typescript
async function handleCreateOrganization(request: Request, stub: SpecDoStub): Promise<Response>
```

**After:**
```typescript
async function handleCreateOrganization(request: WriteRequest, stub: SpecDoStub): Promise<Response>
```

The type signature itself documents the requirement. If `handleCreateOrganization` is called with a plain `Request`, TypeScript errors.

---

## 4. Migration Strategy

### Phase 1: Type Definitions (Non-breaking)
- Add type definitions to `workers/api/types.ts`
- Add wrapper helpers to `workers/api/principal.ts`
- No changes to existing handlers
- **Verification:** `npm run typecheck` passes

### Phase 2: Edge Router Wrapper (Single Point of Truth)
- In `workers/api/index.ts`, after `authenticate()` and `authorize()` pass, wrap the request:
```typescript
// After line 100 (actor rewrite)
const authedRequest = withAuth(request, principal);
const actorRequest = withActor(authedRequest, principal);
```
- Pass `actorRequest` to handlers instead of `request`
- **Verification:** All existing handlers still work (they receive objects that duck-type as `Request`)

### Phase 3: Incremental Handler Migration
- Migrate handlers one at a time, updating signatures from `Request` to appropriate custom type
- Order by risk/criticality:
  1. Write handlers first (highest risk if auth bypassed)
  2. Read handlers
  3. Admin handlers (maintainer scope)
- For each handler:
  - Update signature: `Request → WriteRequest` (or appropriate)
  - Remove redundant runtime checks (they're now type-guaranteed)
  - Add scope checks in wrapper if not already in `authorize()`
- **Verification:** `npm run typecheck` catches any handler missing auth

### Phase 4: Remove Runtime Redundancy
- Once all handlers in a category are migrated, remove corresponding runtime checks
- Keep `authenticate()` and `authorize()` at edge level (defense in depth)
- **Verification:** Tests pass, no regression

---

## 5. File-by-File Changes

### `workers/shared/principal.ts`
- Add type exports: `AuthedRequest`, `ActorRequest`, `ReadRequest`, `WriteRequest`, `MaintainerRequest`
- Add helper functions: `withAuth`, `withActor`, `withReadScope`, `withWriteScope`, `withMaintainerScope`

### `workers/api/types.ts`
- Add interface definitions (if not in shared/principal.ts)

### `workers/api/index.ts`
- Import wrapper helpers
- After auth/authorization, wrap request before passing to handlers
- Update handler calls to pass wrapped request

### Handler files (incremental)
- `workers/api/lifecycle.ts`: Update to use `MaintainerRequest` for maintainer-only routes
- `workers/api/user-tokens.ts`: Update to use `WriteRequest` or `MaintainerRequest`
- `workers/api/service-accounts.ts`: Update to use `WriteRequest`
- `workers/api/index.ts` handlers: Update signatures incrementally

---

## 6. Testing Strategy

### Phase Verification Commands
- **Phase 1 (Types only):** `npm run typecheck` (Expected: PASS)
- **Phase 2 (Edge wrapper):** `npm run typecheck` + `npm test` (Expected: PASS)
- **Phase 3 (Handler migration):** `npm run typecheck` per handler (Expected: FAIL if handler signature doesn't match required type)
- **Phase 4 (Cleanup):** Full test suite: `npm run typecheck` + `npm test` + `npm run test:e2e:local` (Expected: PASS)

### Unit Tests
- Add tests for wrapper functions (happy path and error cases)
- Verify type narrowing works correctly

### Type Tests
- Add `.test-d.ts` files to verify type errors are caught:
```typescript
// This should fail to type-check
declare function handleOrg(request: Request): Response;
handleOrg(plainRequest); // Error: Request is not AuthedRequest
```

### Integration Tests
- Verify existing e2e tests still pass
- Add tests that verify handlers reject unauthenticated calls at type level (if possible with TS compile-time checks)

---

## 7. Rollback Plan

- All changes are additive until Phase 3
- Phase 3 changes are per-handler; can revert individual handler migrations
- Edge router wrapper can be bypassed by passing original `request`
- Full rollback: revert to `origin/main`

---

## 8. Acceptance Criteria

- [ ] Type definitions compile without errors
- [ ] Wrapper functions pass unit tests
- [ ] `npm run typecheck` passes on main branch
- [ ] All existing tests pass
- [ ] At least 50% of handlers migrated to custom request types
- [ ] No runtime overhead (verified by comparing before/after performance)
- [ ] Type-level auth bypass is a compile-time error (verified with test-d.ts)

---

## 9. Decisions

1. **Type vs Interface**: Use `type` for custom request types. Types are more flexible for unions and intersection types which we need for scope hierarchies.

2. **Branding**: **Use branded types** to prevent accidental mixing of request types. This ensures compile-time safety:
   ```typescript
   declare const AuthedRequestBrand: unique symbol;
   export type AuthedRequest = Request & { [AuthedRequestBrand]: never };
   ```

3. **Handler grouping**: Defer. Start with base types (`AuthedRequest`, `ActorRequest`, scope types). Add domain-specific types only if needed.

4. **Error handling**: Wrapper functions return `Response` on failure (current approach). Maintains fail-closed behavior and consistent error handling.

5. **Scope hierarchy**: **Keep scope checks in `authorize()`** (defense in depth). Wrappers only assert, never enforce. This maintains existing runtime validation while adding compile-time safety.

---

## 10. Related Work

- AGENTS.md: "Validate by parsing" principle (working conventions)
- AGENTS-REVIEWER.md: Review standards for this implementation
- M12-IMPL-PLAN.md: Principal and authorization patterns
- `workers/api/principal.ts`: Current authentication/authorization logic

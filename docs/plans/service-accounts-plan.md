# Service Accounts Implementation Plan

> **Document ID:** SERVICE-ACCOUNTS-PLAN-V1  
> **Created:** 2026-10-14  
> **Status:** Draft  
> **Priority:** High (Blocked by FOCUS.md Item 5)  
> **Related:** FOCUS.md Section 5, specs/pre-merge-gate-v1.json  

---

## Executive Summary

Implement **Service Accounts** as first-class actors in the Spec DO to replace the single shared `API_AUTH_TOKEN` across all 10 workers and tooling. Service accounts enable:

- Per-caller authentication (synthetic monitoring, E2E tests, CI/CD)
- Fine-grained authorization via scopes
- Token lifecycle management (create, list, revoke)
- Auditability (token resolves to specific actor)
- Revocation without redeploying workers

---

## Current State Problems

1. **Single credential**: All 10 workers share one `API_AUTH_TOKEN` secret
2. **No attribution**: `X-Actor-ID` header is user-supplied; any holder can impersonate any actor
3. **No revocation**: Compromised token requires redeploying all workers with new secret
4. **No scoping**: E2E tests pollute production ledger; no way to restrict by scope
5. **Plaintext storage**: Token is stored in Worker secrets (encrypted at rest by CF, but visible in wrangler)

---

## Requirements (from FOCUS.md)

### Must Have

- [ ] Service account = actor in Spec DO with its own token
- [ ] Only token hash stored in Spec DO; plaintext shown once at creation
- [ ] Create, list, revoke routes accept only master `API_AUTH_TOKEN` (Bailey-only)
- [ ] Service token resolves to its actor; `X-Actor-ID` ignored for those requests
- [ ] Scopes: `read` for synthetic monitoring, `write` for E2E
- [ ] No promotion authority unless explicitly granted
- [ ] Keep `authGate` master-token checks for worker-to-worker calls
- [ ] Switch `health-check.sh`, `synthetic-monitoring-enhanced.sh` and E2E to service tokens

### Should Have

- [ ] Token expiration (TTL)
- [ ] Token rotation support
- [ ] Rate limiting per service account
- [ ] Usage audit logging

### Constraints

- `actors.type` CHECK constraint allows only `'human'`/`'agent'` — adding `'service'` requires schema migration
- Migration must not break existing actors table
- E2E accounts must write only to dedicated test org (prevent production ledger pollution)

---

## Architecture Overview

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         API Request Flow                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────────┐              │
│  │  Client   │───▶│ authMiddleware│───▶│ Route Handler   │              │
│  └──────────┘    └──────────────┘    └─────────────────┘              │
│                         │                                         │
│                         ▼                                         │
│              ┌──────────────────────────┐                              │
│              │   Token Validation        │                              │
│              │   - Check Bearer token    │                              │
│              │   - Check X-API-Token      │                              │
│              │   - Resolve token hash    │                              │
│              │   - Verify scopes         │                              │
│              └──────────────┬───────────┘                              │
│                         │                                         │
│                         ▼                                         │
│              ┌──────────────────────────┐                              │
│              │   Spec DO Lookup          │                              │
│              │   - service_tokens table  │                              │
│              │   - actors table          │                              │
│              │   - scope verification    │                              │
│              └──────────────────────────┘                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Model

#### Option A: Extend actors table (Schema Migration Required)

**Pros**: Unified actor model, single query for resolution  
**Cons**: CHECK constraint migration, requires table rebuild  

```sql
-- ALTER TABLE actors to add service type
ALTER TABLE actors 
  MODIFY type TEXT NOT NULL CHECK(type IN ('human', 'agent', 'service'));

-- Add service_accounts table for token hashes
CREATE TABLE IF NOT EXISTS service_accounts (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL, -- bcrypt or argon2
  scopes TEXT NOT NULL, -- JSON array: ['read'], ['write'], ['read', 'write'], ['admin']
  created_at INTEGER NOT NULL,
  expires_at INTEGER, -- Optional TTL
  created_by TEXT NOT NULL, -- Actor ID of creator (must be human with promotion_authority)
  is_active BOOLEAN DEFAULT TRUE,
  FOREIGN KEY (actor_id) REFERENCES actors(id),
  FOREIGN KEY (created_by) REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_service_accounts_token_hash ON service_accounts(token_hash);
CREATE INDEX IF NOT EXISTS idx_service_accounts_actor ON service_accounts(actor_id);
CREATE INDEX IF NOT EXISTS idx_service_accounts_active ON service_accounts(is_active) WHERE is_active = TRUE;
```

#### Option B: Separate service_tokens table (No Schema Migration)

**Pros**: No CHECK constraint changes, backward compatible  
**Cons**: Token resolution requires JOIN or separate lookup  

```sql
-- Service tokens as separate entities
CREATE TABLE IF NOT EXISTS service_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL, -- JSON: ['read'] | ['write'] | ['read', 'write']
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_by TEXT NOT NULL, -- Actor ID (human)
  is_active BOOLEAN DEFAULT TRUE
);

-- Link to actor via separate table or virtual relationship
CREATE TABLE IF NOT EXISTS service_token_actors (
  token_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  PRIMARY KEY (token_id, actor_id),
  FOREIGN KEY (token_id) REFERENCES service_tokens(id),
  FOREIGN KEY (actor_id) REFERENCES actors(id)
);
```

**Decision**: **Option B** - Separate `service_tokens` table
- Zero downtime migration
- No schema rebuild required
- Clear separation of concerns
- Easier to extend later

---

## Token Schema

### Service Token Object

```typescript
interface ServiceToken {
  id: string;                    // UUID v4
  name: string;                  // Human-readable identifier (e.g., "synthetic-monitor")
  tokenHash: string;             // bcrypt hash of the actual token
  scopes: ServiceTokenScope[];   // Array of granted scopes
  createdAt: number;             // Unix timestamp (ms)
  expiresAt?: number;            // Optional expiration timestamp (ms)
  createdBy: string;             // Actor ID of the creator
  isActive: boolean;             // Soft delete flag
}

type ServiceTokenScope = 'read' | 'write' | 'admin' | 'promote';
```

### Token Generation

```typescript
// In Spec DO or separate service
function generateServiceToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = await bcrypt.hash(token, 12);
  return { token, hash };
}
```

### Token Format

- **Length**: 43 characters (32 bytes base64url encoded)
- **Encoding**: URL-safe base64
- **Prefix**: `svc_` for easy identification (e.g., `svc_abc123...`)
- **Entropy**: 256 bits (cryptographically secure)

---

## Hashing Strategy

### Algorithm Selection

| Algorithm | Pros | Cons | Decision |
|-----------|------|------|----------|
| bcrypt | Battle-tested, adaptive work factor | Slow, not designed for API tokens | **NO** |
| Argon2id | Modern, memory-hard, OWASP recommended | Not in CF Workers runtime | **NO** |
| SHA-256 | Fast, available in Workers | Not salted, vulnerable to rainbow tables | **NO** |
| PBKDF2 | NIST approved, available in Workers | Requires iteration count tuning | **YES** |
| scrypt | Memory-hard, designed for passwords | Not available in Workers | **NO** |

**Decision**: **PBKDF2-HMAC-SHA256**
- Available in Cloudflare Workers via `crypto.subtle`
- NIST SP 800-63B approved
- Configurable iteration count and salt

### Implementation

```typescript
import { randomBytes } from 'crypto';

async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = randomBytes(16);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(token),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  
  const hashArray = Array.from(new Uint8Array(derivedBits));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  // Store as: algorithm$iterations$salt$hash
  return `pbkdf2-sha256$100000$${salt.toString('base64')}$${hashHex}`;
}

async function verifyTokenHash(token: string, storedHash: string): Promise<boolean> {
  const [algorithm, iterationsStr, saltB64, hashHex] = storedHash.split('$');
  const salt = Buffer.from(saltB64, 'base64');
  const iterations = parseInt(iterationsStr, 10);
  
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(token),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  
  const computedHash = Array.from(new Uint8Array(derivedBits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  return computedHash === hashHex;
}
```

---

## Routes

### REST API Endpoints

All service account routes are **master-token protected** (only `API_AUTH_TOKEN` holders can access).

#### Base Path: `/api/service-accounts`

| Method | Endpoint | Description | Request Body | Response | Auth |
|--------|----------|-------------|--------------|----------|------|
| POST | `/api/service-accounts` | Create service account | `{name, scopes}` | `ServiceTokenResponse` | Master token |
| GET | `/api/service-accounts` | List all service accounts | - | `ServiceTokenListResponse` | Master token |
| GET | `/api/service-accounts/:id` | Get service account details | - | `ServiceTokenDetailsResponse` | Master token |
| DELETE | `/api/service-accounts/:id` | Revoke service account | - | `SuccessResponse` | Master token |
| PATCH | `/api/service-accounts/:id/scopes` | Update scopes | `{scopes}` | `ServiceTokenResponse` | Master token |
| PATCH | `/api/service-accounts/:id/expires-at` | Update expiration | `{expiresAt}` | `ServiceTokenResponse` | Master token |

### Request/Response Schemas

```typescript
// Request types
interface CreateServiceAccountRequest {
  name: string;
  scopes: ServiceTokenScope[];
  expiresAt?: number; // Unix timestamp (ms)
}

interface UpdateServiceAccountScopesRequest {
  scopes: ServiceTokenScope[];
}

interface UpdateServiceAccountExpirationRequest {
  expiresAt?: number; // Set to undefined to remove expiration
}

// Response types
interface ServiceTokenResponse {
  id: string;
  name: string;
  scopes: ServiceTokenScope[];
  createdAt: number;
  expiresAt?: number;
  createdBy: string;
  isActive: boolean;
  token: string; // Plaintext token - ONLY returned on creation
}

interface ServiceTokenDetailsResponse {
  id: string;
  name: string;
  scopes: ServiceTokenScope[];
  createdAt: number;
  expiresAt?: number;
  createdBy: string;
  isActive: boolean;
  // NO token field - never returned after creation
}

interface ServiceTokenListResponse {
  serviceAccounts: ServiceTokenDetailsResponse[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

interface SuccessResponse {
  success: boolean;
  message: string;
}
```

### Zod Schemas (for validation)

```typescript
import { z } from 'zod';

export const ServiceTokenScopeSchema = z.enum(['read', 'write', 'admin', 'promote']);

export const CreateServiceAccountRequestSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ServiceTokenScopeSchema).min(1),
  expiresAt: z.number().int().positive().optional(),
});

export const UpdateServiceAccountScopesRequestSchema = z.object({
  scopes: z.array(ServiceTokenScopeSchema).min(1),
});

export const UpdateServiceAccountExpirationRequestSchema = z.object({
  expiresAt: z.number().int().positive().optional(),
});

export const ServiceTokenResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  scopes: z.array(ServiceTokenScopeSchema),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive().optional(),
  createdBy: z.string().uuid(),
  isActive: z.boolean(),
  token: z.string(),
});

export const ServiceTokenDetailsResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  scopes: z.array(ServiceTokenScopeSchema),
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive().optional(),
  createdBy: z.string().uuid(),
  isActive: z.boolean(),
});
```

---

## Authentication Middleware

### Middleware Chain

```
Request
  │
  ▼
┌─────────────────────┐
│ Extract Token        │  ← Bearer or X-API-Token header
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Validate Token       │  ← Check hash against Spec DO
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Resolve Actor        │  ← Map token to actor_id
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Check Scopes         │  ← Verify required scope for route
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Check Expiration     │  ← Token not expired
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Check Active         │  ← Token not revoked
└──────────┬──────────┘
           │
           ▼
         Route Handler
```

### Implementation

#### 1. Extended Auth Environment

```typescript
// workers/shared/auth.ts
export interface AuthEnv {
  API_AUTH_TOKEN?: string;
  SPEC_DO: DurableObjectNamespace;
}

export interface AuthContext {
  actorId: string | null;
  actorType: 'human' | 'agent' | 'service' | null;
  scopes: ServiceTokenScope[];
  isServiceToken: boolean;
}
```

#### 2. Token Resolution Function

```typescript
// In Spec DO (spec-do/index.ts)
async function resolveServiceToken(token: string): Promise<ServiceTokenRow | null> {
  const stmt = this.db.prepare(
    `SELECT * FROM service_tokens WHERE token_hash = ? AND is_active = TRUE`
  );
  const hash = await hashToken(token);
  return stmt.get(hash) as ServiceTokenRow | null;
}

async function getActorForToken(token: string): Promise<ActorRow | null> {
  const serviceToken = await this.resolveServiceToken(token);
  if (serviceToken) {
    const stmt = this.db.prepare(
      `SELECT * FROM actors WHERE id = (
        SELECT actor_id FROM service_token_actors 
        WHERE token_id = ?
      )`
    );
    return stmt.get(serviceToken.id) as ActorRow | null;
  }
  return null;
}
```

#### 3. Enhanced Auth Gate

```typescript
// workers/shared/auth.ts
import { hashToken, verifyTokenHash } from '../shared/crypto';

export interface ExtendedAuthEnv extends AuthEnv {
  SPEC_DO: DurableObjectNamespace;
}

/**
 * Enhanced auth gate that supports service tokens
 * Returns Response if unauthorized, or AuthContext if authorized
 */
export async function enhancedAuthGate(
  request: Request,
  env: ExtendedAuthEnv
): Promise<{ context: AuthContext } | Response> {
  // 1. Try master token (for backward compatibility)
  const masterResponse = authGate(request, env);
  if (masterResponse === null) {
    // Master token valid - check if it's a service account creation route
    return { 
      context: { 
        actorId: null, 
        actorType: null, 
        scopes: ['admin', 'promote', 'read', 'write'], // Master has all scopes
        isServiceToken: false 
      } 
    };
  }

  // 2. Try to extract token from headers
  const token = extractBearerToken(request) || request.headers.get('X-API-Token');
  if (!token) {
    return jsonError('Unauthorized - No token provided', 401);
  }

  // 3. Resolve token via Spec DO
  const specDoId = env.SPEC_DO.idFromName('main');
  const specDoStub = env.SPEC_DO.get(specDoId);
  
  try {
    const resolveRequest = new Request(`https://spec-do.internal/resolve-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    
    const response = await specDoStub.fetch(resolveRequest);
    
    if (response.status !== 200) {
      return jsonError('Unauthorized - Invalid token', 401);
    }
    
    const result = await response.json() as {
      serviceToken?: ServiceTokenRow;
      actor?: ActorRow;
      scopes: ServiceTokenScope[];
    };
    
    if (!result.serviceToken || !result.actor) {
      return jsonError('Unauthorized - Token not found', 401);
    }
    
    // 4. Check expiration
    if (result.serviceToken.expiresAt && 
        result.serviceToken.expiresAt < Date.now()) {
      return jsonError('Unauthorized - Token expired', 401);
    }
    
    return {
      context: {
        actorId: result.actor.id,
        actorType: result.actor.type,
        scopes: result.scopes,
        isServiceToken: true,
      },
    };
  } catch (error) {
    console.error('Auth resolution error:', error);
    return jsonError('Unauthorized - Authentication failed', 401);
  }
}

/**
 * Middleware to require specific scopes
 */
export function requireScopes(scopes: ServiceTokenScope[]): (ctx: AuthContext) => boolean {
  return (ctx: AuthContext) => {
    if (!ctx.isServiceToken) {
      // Master token has all scopes
      return true;
    }
    return scopes.every(required => ctx.scopes.includes(required));
  };
}

/**
 * Route handler wrapper that enforces auth
 */
export function withAuth(
  handler: (request: Request, env: ExtendedAuthEnv, ctx: AuthContext) => Promise<Response>,
  requiredScopes?: ServiceTokenScope[]
) {
  return async (request: Request, env: ExtendedAuthEnv) => {
    const authResult = await enhancedAuthGate(request, env);
    
    if (authResult instanceof Response) {
      return authResult;
    }
    
    if (requiredScopes && !requireScopes(requiredScopes)(authResult.context)) {
      return jsonError('Forbidden - Insufficient scopes', 403);
    }
    
    return handler(request, env, authResult.context);
  };
}
```

#### 4. Spec DO Token Resolution Endpoint

```typescript
// In spec-do/index.ts
async function handleResolveToken(request: Request): Promise<Response> {
  const { token } = await request.json() as { token: string };
  
  // Hash the provided token
  const hash = await hashToken(token);
  
  // Find service token by hash
  const stmt = this.db.prepare(
    `SELECT * FROM service_tokens WHERE token_hash = ? AND is_active = TRUE`
  );
  const serviceToken = stmt.get(hash) as ServiceTokenRow | null;
  
  if (!serviceToken) {
    return new Response(JSON.stringify({ success: false }), { 
      status: 404, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
  
  // Check expiration
  if (serviceToken.expiresAt && serviceToken.expiresAt < Date.now()) {
    return new Response(JSON.stringify({ success: false, error: 'expired' }), { 
      status: 401, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
  
  // Get actor
  const actorStmt = this.db.prepare(
    `SELECT a.* FROM actors a 
     JOIN service_token_actors sta ON a.id = sta.actor_id 
     WHERE sta.token_id = ?`
  );
  const actor = actorStmt.get(serviceToken.id) as ActorRow | null;
  
  if (!actor) {
    return new Response(JSON.stringify({ success: false }), { 
      status: 404, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
  
  return new Response(
    JSON.stringify({
      success: true,
      serviceToken: {
        id: serviceToken.id,
        name: serviceToken.name,
        scopes: JSON.parse(serviceToken.scopes),
        createdAt: serviceToken.created_at,
        expiresAt: serviceToken.expires_at,
      },
      actor: {
        id: actor.id,
        type: actor.type,
        name: actor.name,
        promotionAuthority: actor.promotion_authority,
      },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
```

---

## Scopes Design

### Scope Hierarchy

```
admin
  └── promote
      └── write
          └── read
```

### Scope Definitions

| Scope | Description | Allowed Actions |
|-------|-------------|-----------------|
| `read` | Read-only access | GET any resource, list entities |
| `write` | Read + Write | All read actions + POST/PATCH (non-destructive) |
| `promote` | Write + Promotion | All write actions + promotion authority |
| `admin` | Full access | All actions including creating service accounts |

### Scope Requirements by Route

#### Organizations
| Method | Endpoint | Required Scope |
|--------|----------|----------------|
| GET | `/api/organizations` | `read` |
| POST | `/api/organizations` | `admin` |
| GET | `/api/organizations/:id` | `read` |

#### Actors
| Method | Endpoint | Required Scope |
|--------|----------|----------------|
| GET | `/api/actors` | `read` |
| POST | `/api/actors` | `admin` |
| PATCH | `/api/actors/:id/trust` | `promote` |
| PATCH | `/api/actors/:id/promotion-authority` | `admin` |

#### Service Accounts (Master Token Only)
| Method | Endpoint | Required Scope |
|--------|----------|----------------|
| All | `/api/service-accounts/**` | Master token only |

#### Repositories
| Method | Endpoint | Required Scope |
|--------|----------|----------------|
| GET | `/api/repositories` | `read` |
| POST | `/api/repositories` | `write` |
| GET | `/api/repositories/:id` | `read` |

#### Specs
| Method | Endpoint | Required Scope |
|--------|----------|----------------|
| GET | `/api/specs` | `read` |
| POST | `/api/specs` | `write` |
| PATCH | `/api/specs/:id/stage` | `write` |
| POST | `/api/specs/:id/claim` | `write` |

#### Candidates
| Method | Endpoint | Required Scope |
|--------|----------|----------------|
| GET | `/api/candidates` | `read` |
| POST | `/api/candidates` | `write` |
| PATCH | `/api/candidates/:id/stage` | `write` |

#### Gate Verdicts
| Method | Endpoint | Required Scope |
|--------|----------|----------------|
| GET | `/api/gate-verdicts` | `read` |
| POST | `/api/gate-verdicts` | `write` |
| POST | `/api/candidates/:id/gate/pre-merge` | `write` |

#### Trials
| Method | Endpoint | Required Scope |
|--------|----------|----------------|
| GET | `/api/trials` | `read` |
| POST | `/api/trials` | `write` |
| POST | `/api/trials/:id/decide` | `promote` |

#### Promotions
| Method | Endpoint | Required Scope |
|--------|----------|----------------|
| GET | `/api/promotions` | `read` |
| POST | `/api/promotions` | `promote` |

#### Issues
| Method | Endpoint | Required Scope |
|--------|----------|----------------|
| GET | `/api/issues` | `read` |
| POST | `/api/issues` | `write` |
| PATCH | `/api/issues/:id/stage` | `write` |
| PATCH | `/api/issues/:id/comment-policy` | `write` |
| POST | `/api/issues/:id/comments` | `write` |

### Test Organization Constraint

E2E test service accounts must be restricted to a **dedicated test organization** to prevent production ledger pollution.

```typescript
// In middleware
function checkTestOrgConstraint(ctx: AuthContext, orgId: string): boolean {
  if (!ctx.isServiceToken) return true; // Non-service tokens not restricted
  
  // Check if this service account is for E2E
  const isE2EAccount = ctx.actorId?.startsWith('svc-e2e-');
  if (!isE2EAccount) return true;
  
  // E2E accounts can only access test org
  const TEST_ORG_ID = 'org-test-e2e';
  return orgId === TEST_ORG_ID;
}
```

---

## Implementation Phases

### Phase 1: Foundation (High Priority)

**Goal**: Core infrastructure for service accounts

1. **Add service_tokens table to Spec DO schema**
   - File: `workers/spec-do/schema.sql`
   - Add migration script for existing deployments
   
2. **Add service_token_actors join table**
   - Link tokens to actors
   
3. **Implement hashing utility**
   - File: `workers/shared/crypto.ts`
   - PBKDF2-HMAC-SHA256 implementation
   
4. **Add Spec DO methods**
   - `createServiceToken()`
   - `getServiceTokenByHash()`
   - `listServiceTokens()`
   - `revokeServiceToken()`
   - `updateServiceTokenScopes()`
   - `resolveTokenToActor()`

**Deliverables**:
- [ ] Schema migration
- [ ] Hashing functions
- [ ] Spec DO storage layer

---

### Phase 2: API Routes (High Priority)

**Goal**: REST API for service account management

1. **Add types**
   - File: `workers/api/types.ts`
   - Service token request/response interfaces
   - Zod schemas
   
2. **Add API routes**
   - File: `workers/api/index.ts`
   - POST `/api/service-accounts`
   - GET `/api/service-accounts`
   - GET `/api/service-accounts/:id`
   - DELETE `/api/service-accounts/:id`
   - PATCH `/api/service-accounts/:id/scopes`
   - PATCH `/api/service-accounts/:id/expires-at`

3. **Add route handlers**
   - Master token validation for all service account routes
   - Create service token with actor
   - List with pagination
   - Revoke (soft delete)
   - Update scopes/expiration

**Deliverables**:
- [ ] Type definitions
- [ ] API routes
- [ ] Route handlers

---

### Phase 3: Auth Middleware (High Priority)

**Goal**: Token validation and scope checking

1. **Enhanced auth gate**
   - File: `workers/shared/auth.ts`
   - Support service tokens alongside master token
   - Token resolution via Spec DO
   
2. **Scope middleware**
   - File: `workers/shared/auth.ts`
   - `requireScopes()` function
   - `withAuth()` wrapper
   
3. **Spec DO token resolution endpoint**
   - Internal endpoint for token validation
   - Returns actor + scopes

**Deliverables**:
- [ ] Enhanced auth gate
- [ ] Scope checking
- [ ] Token resolution

---

### Phase 4: Migration (Medium Priority)

**Goal**: Migrate existing tooling to service accounts

1. **Create service accounts for existing use cases**
   - Synthetic monitoring: `synthetic-monitor` with `read` scope
   - E2E tests: `e2e-tester` with `write` scope (test org only)
   - Health checks: `health-check` with `read` scope
   - CI/CD: `ci-cd` with `write` scope
   
2. **Update scripts**
   - `scripts/health-check.sh`: Use service token
   - `scripts/synthetic-monitoring-enhanced.sh`: Use service token
   - E2E test suite: Use service token
   
3. **Update documentation**
   - README.md: Service account setup
   - Docs: Token management guide

**Deliverables**:
- [ ] Service accounts created
- [ ] Scripts updated
- [ ] Documentation updated

---

### Phase 5: Cleanup & Security (Medium Priority)

**Goal**: Security hardening and cleanup

1. **Deprecate plaintext token storage**
   - Remove `API_AUTH_TOKEN` from worker-to-worker auth
   - Use service tokens for inter-worker communication
   
2. **Add audit logging**
   - Log token usage (who, when, which endpoint)
   - Log creation/revocation events
   
3. **Add rate limiting**
   - Per-service-account rate limits
   - Global rate limits

**Deliverables**:
- [ ] Audit logging
- [ ] Rate limiting

---

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `workers/spec-do/schema.sql` | Add | Service tokens tables |
| `workers/spec-do/index.ts` | Modify | Add token CRUD methods |
| `workers/spec-do/schema-inline.ts` | Modify | Inline schema update |
| `workers/shared/crypto.ts` | New | PBKDF2 hashing |
| `workers/shared/auth.ts` | Modify | Enhanced auth gate |
| `workers/api/types.ts` | Modify | Add service token types |
| `workers/api/index.ts` | Modify | Add service account routes |
| `scripts/health-check.sh` | Modify | Use service token |
| `scripts/synthetic-monitoring-enhanced.sh` | Modify | Use service token |
| `docs/plans/service-accounts-plan.md` | New | This document |

---

## Database Migration

### For New Deployments

The schema includes the new tables from day one. No migration needed.

### For Existing Deployments

```sql
-- Run in Spec DO on startup if tables don't exist
CREATE TABLE IF NOT EXISTS service_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_by TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS service_token_actors (
  token_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  PRIMARY KEY (token_id, actor_id),
  FOREIGN KEY (token_id) REFERENCES service_tokens(id),
  FOREIGN KEY (actor_id) REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_service_tokens_token_hash 
  ON service_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_service_tokens_active 
  ON service_tokens(is_active) WHERE is_active = TRUE;
```

---

## Testing Strategy

### Unit Tests

1. **Hashing tests**
   - Same token produces same hash
   - Different tokens produce different hashes
   - Verify hash against stored value
   
2. **Auth middleware tests**
   - Master token still works
   - Valid service token works
   - Invalid service token rejected
   - Expired token rejected
   - Revoked token rejected
   - Scope checking works
   
3. **API route tests**
   - Create service account (master token only)
   - List service accounts
   - Get service account
   - Revoke service account
   - Update scopes
   - Update expiration

### Integration Tests

1. **End-to-end flow**
   - Create service account
   - Use token to access API
   - Verify scope restrictions
   - Revoke and verify access denied
   
2. **Inter-worker auth**
   - Worker-to-worker with service tokens
   - Worker-to-worker with master token (backward compat)

### E2E Tests

1. **Script validation**
   - health-check.sh with service token
   - synthetic-monitoring-enhanced.sh with service token

---

## Rollback Plan

If issues arise:

1. **Feature flag**: Add `ENABLE_SERVICE_ACCOUNTS` environment variable
   - Default: `false` (disabled)
   - When `true`: Enable service account auth
   - When `false`: Fall back to master token only
   
2. **Database**: Service tokens are in separate tables
   - Can be dropped without affecting existing data
   - No schema changes to existing tables
   
3. **Scripts**: Maintain backward compatibility
   - Support both `API_AUTH_TOKEN` and service tokens
   - Environment variable fallback

---

## Security Considerations

### Token Security

1. **Never store plaintext**: Only hash stored in database
2. **Never log tokens**: Mask in all logs
3. **One-time display**: Token shown only at creation
4. **Secure generation**: 256 bits of entropy

### Access Control

1. **Master token**: Only for service account management
2. **Service tokens**: Limited by scopes
3. **Test org isolation**: E2E tokens restricted
4. **Audit trail**: All actions logged

### Rate Limiting

1. **Per-token limits**: Prevent abuse
2. **Global limits**: Protect infrastructure
3. **Burst protection**: Handle spikes

---

## Success Criteria

- [ ] All 10 workers still pass health checks
- [ ] Service accounts can be created via API (master token only)
- [ ] Service tokens work for API access
- [ ] Scopes are enforced correctly
- [ ] Token revocation works immediately
- [ ] Scripts use service tokens instead of master token
- [ ] No production ledger pollution from E2E
- [ ] All existing tests pass
- [ ] New tests added for service accounts

---

## Next Steps

1. **Implement Phase 1**: Schema and hashing
2. **Implement Phase 2**: API routes
3. **Implement Phase 3**: Auth middleware
4. **Test**: Unit and integration tests
5. **Migrate**: Update scripts to use service tokens
6. **Deploy**: Push to main, verify in production
7. **Document**: Update docs for users

---

## References

- FOCUS.md Section 5: Service Accounts
- workers/spec-do/schema.sql: Current database schema
- workers/shared/auth.ts: Current auth implementation
- workers/api/index.ts: Current API routes
- docs/specs/pre-merge-gate-v1.json: Spec format reference

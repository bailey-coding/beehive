/**
 * Deploy refs + canary deployments contract between the canary worker, the
 * shadow router and the Spec DO. One module owns the payload schemas, the DO
 * route paths and the response parsing, so clients and the DO cannot drift.
 *
 * A deploy ref is the traffic pointer for one (spec, rung). The rows form an
 * append-only chain per (spec, rung): every move inserts a row whose
 * prev_ref_id is the head it replaces, and the head is the row nothing points
 * back to. Promotion moves the head to a new target; rollback moves it to the
 * target of head.prev_ref_id. Both are the same insert in opposite directions,
 * so they cost the same (AGENTS.md rule 7), and rolling back twice toggles back.
 * A row with candidateId null is the empty ref: no candidate takes that rung's
 * traffic. The Artifacts ref is at most a provenance mirror of this (rule 4).
 *
 * Spec: AGENTS.md#non-negotiable-architectural-rules (rules 4 and 7)
 */

import { z } from 'zod';

// ============================================================================
// SCHEMAS
// ============================================================================

// Rungs that take live traffic, so the only ones with a pointer
export const DeployRungSchema = z.enum(['canary', 'full']);

export const DeployRefSchema = z
  .object({
    id: z.string().min(1),
    specId: z.string().min(1),
    rung: DeployRungSchema,
    candidateId: z.string().nullable(),
    commitSha: z.string().nullable(),
    workerVersionId: z.string().nullable(),
    prevRefId: z.string().nullable(),
    action: z.enum(['promote', 'rollback']),
    movedBy: z.string(),
    movedAt: z.number().int(),
  })
  .strict();

export const CanaryStatusSchema = z.enum(['deployed', 'superseded', 'rolled_back']);

export const CanaryDeploymentSchema = z
  .object({
    id: z.string().min(1),
    candidateId: z.string().min(1),
    specId: z.string().min(1),
    status: CanaryStatusSchema,
    url: z.string(),
    workerVersionId: z.string(),
    commitSha: z.string().nullable(),
    trafficPercentage: z.number(),
    holdoutPercentage: z.number(),
    autoRollback: z.boolean(),
    deployRefId: z.string(),
    rollbackReason: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

// Body of POST /canary-deployments: record the deployment and move the canary ref
export const CanaryDeployRequestSchema = z
  .object({
    candidateId: z.string().min(1),
    specId: z.string().min(1),
    url: z.string().min(1),
    workerVersionId: z.string().min(1),
    commitSha: z.string().min(1).nullable().optional(),
    trafficPercentage: z.number().gt(0).max(100),
    holdoutPercentage: z.number().min(0).max(100),
    autoRollback: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.trafficPercentage + b.holdoutPercentage <= 100, {
    message: 'trafficPercentage + holdoutPercentage must be <= 100',
  });

export const CanaryPatchSchema = z.object({ autoRollback: z.boolean() }).strict();

export const RollbackRequestSchema = z.object({ reason: z.string().min(1).max(500) }).strict();

export const RefRollbackRequestSchema = z
  .object({ specId: z.string().min(1), rung: DeployRungSchema, reason: z.string().min(1).max(500) })
  .strict();

export const CanaryMoveResultSchema = z.object({ deployment: CanaryDeploymentSchema, ref: DeployRefSchema }).strict();

// A live pointer (head with a candidate) and, for canary, the deployment it points at
export const LiveRefSchema = z.object({ ref: DeployRefSchema, deployment: CanaryDeploymentSchema.nullable() }).strict();

// ============================================================================
// TYPES
// ============================================================================

export type DeployRung = z.infer<typeof DeployRungSchema>;
export type DeployRef = z.infer<typeof DeployRefSchema>;
export type CanaryStatus = z.infer<typeof CanaryStatusSchema>;
export type CanaryDeployment = z.infer<typeof CanaryDeploymentSchema>;
export type CanaryDeployRequest = z.infer<typeof CanaryDeployRequestSchema>;
export type CanaryMoveResult = z.infer<typeof CanaryMoveResultSchema>;
export type LiveRef = z.infer<typeof LiveRefSchema>;

// ============================================================================
// ROUTES (Spec DO, internal: reached over the SPEC_DO binding only)
// ============================================================================

export const DEPLOY_PATHS = {
  canaryDeployments: '/canary-deployments',
  canaryDeployment: (id: string) => `/canary-deployments/${encodeURIComponent(id)}`,
  canaryRollback: (id: string) => `/canary-deployments/${encodeURIComponent(id)}/rollback`,
  deployRefs: '/deploy-refs',
  deployRefHead: '/deploy-refs/head',
  deployRefRollback: '/deploy-refs/rollback',
  liveRefs: '/deploy-refs/live',
} as const;

export const DEPLOY_ROUTE = /^\/(canary-deployments|deploy-refs)(?:\/([^\/]+))?(?:\/(rollback))?$/;

// ============================================================================
// CLIENT
// ============================================================================

export interface SpecDoFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** Non-OK DO answers keep their status so callers can relay 400/404/409 as-is. */
export type DeployResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string };

/**
 * Typed client for the Spec DO deploy-ref and canary routes. Validates the
 * request before sending and the envelope `data` on success. A malformed DO
 * answer is a 502 result, never a throw.
 */
export class DeployRefsClient {
  constructor(private readonly specDo: SpecDoFetcher) {}

  deployCanary(request: CanaryDeployRequest, actorId: string): Promise<DeployResult<CanaryMoveResult>> {
    return this.send(DEPLOY_PATHS.canaryDeployments, 'POST', CanaryDeployRequestSchema.parse(request), actorId, CanaryMoveResultSchema);
  }

  getCanaryDeployment(id: string): Promise<DeployResult<CanaryDeployment>> {
    return this.send(DEPLOY_PATHS.canaryDeployment(id), 'GET', undefined, undefined, CanaryDeploymentSchema);
  }

  /** Newest first */
  listCanaryDeployments(candidateId: string): Promise<DeployResult<CanaryDeployment[]>> {
    const path = `${DEPLOY_PATHS.canaryDeployments}?candidateId=${encodeURIComponent(candidateId)}`;
    return this.send(path, 'GET', undefined, undefined, z.array(CanaryDeploymentSchema));
  }

  setAutoRollback(id: string, autoRollback: boolean, actorId: string): Promise<DeployResult<CanaryDeployment>> {
    return this.send(DEPLOY_PATHS.canaryDeployment(id), 'PATCH', CanaryPatchSchema.parse({ autoRollback }), actorId, CanaryDeploymentSchema);
  }

  rollbackCanary(id: string, reason: string, actorId: string): Promise<DeployResult<CanaryMoveResult>> {
    return this.send(DEPLOY_PATHS.canaryRollback(id), 'POST', RollbackRequestSchema.parse({ reason }), actorId, CanaryMoveResultSchema);
  }

  liveRefs(rung: DeployRung): Promise<DeployResult<LiveRef[]>> {
    return this.send(`${DEPLOY_PATHS.liveRefs}?rung=${rung}`, 'GET', undefined, undefined, z.array(LiveRefSchema));
  }

  private async send<T>(
    path: string,
    method: string,
    body: unknown,
    actorId: string | undefined,
    schema: z.ZodType<T>
  ): Promise<DeployResult<T>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (actorId) headers['X-Actor-ID'] = actorId;
    const response = await this.specDo.fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let envelope: { success?: boolean; data?: unknown; error?: unknown };
    try {
      envelope = (await response.json()) as typeof envelope;
    } catch {
      return { ok: false, status: 502, error: `Spec DO returned ${response.status} without JSON` };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: String(envelope.error ?? `Spec DO returned ${response.status}`) };
    }
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) {
      return { ok: false, status: 502, error: `invalid Spec DO response: ${parsed.error.message}` };
    }
    return { ok: true, status: response.status, data: parsed.data };
  }
}

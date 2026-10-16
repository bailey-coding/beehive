/**
 * Ledger lifecycle contract between the beehive edge and the Spec DO:
 * tombstones (soft delete), maintainer role, and purge (hard delete of old
 * tombstones). One module owns the payload schemas, the DO route paths and the
 * response parsing, so the edge (client) and the DO (server) cannot drift.
 *
 * Spec: AGENTS.md#state-management, MILESTONES M1 "Ledger lifecycle"
 */

import { z } from 'zod';

// ============================================================================
// SCHEMAS
// ============================================================================

// Reserved rows the service-account mint depends on (FK targets for unscoped mints).
// Never tombstoned or purged: tombstoning the org would 409 every unscoped mint forever.
export const RESERVED_ORGANIZATION_ID = 'beehive-system';
export const RESERVED_ACTOR_ID = 'master';

// Entities that carry deleted_at / deleted_by / delete_reason. Issues are only
// tombstoned by cascade (no DELETE route of their own).
export const TombstoneEntitySchema = z.enum(['organization', 'repository', 'spec', 'candidate']);

export const TombstoneRequestSchema = z
  .object({
    entityType: TombstoneEntitySchema,
    id: z.string().min(1),
    reason: z.string().max(500).optional(),
  })
  .strict();

// Counts of rows touched, keyed by table name
export const RowCountsSchema = z.record(z.string(), z.number().int().nonnegative());

export const TombstoneResultSchema = z
  .object({
    entityType: TombstoneEntitySchema,
    id: z.string(),
    deletedAt: z.number().int(),
    counts: RowCountsSchema,
  })
  .strict();

export const PurgeRequestSchema = z
  .object({
    orgNamePrefix: z.string().min(1).optional(),
    orgIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    dryRun: z.boolean().default(true),
    confirm: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((b) => (b.orgNamePrefix === undefined) !== (b.orgIds === undefined), {
    message: 'exactly one of orgNamePrefix or orgIds is required',
  })
  .refine((b) => b.dryRun || b.confirm !== undefined, {
    message: 'confirm (the dry-run total) is required when dryRun is false',
  });

// An org that matched the selector but is not purged, and why
export const PurgeSkippedSchema = z
  .object({
    orgId: z.string(),
    name: z.string(),
    reason: z.enum(['not_tombstoned', 'too_recent', 'live_descendants', 'service_accounts', 'reserved']),
  })
  .strict();

export const PurgeResultSchema = z
  .object({
    purgeId: z.string(),
    dryRun: z.boolean(),
    minAgeHours: z.number().nonnegative(),
    orgIds: z.array(z.string()),
    skipped: z.array(PurgeSkippedSchema),
    counts: RowCountsSchema,
    total: z.number().int().nonnegative(),
    batches: z.number().int().nonnegative(),
  })
  .strict();

export const ActorRoleSchema = z.enum(['maintainer']);

export const SetActorRoleRequestSchema = z
  .object({ role: ActorRoleSchema.nullable() })
  .strict();

export const SetActorRoleResultSchema = z
  .object({ actorId: z.string(), role: ActorRoleSchema.nullable() })
  .strict();

// ============================================================================
// TYPES
// ============================================================================

export type TombstoneEntity = z.infer<typeof TombstoneEntitySchema>;
export type TombstoneRequest = z.infer<typeof TombstoneRequestSchema>;
export type TombstoneResult = z.infer<typeof TombstoneResultSchema>;
export type PurgeRequest = z.input<typeof PurgeRequestSchema>;
export type ParsedPurgeRequest = z.output<typeof PurgeRequestSchema>;
export type PurgeSkipped = z.infer<typeof PurgeSkippedSchema>;
export type PurgeResult = z.infer<typeof PurgeResultSchema>;
export type ActorRole = z.infer<typeof ActorRoleSchema>;
export type SetActorRoleResult = z.infer<typeof SetActorRoleResultSchema>;

// ============================================================================
// ROUTES AND CONSTANTS
// ============================================================================

// DO-internal routes: built only by the beehive edge with fixed paths
export const LIFECYCLE_PATHS = {
  tombstone: '/internal/tombstone',
  purge: '/internal/purge',
  actorRole: (actorId: string) => `/internal/actors/${encodeURIComponent(actorId)}/role`,
} as const;

// Edge DELETE routes: path segment -> entity type
export const TOMBSTONE_ROUTE = /^\/api\/(organizations|repositories|specs|candidates)\/([^\/]+)$/;
export const TOMBSTONE_SEGMENTS: Record<string, TombstoneEntity> = {
  organizations: 'organization',
  repositories: 'repository',
  specs: 'spec',
  candidates: 'candidate',
};

// Edge GET routes that honor ?include_deleted=1 (maintainers only)
export const INCLUDE_DELETED_ROUTE = /^\/api\/(organizations|repositories|specs|candidates|issues)(?:\/[^\/]+)?$/;
export const INCLUDE_DELETED_PARAM = 'include_deleted';

export const PURGE_BATCH_SIZE = 500;
export const DEFAULT_PURGE_MIN_AGE_HOURS = 24;

// ============================================================================
// CLIENT
// ============================================================================

export interface SpecDoFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** Non-OK DO answers keep their status so the edge can relay 403/404/409 as-is. */
export type LifecycleResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

/**
 * Typed client for the Spec DO lifecycle routes. Validates the request payload
 * before sending and the envelope `data` on success. A malformed DO answer is
 * a 502 result, never a throw.
 */
export class LedgerLifecycleClient {
  constructor(private readonly specDo: SpecDoFetcher) {}

  tombstone(request: TombstoneRequest, actorId: string): Promise<LifecycleResult<TombstoneResult>> {
    return this.post(LIFECYCLE_PATHS.tombstone, TombstoneRequestSchema.parse(request), actorId, TombstoneResultSchema);
  }

  purge(request: PurgeRequest, actorId: string): Promise<LifecycleResult<PurgeResult>> {
    return this.post(LIFECYCLE_PATHS.purge, PurgeRequestSchema.parse(request), actorId, PurgeResultSchema);
  }

  setActorRole(targetActorId: string, role: ActorRole | null, actorId: string): Promise<LifecycleResult<SetActorRoleResult>> {
    return this.post(LIFECYCLE_PATHS.actorRole(targetActorId), SetActorRoleRequestSchema.parse({ role }), actorId, SetActorRoleResultSchema);
  }

  private async post<T>(path: string, body: unknown, actorId: string, schema: z.ZodType<T>): Promise<LifecycleResult<T>> {
    const response = await this.specDo.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actorId },
      body: JSON.stringify(body),
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

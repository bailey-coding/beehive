/**
 * Promotion ledger contract between the Promotion Worker and the Spec DO.
 *
 * One module owns the payload schemas, the DO route paths and the JSON parsing,
 * so the client (promotion worker) and the server (SpecDO fetch router) cannot
 * drift. Shapes match what state.ts, tournament.ts and merge-train.ts already sent.
 *
 * Spec: AGENTS.md#state-management (train state lives in the Spec DO)
 */

import { z } from 'zod';

// ============================================================================
// SCHEMAS
// ============================================================================

export const PromotionModeSchema = z.enum(['tournament', 'merge-train']);
export const RungSchema = z.enum(['pre-merge', 'shadow', 'train', 'canary', 'full']);

export const PromotionStateSchema = z
  .object({
    id: z.string().min(1),
    candidateId: z.string().min(1),
    specId: z.string().min(1),
    currentRung: RungSchema,
    targetRung: RungSchema,
    status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'rolled_back', 'cancelled']),
    mode: PromotionModeSchema,
    startedAt: z.string(),
    completedAt: z.string().optional(),
    failedAt: z.string().optional(),
    failureReason: z.string().optional(),
    rollbackReason: z.string().optional(),
    actorId: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// id is the row key; everything else may be patched. null clears an optional
// field (promotion.ts retry resets failedAt/failureReason).
export const PromotionStatePatchSchema = PromotionStateSchema.omit({ id: true })
  .partial()
  .extend({
    completedAt: z.string().nullable().optional(),
    failedAt: z.string().nullable().optional(),
    failureReason: z.string().nullable().optional(),
    rollbackReason: z.string().nullable().optional(),
    actorId: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

// Loose: tournament.ts merges whatever metrics the candidate record carries
export const CandidateMetricsSchema = z.looseObject({
  passRate: z.number(),
  failureRate: z.number(),
  latencyP95: z.number(),
  latencyP50: z.number(),
  errorRate: z.number(),
  throughput: z.number(),
  score: z.number(),
  conformanceScore: z.number(),
  complexityDelta: z.number(),
  stability: z.number(),
});

export const TournamentCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    specId: z.string().min(1),
    score: z.number(),
    status: z.enum(['competing', 'winner', 'eliminated', 'disqualified']),
    metrics: CandidateMetricsSchema,
    promotedAt: z.string().optional(),
  })
  .strict();

export const CandidateComparisonSchema = z
  .object({
    candidate1: z.string(),
    candidate2: z.string(),
    winner: z.string(),
    comparisonScore: z.number(),
    comparedAt: z.string(),
    criteria: z.record(z.string(), z.number()).optional(),
  })
  .strict();

const tournamentFields = {
  mode: z.literal('tournament'),
  specId: z.string().min(1),
  candidates: z.array(TournamentCandidateSchema),
  winner: z.string().optional(),
  comparisons: z.array(CandidateComparisonSchema),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
};

export const TournamentStatusSchema = z.object(tournamentFields).strict();
export const TournamentRecordSchema = z.object({ id: z.string().min(1), ...tournamentFields }).strict();
export const TournamentPatchSchema = TournamentStatusSchema.partial().strict();

export const MergeTrainCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    specId: z.string().min(1),
    position: z.number().int(),
    status: z.enum(['waiting', 'merging', 'merged', 'failed', 'rolled_back']),
    mergedAt: z.string().optional(),
    failedAt: z.string().optional(),
    failureReason: z.string().optional(),
  })
  .strict();

const mergeTrainFields = {
  mode: z.literal('merge-train'),
  specId: z.string().min(1),
  candidates: z.array(MergeTrainCandidateSchema),
  currentPosition: z.number().int(),
  nextMerge: z.string().nullable(),
  status: z.enum(['idle', 'processing', 'paused', 'failed']),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
};

export const MergeTrainStatusSchema = z.object(mergeTrainFields).strict();
export const MergeTrainRecordSchema = z.object({ id: z.string().min(1), ...mergeTrainFields }).strict();
export const MergeTrainPatchSchema = MergeTrainStatusSchema.partial().strict();

// ============================================================================
// TYPES
// ============================================================================

export type PromotionMode = z.infer<typeof PromotionModeSchema>;
export type Rung = z.infer<typeof RungSchema>;
export type PromotionState = z.infer<typeof PromotionStateSchema>;
export type PromotionStatePatch = z.infer<typeof PromotionStatePatchSchema>;
export type CandidateMetrics = z.infer<typeof CandidateMetricsSchema>;
export type TournamentCandidate = z.infer<typeof TournamentCandidateSchema>;
export type CandidateComparison = z.infer<typeof CandidateComparisonSchema>;
export type TournamentStatus = z.infer<typeof TournamentStatusSchema>;
export type TournamentRecord = z.infer<typeof TournamentRecordSchema>;
export type TournamentPatch = z.infer<typeof TournamentPatchSchema>;
export type MergeTrainCandidate = z.infer<typeof MergeTrainCandidateSchema>;
export type MergeTrainStatus = z.infer<typeof MergeTrainStatusSchema>;
export type MergeTrainRecord = z.infer<typeof MergeTrainRecordSchema>;
export type MergeTrainPatch = z.infer<typeof MergeTrainPatchSchema>;

// ============================================================================
// ROUTES
// ============================================================================

export const LEDGER_PATHS = {
  promotionStates: '/promotion-states',
  tournaments: '/tournament-status',
  mergeTrains: '/merge-train-status',
} as const;

// Suffix for "list every record" on the tournament and merge-train collections
export const LIST_ALL_SUFFIX = '/all';

// Body `code` on a 404 for a lookup that matched no record. Any other 404
// (e.g. a route the DO does not serve) is an error, never an empty result.
export const RECORD_NOT_FOUND = 'record_not_found';

// ============================================================================
// CLIENT
// ============================================================================

export interface SpecDoFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export class SpecDoLedgerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'SpecDoLedgerError';
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Typed client for the Spec DO promotion ledger routes. Every non-OK response
 * throws SpecDoLedgerError, except a record-miss 404 on single-record lookups,
 * which returns null.
 */
export class PromotionLedgerClient {
  constructor(private readonly specDo: SpecDoFetcher) {}

  // --- promotion states ---

  async listPromotionStates(filter: { candidateId?: string } = {}): Promise<PromotionState[]> {
    const query = filter.candidateId ? `?candidateId=${encodeURIComponent(filter.candidateId)}` : '';
    return this.request('list promotion states', `${LEDGER_PATHS.promotionStates}${query}`, z.array(PromotionStateSchema));
  }

  async createPromotionState(state: PromotionState, actorId?: string): Promise<PromotionState> {
    return this.request('create promotion state', LEDGER_PATHS.promotionStates, PromotionStateSchema, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Actor-ID': actorId || 'system' },
      body: JSON.stringify(PromotionStateSchema.parse(state)),
    });
  }

  async updatePromotionState(id: string, patch: PromotionStatePatch): Promise<PromotionState> {
    return this.request('update promotion state', `${LEDGER_PATHS.promotionStates}/${encodeURIComponent(id)}`, PromotionStateSchema, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(PromotionStatePatchSchema.parse(undefinedToNull(patch))),
    });
  }

  // --- tournaments ---

  async getTournamentBySpec(specId: string): Promise<TournamentRecord | null> {
    return this.requestOrNull('get tournament', `${LEDGER_PATHS.tournaments}?specId=${encodeURIComponent(specId)}`, TournamentRecordSchema);
  }

  async listTournaments(): Promise<TournamentRecord[]> {
    return this.request('list tournaments', `${LEDGER_PATHS.tournaments}${LIST_ALL_SUFFIX}`, z.array(TournamentRecordSchema));
  }

  async saveTournament(tournament: TournamentRecord): Promise<TournamentRecord> {
    return this.request('save tournament', LEDGER_PATHS.tournaments, TournamentRecordSchema, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(TournamentRecordSchema.parse(tournament)),
    });
  }

  async updateTournament(id: string, patch: TournamentPatch): Promise<TournamentRecord> {
    return this.request('update tournament', `${LEDGER_PATHS.tournaments}/${encodeURIComponent(id)}`, TournamentRecordSchema, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(TournamentPatchSchema.parse(patch)),
    });
  }

  // --- merge trains ---

  async getMergeTrainBySpec(specId: string): Promise<MergeTrainRecord | null> {
    return this.requestOrNull('get merge train', `${LEDGER_PATHS.mergeTrains}?specId=${encodeURIComponent(specId)}`, MergeTrainRecordSchema);
  }

  async listMergeTrains(): Promise<MergeTrainRecord[]> {
    return this.request('list merge trains', `${LEDGER_PATHS.mergeTrains}${LIST_ALL_SUFFIX}`, z.array(MergeTrainRecordSchema));
  }

  async saveMergeTrain(train: MergeTrainRecord): Promise<MergeTrainRecord> {
    return this.request('save merge train', LEDGER_PATHS.mergeTrains, MergeTrainRecordSchema, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(MergeTrainRecordSchema.parse(train)),
    });
  }

  async updateMergeTrain(id: string, patch: MergeTrainPatch): Promise<MergeTrainRecord> {
    return this.request('update merge train', `${LEDGER_PATHS.mergeTrains}/${encodeURIComponent(id)}`, MergeTrainRecordSchema, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(MergeTrainPatchSchema.parse(patch)),
    });
  }

  // --- transport ---

  private async request<T>(op: string, path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const response = await this.specDo.fetch(path, init);
    if (!response.ok) {
      throw new SpecDoLedgerError(`Failed to ${op}: ${response.status} ${await safeText(response)}`, response.status);
    }
    return parseBody(op, schema, await response.json());
  }

  private async requestOrNull<T>(op: string, path: string, schema: z.ZodType<T>): Promise<T | null> {
    const response = await this.specDo.fetch(path);
    if (response.status === 404) {
      const text = await safeText(response);
      if (isRecordNotFound(text)) return null;
      throw new SpecDoLedgerError(`Failed to ${op}: 404 ${text}`, 404);
    }
    if (!response.ok) {
      throw new SpecDoLedgerError(`Failed to ${op}: ${response.status} ${await safeText(response)}`, response.status);
    }
    return parseBody(op, schema, await response.json());
  }
}

// A key set to undefined means "clear it"; JSON would silently drop it instead
function undefinedToNull(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : v]));
}

function parseBody<T>(op: string, schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new SpecDoLedgerError(`Failed to ${op}: invalid Spec DO response: ${parsed.error.message}`, 502);
  }
  return parsed.data;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function isRecordNotFound(text: string): boolean {
  try {
    return (JSON.parse(text) as { code?: unknown }).code === RECORD_NOT_FOUND;
  } catch {
    return false;
  }
}

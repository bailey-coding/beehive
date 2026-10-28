/**
 * Gate-run contract between the Spec DO (server) and the gate worker (client): the start/finish request bodies,
 * the stored run, and the limits the DO enforces. One module owns the shapes so the two cannot drift.
 * Every object is strict: an unknown field is a 400 (AGENTS.md "Strict zod schemas reject unknown fields").
 *
 * Spec: docs/REAL-GATE-IMPL-PLAN.md §3 (Spec DO changes), §1 (verdict), docs/MR-FLOW-PLAN.md §3
 */

import { z } from 'zod';

// ============================================================================
// ROUTES AND LIMITS
// ============================================================================

export const GATE_RUN_PATHS = {
  /** POST: start a run (Idempotency-Key honoured) */
  start: '/api/gate-runs',
  /** GET ?candidateId=&commitSha=&latest=1&includeLog=1 */
  list: '/api/gate-runs',
  /** GET /api/gate-runs/:id (includes logTail) */
  detail: (id: string) => `/api/gate-runs/${encodeURIComponent(id)}`,
  /** POST: finish a running run */
  result: (id: string) => `/api/gate-runs/${encodeURIComponent(id)}/result`,
  /** GET: same as list with the candidate in the path */
  forCandidate: (candidateId: string) => `/api/candidates/${encodeURIComponent(candidateId)}/gate-runs`,
} as const;

/** Runs started for one organization in the last 24 hours (docs/REAL-GATE-IMPL-PLAN.md D12) */
export const MAX_GATE_RUNS_PER_ORG_PER_DAY = 50;
export const GATE_RUN_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Non-stale running runs, per repository and across the ledger */
export const MAX_RUNNING_GATE_RUNS_PER_REPOSITORY = 1;
export const MAX_RUNNING_GATE_RUNS_GLOBAL = 3;
/** A `running` row older than this is reported as abandoned and frees its slot; nothing is written */
export const GATE_RUN_STALE_MS = 15 * 60 * 1000;
/** logTail ceiling, in UTF-8 bytes (the runner keeps `tail -c 32768`, then scrubs; cap after scrubbing) */
export const GATE_LOG_TAIL_MAX_BYTES = 32 * 1024;

// ============================================================================
// VOCABULARY
// ============================================================================

/** The only gate the DO starts runs for today; the table's CHECK is as wide as gate_verdicts' for later rungs */
export const GateRunGateSchema = z.literal('pre-merge');

/** What the runner (and the gate's terminal row) may report. `running` and `not_run` are the DO's own states. */
export const GateRunVerdictSchema = z.enum(['pass', 'fail', 'error']);
export const GateRunStatusSchema = z.enum(['running', 'pass', 'fail', 'error', 'not_run']);

export const GateRunFailureClassSchema = z.enum([
  // the brief's five
  'install_failed',
  'tests_failed',
  'no_tests',
  'timeout',
  'sandbox_unavailable',
  // docs/REAL-GATE-IMPL-PLAN.md §4 table
  'no_lockfile',
  'timeout_install',
  'timeout_test',
  'timeout_overall',
  'clone_failed',
  'busy_timeout',
  'quota',
]);
/** Reads add `abandoned`: a running row past the stale threshold. Never accepted on a write. */
export const GateRunReadFailureClassSchema = z.enum([...GateRunFailureClassSchema.options, 'abandoned']);

/** 40 lowercase hex, an exact commit: never a ref or an abbreviation */
export const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'commitSha must be 40 lowercase hex characters');

/**
 * `tests`: `verified` when counts were parsed and passed > 0, `unverified` otherwise (an exit 0 with no parsable
 * counts is indistinguishable from no tests). `not_run` for conformance and complexity: never a pass.
 */
export const GateRunChecksSchema = z
  .object({
    tests: z.enum(['verified', 'unverified']),
    conformance: z.literal('not_run'),
    complexity: z.literal('not_run'),
  })
  .strict();

const PhaseSchema = z
  .object({
    ms: z.number().int().nonnegative(),
    exit: z.number().int().nullable(),
    timedOut: z.boolean(),
  })
  .strict();

export const GateRunTimingsSchema = z
  .object({
    install: PhaseSchema.optional(),
    test: PhaseSchema.optional(),
    totalMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const GateRunCountsSchema = z
  .object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative() })
  .strict();

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
const LogTailSchema = z.string().refine((s) => utf8Bytes(s) <= GATE_LOG_TAIL_MAX_BYTES, {
  message: `logTail exceeds ${GATE_LOG_TAIL_MAX_BYTES} bytes`,
});
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters');

// ============================================================================
// REQUESTS
// ============================================================================

/**
 * The gate's last attempt writes the final row itself: `error` (an infrastructure failure or an exhausted wait) or
 * `not_run`. It skips the quota and the caps (it consumes no container) and inserts an already finished row.
 */
export const GateRunTerminalSchema = z
  .object({
    status: z.enum(['error', 'not_run']),
    failureClass: GateRunFailureClassSchema,
  })
  .strict();

export const StartGateRunRequestSchema = z
  .object({
    candidateId: z.string().min(1).max(200),
    gate: GateRunGateSchema,
    commitSha: CommitShaSchema,
    decidedBy: z.string().min(1).max(200),
    terminal: GateRunTerminalSchema.optional(),
  })
  .strict();

export const FinishGateRunRequestSchema = z
  .object({
    status: GateRunVerdictSchema,
    failureClass: GateRunFailureClassSchema.optional(),
    exitCode: z.number().int().nullable().optional(),
    checks: GateRunChecksSchema,
    timings: GateRunTimingsSchema,
    counts: GateRunCountsSchema.nullable().optional(),
    logTail: LogTailSchema.optional(),
    logSha256: Sha256Schema.optional(),
    logTruncated: z.boolean().optional(),
    runner: z.string().min(1).max(100).optional(),
    instance: z.string().min(1).max(100),
    imageDigest: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((b) => (b.status === 'pass') === (b.failureClass === undefined), {
    message: 'failureClass is required unless status is pass, and forbidden when it is',
  });

// ============================================================================
// STORED RUN AND RESPONSES
// ============================================================================

export const GateRunSchema = z
  .object({
    id: z.string(),
    candidateId: z.string(),
    gate: z.string(),
    commitSha: z.string(),
    attempt: z.number().int().positive(),
    status: GateRunStatusSchema,
    failureClass: GateRunReadFailureClassSchema.nullable(),
    /** True when a running row was past GATE_RUN_STALE_MS and is reported as `error`/`abandoned` (stored status unchanged) */
    stale: z.boolean(),
    exitCode: z.number().int().nullable(),
    checks: GateRunChecksSchema.nullable(),
    timings: GateRunTimingsSchema.nullable(),
    counts: GateRunCountsSchema.nullable(),
    runner: z.string().nullable(),
    instance: z.string().nullable(),
    imageDigest: z.string().nullable(),
    durationMs: z.number().int().nullable(),
    logSha256: z.string().nullable(),
    logTruncated: z.boolean(),
    /** Present on the detail route and on lists with includeLog=1 */
    logTail: z.string().nullable().optional(),
    decidedBy: z.string(),
    startedAt: z.number().int(),
    finishedAt: z.number().int().nullable(),
  })
  .strict();

/** A run was started (or, for `terminal`, written finished) */
export const StartedGateRunSchema = z
  .object({
    runId: z.string(),
    attempt: z.number().int().positive(),
    /** Resolved from the ledger, never from the caller */
    repo: z.string(),
    namespace: z.string(),
    /** Only on a `terminal` start: the finished status of the row that was written */
    status: GateRunStatusSchema,
  })
  .strict();
/** Same candidate, gate and sha already has a live running run or a pass/fail: nothing was written */
export const DedupedGateRunSchema = z.object({ deduped: z.literal(true), runId: z.string() }).strict();
/** The organization is over its daily quota: a `not_run`/`quota` row was written, nothing will run */
export const QuotaGateRunSchema = z.object({ quota: z.literal(true), runId: z.string() }).strict();
export const StartGateRunResultSchema = z.union([StartedGateRunSchema, DedupedGateRunSchema, QuotaGateRunSchema]);

export type GateRunStatus = z.infer<typeof GateRunStatusSchema>;
export type GateRunFailureClass = z.infer<typeof GateRunFailureClassSchema>;
export type GateRunChecks = z.infer<typeof GateRunChecksSchema>;
export type StartGateRunRequest = z.infer<typeof StartGateRunRequestSchema>;
export type FinishGateRunRequest = z.infer<typeof FinishGateRunRequestSchema>;
export type GateRun = z.infer<typeof GateRunSchema>;
export type StartGateRunResult = z.infer<typeof StartGateRunResultSchema>;

/** 409 body `code` when a cap refuses a start; the gate re-sends later instead of consuming a queue retry */
export const GATE_RUN_BUSY = 'busy';

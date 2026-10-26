/**
 * Ledger lifecycle routes at the edge. Master token only; the Spec DO checks
 * that X-Actor-ID is a maintainer where required (purge, role, include_deleted).
 *
 *   DELETE /api/{organizations|repositories|specs|candidates}/:id  tombstone (cascades down)
 *   POST   /api/admin/purge                                        hard delete old tombstones
 *   POST   /api/admin/actors/:id/role                              grant/revoke maintainer
 *   GET    /api/{organizations|repositories|specs|candidates|issues}[/:id]?include_deleted=1
 *
 * Contract: workers/shared/ledger-lifecycle.ts
 */

import type { Principal } from '../shared/principal';
import {
  LedgerLifecycleClient,
  TombstoneRequestSchema,
  PurgeRequestSchema,
  SetActorRoleRequestSchema,
  TOMBSTONE_ROUTE,
  TOMBSTONE_SEGMENTS,
  RESERVED_ORGANIZATION_ID,
  INCLUDE_DELETED_ROUTE,
  INCLUDE_DELETED_PARAM,
  type LifecycleResult,
} from '../shared/ledger-lifecycle';
import type { SpecDoStub } from '../shared/spec-do-auth';
import type { CandidateWorkerCleanup, WorkerCleanupReport } from './purge-cleanup';

const ROLE_ROUTE = /^\/api\/admin\/actors\/([^\/]+)\/role$/;
const TombstoneBodySchema = TombstoneRequestSchema.pick({ reason: true });

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, data, timestamp: Date.now() }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(error: string, status: number): Response {
  return new Response(JSON.stringify({ success: false, error, timestamp: Date.now() }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function relay<T>(result: LifecycleResult<T>): Response {
  return result.ok ? json(result.data, result.status) : err(result.error, result.status);
}

async function readJson(request: Request, optional: boolean): Promise<{ body: unknown } | Response> {
  const text = await request.text();
  if (!text && optional) return { body: {} };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return err('invalid JSON body', 400);
  }
}

/** Returns a Response for a lifecycle route, else null. */
export async function handleLifecycleRoutes(
  request: Request,
  url: URL,
  principal: Principal,
  stub: SpecDoStub,
  workerCleanup: CandidateWorkerCleanup | null = null
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;
  const tombstone = method === 'DELETE' ? path.match(TOMBSTONE_ROUTE) : null;
  const purge = path === '/api/admin/purge';
  const role = path.match(ROLE_ROUTE);
  const includeDeleted = method === 'GET' && url.searchParams.has(INCLUDE_DELETED_PARAM) && INCLUDE_DELETED_ROUTE.test(path);
  if (!tombstone && !purge && !role && !includeDeleted) return null;

  // Service principals never tombstone, purge, change roles or read tombstones.
  // authorize() already blocks their writes and /api/admin/*; this also covers GET.
  if (principal.kind !== 'master') return err('Forbidden', 403);
  const actorId = principal.actorId;

  if (includeDeleted) {
    if (url.searchParams.get(INCLUDE_DELETED_PARAM) !== '1') return err(`${INCLUDE_DELETED_PARAM} must be 1`, 400);
    // Same path and query as the plain GET; the DO checks the maintainer role
    return stub.fetch(
      new Request(`https://spec-do.internal${path}${url.search}`, { headers: { 'X-Actor-ID': actorId } })
    );
  }

  if (!tombstone && method !== 'POST') return err('Method not allowed', 405);
  // Every lifecycle write is attributed: deleted_by / requested_by come from X-Actor-ID
  if (actorId === 'unknown') return err('X-Actor-ID is required', 400);

  const read = await readJson(request, Boolean(tombstone));
  if (read instanceof Response) return read;
  const client = new LedgerLifecycleClient({
    fetch: (input, init) => stub.fetch(new Request(`https://spec-do.internal${input}`, init)),
  });

  if (tombstone) {
    const body = TombstoneBodySchema.strict().safeParse(read.body);
    if (!body.success) return err(body.error.message, 400);
    const entityType = TOMBSTONE_SEGMENTS[tombstone[1]];
    const id = decodeURIComponent(tombstone[2]);
    if (entityType === 'organization' && id === RESERVED_ORGANIZATION_ID) {
      return err(`organization ${id} is reserved and cannot be tombstoned`, 403);
    }
    return relay(await client.tombstone({ entityType, id, reason: body.data.reason }, actorId));
  }
  if (purge) {
    const body = PurgeRequestSchema.safeParse(read.body);
    if (!body.success) return err(body.error.message, 400);
    if (body.data.orgIds?.includes(RESERVED_ORGANIZATION_ID)) {
      return err(`organization ${RESERVED_ORGANIZATION_ID} is reserved and cannot be purged`, 403);
    }
    if (body.data.dryRun) return relay(await client.purge(body.data, actorId));

    // A real purge first deletes the Workers of the candidates it is about to hard-delete (the ledger cannot name them afterwards).
    // The plan comes from a dry run of the same selector: it also gives every refusal (not a maintainer, active promotion, ...) before
    // any Worker is touched. Failure of a Worker delete aborts the purge; nothing has been purged and the call can be repeated.
    let cleanup: WorkerCleanupReport = { status: 'skipped', reason: 'no preview manager binding' };
    const cleaned = new Set<string>();
    let reportsIds = false;
    if (workerCleanup) {
      const { confirm: _confirm, ...selector } = body.data;
      let plan = await client.purge({ ...selector, dryRun: true, withCandidateIds: true }, actorId);
      if (!plan.ok && plan.status === 400) {
        // An older Spec DO does not know withCandidateIds: purge as before, without Worker cleanup. Only reachable in the mixed-version
        // deploy window (one push deploys all ten workers); it can orphan candidate Workers then, so purge only after the deploy settles
        plan = await client.purge({ ...selector, dryRun: true }, actorId);
        if (plan.ok) cleanup = { status: 'skipped', reason: 'the Spec DO does not report candidate ids yet' };
      }
      if (!plan.ok) return relay(plan);
      // The confirm gate must hold before any Worker is touched (the DO only checks it in the real purge, after the deletes)
      if (body.data.confirm !== plan.data.total) {
        return err(`confirm ${body.data.confirm} does not match the current dry-run total ${plan.data.total}; rerun the dry run`, 409);
      }
      if (plan.data.candidateIds) {
        reportsIds = true;
        const outcome = await workerCleanup.deleteWorkers(plan.data.candidateIds);
        if (!outcome.ok) return err(outcome.error, outcome.status);
        cleanup = outcome.report;
        if (outcome.report.status === 'done') [...outcome.report.deleted, ...outcome.report.absent].forEach((id) => cleaned.add(id));
      }
    }
    const purged = await client.purge({ ...body.data, ...(reportsIds ? { withCandidateIds: true } : {}) }, actorId);
    if (!purged.ok) return relay(purged);
    // Candidates that appeared between the dry run and the purge (a tombstone in that window): delete their Workers now, best effort
    let late: string[] = [];
    if (workerCleanup && reportsIds && cleanup.status === 'done') {
      const missed = (purged.data.candidateIds ?? []).filter((id) => !cleaned.has(id));
      if (missed.length) {
        const outcome = await workerCleanup.deleteWorkers(missed);
        late = outcome.ok ? [] : missed;
      }
    }
    const { candidateIds: _ids, ...result } = purged.data;
    return json({ ...result, workerCleanup: cleanup, ...(late.length ? { workersNotDeleted: late } : {}) }, purged.status);
  }
  const body = SetActorRoleRequestSchema.safeParse(read.body);
  if (!body.success) return err(body.error.message, 400);
  return relay(await client.setActorRole(decodeURIComponent(role![1]), body.data.role, actorId));
}

/**
 * Deletes the Workers of the candidates a purge is about to hard-delete (`DELETE /api/preview/canary/:id` on the preview
 * manager). Without this a purge leaves every uploaded `beehive-candidate-<uuid>` Worker behind, with nothing left in the ledger
 * to find it by. Runs BEFORE the purge so that a failure aborts it and the call can simply be repeated.
 *
 * Spec: docs/CLEANUP-PLAN-2026-10-25.md C
 */

export interface PreviewManagerFetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** Subrequest budget: one preview-manager call (itself calling the Spec DO and the Cloudflare API) per candidate. */
export const MAX_CANDIDATE_WORKERS_PER_PURGE = 40;
const PARALLEL = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type WorkerCleanupReport =
  | { status: 'done'; deleted: string[]; absent: string[] }
  | { status: 'skipped'; reason: string };

export type WorkerCleanupResult =
  | { ok: true; report: WorkerCleanupReport }
  | { ok: false; status: number; error: string; failed: Array<{ candidateId: string; status: number; error: string }>; deleted?: string[] };

export interface CandidateWorkerCleanup {
  deleteWorkers(candidateIds: string[]): Promise<WorkerCleanupResult>;
}

export function createCandidateWorkerCleanup(preview: PreviewManagerFetcher, apiToken: string): CandidateWorkerCleanup {
  return {
    async deleteWorkers(candidateIds) {
      // Only UUID candidates ever got a Worker (the preview manager refuses any other id)
      const ids = [...new Set(candidateIds.filter((id) => UUID_RE.test(id)))];
      if (ids.length > MAX_CANDIDATE_WORKERS_PER_PURGE) {
        return {
          ok: false,
          status: 409,
          error: `${ids.length} candidate Workers would be deleted; at most ${MAX_CANDIDATE_WORKERS_PER_PURGE} per purge. Narrow the selector (a longer orgNamePrefix, or orgIds) and repeat`,
          failed: [],
        };
      }
      // No candidates: nothing was ever uploaded, so the preview manager is not called (and its 501 cannot matter)
      if (!ids.length) return { ok: true, report: { status: 'done', deleted: [], absent: [] } };
      const deleted: string[] = [];
      const absent: string[] = [];
      const failed: Array<{ candidateId: string; status: number; error: string }> = [];
      let unavailable = false; // a 501 stops further groups; the ones in flight finish and are reported
      for (let i = 0; i < ids.length && !unavailable; i += PARALLEL) {
        await Promise.all(ids.slice(i, i + PARALLEL).map(async (candidateId) => {
          try {
            const res = await preview.fetch(`https://preview-manager.internal/api/preview/canary/${candidateId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${apiToken}` },
            });
            // 501 is NOT "nothing was uploaded": the preview manager also answers it when WORKER_VERSIONS_MODE=api but a secret or
            // var is missing (workers/preview-manager/versions.ts), and purging then would drop the only record of uploaded Workers
            if (res.status === 501) {
              unavailable = true;
              failed.push({ candidateId, status: 501, error: 'preview manager answered 501 (Workers Versions client not available; check WORKER_VERSIONS_MODE, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, WORKERS_SUBDOMAIN)' });
              return;
            }
            const body = (await res.json().catch(() => null)) as { deleted?: unknown; error?: unknown } | null;
            if (!res.ok) {
              failed.push({ candidateId, status: res.status, error: typeof body?.error === 'string' ? body.error : `HTTP ${res.status}` });
              return;
            }
            (body?.deleted === true ? deleted : absent).push(candidateId);
          } catch (error) {
            failed.push({ candidateId, status: 502, error: error instanceof Error ? error.message : String(error) });
          }
        }));
      }
      if (failed.length) {
        const status = failed.some((f) => f.status === 409) ? 409 : 502;
        const already = deleted.length ? `Workers already deleted in this call: ${deleted.join(', ')}; ` : '';
        return {
          ok: false,
          status,
          error: `could not delete the Worker of ${failed.length} candidate(s); no ledger rows were purged (${already}a repeat is safe), repeat after fixing: ${failed.map((f) => `${f.candidateId}: ${f.error}`).join('; ')}`,
          failed,
          deleted,
        };
      }
      return { ok: true, report: { status: 'done', deleted, absent } };
    },
  };
}

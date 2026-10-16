/**
 * In-isolate cache of the live canary deploy-ref pointers (the Spec DO read in applyCanaryRefs).
 *
 * Every mirrored request needs the pointers; one DO round trip per request is too much. So:
 *   - A successful read is served for `ttlMs`. A rollback (ref move in the DO) is therefore
 *     visible to this isolate within `ttlMs` (default 5s); each isolate caches independently,
 *     so the bound holds fleet-wide.
 *   - If the DO read fails, the last cached value is served for at most one extra TTL (its age
 *     stays < 2 x ttlMs, measured from when that read started), then the caller falls back to
 *     the static config (get() returns null). Worst-case staleness of an old pointer: 2 x ttlMs.
 *   - An error is never cached: a failed read stores nothing, and the next request retries.
 *   - Concurrent requests that find the entry expired share one in-flight read.
 *   - ttlMs = 0 disables the cache entirely: every call reads (the pre-cache behaviour).
 */

import type { LiveRef } from '../shared/deploy-refs';

export const DEFAULT_LIVE_REFS_TTL_MS = 5000;
/** Upper bound, so a typo cannot make a rollback invisible for minutes */
export const MAX_LIVE_REFS_TTL_MS = 60_000;

/**
 * LIVE_REFS_CACHE_TTL_MS: unset or not a non-negative number -> the default; 0 disables;
 * values above MAX_LIVE_REFS_TTL_MS are clamped.
 */
export function resolveLiveRefsTtlMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIVE_REFS_TTL_MS;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LIVE_REFS_TTL_MS;
  return Math.min(Math.floor(n), MAX_LIVE_REFS_TTL_MS);
}

/** A loader returns the value, or null when the read failed (it may also throw) */
export type Loader<T> = () => Promise<T | null>;

export class LiveRefsCache<T = LiveRef[]> {
  private entry: { value: T; at: number } | null = null;
  private inflight: Promise<T | null> | null = null;

  constructor(
    readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** The value, or null when no value may be served (caller uses the static config) */
  async get(load: Loader<T>): Promise<T | null> {
    if (this.ttlMs <= 0) return this.safeLoad(load);

    const entry = this.entry;
    if (entry && this.now() - entry.at < this.ttlMs) return entry.value;

    const fresh = await this.refresh(load);
    if (fresh !== null) return fresh;

    // Read failed: the previous value, for one extra TTL at most
    const stale = this.entry;
    if (stale && this.now() - stale.at < 2 * this.ttlMs) return stale.value;
    return null;
  }

  private refresh(load: Loader<T>): Promise<T | null> {
    if (this.inflight) return this.inflight;
    const startedAt = this.now();
    const read = this.safeLoad(load)
      .then((value) => {
        if (value !== null) this.entry = { value, at: startedAt };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = read;
    return read;
  }

  private async safeLoad(load: Loader<T>): Promise<T | null> {
    try {
      return await load();
    } catch {
      return null;
    }
  }
}

let shared: LiveRefsCache | null = null;

/** The isolate's cache, sized from env.LIVE_REFS_CACHE_TTL_MS (rebuilt if the TTL changes) */
export function getLiveRefsCache(env: { LIVE_REFS_CACHE_TTL_MS?: unknown } | undefined): LiveRefsCache {
  const ttl = resolveLiveRefsTtlMs(env?.LIVE_REFS_CACHE_TTL_MS);
  if (!shared || shared.ttlMs !== ttl) shared = new LiveRefsCache(ttl);
  return shared;
}

/** Test hook */
export function resetLiveRefsCache(): void {
  shared = null;
}

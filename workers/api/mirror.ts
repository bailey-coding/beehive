/**
 * The mirror source (docs/plans/shadow-router-followup-plan.md slice M): after the response exists, the `beehive` worker copies a
 * sample of its own GET/HEAD requests to the shadow router, reduced here to `{ v, method, path }` with the path a route template.
 * No raw request, header, credential, query string or body ever leaves this worker toward the router.
 *
 * Off by default: MIRROR_SAMPLE_PERCENT (integer 0-100) is set by the maintainer in `[vars]` of the deploy repo, never in the repo's
 * own wrangler.toml (tests/unit/mirror-vars-not-enabled.test.ts). Invalid or 0 = the hook does nothing at all.
 * Never delays or alters a response; every failure is swallowed and counted.
 */
import { PLATFORM_ROUTE_WORDS, routeTemplate, routeWords } from '../shared/route-template';
import { MIRROR_MARKER_HEADER, MIRROR_METHODS, type MirrorDescriptor } from '../shared/mirror-descriptor';

export interface MirrorEnv {
  MIRROR_SAMPLE_PERCENT?: string;
  MIRROR_ROUTE_WORDS?: string;
  API_AUTH_TOKEN?: string;
  SHADOW_ROUTER?: { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** Paths that are never mirrored: health probes and the router's own surface */
const SKIPPED_PATHS = ['/health', '/api/health', '/mirror', '/statsig'];
const MAX_IN_FLIGHT = 10;
const BUCKET_CAPACITY = 20;
const BUCKET_REFILL_PER_SECOND = 10;
const MIRROR_TIMEOUT_MS = 2_000;

export const mirrorCounters = { sent: 0, failed: 0, droppedRate: 0, droppedInFlight: 0 };

// Per-isolate state: a rate cap (token bucket) and a concurrency cap bound what an anonymous client can drive through `/`
let inFlight = 0;
let tokens = BUCKET_CAPACITY;
let lastRefill = 0;

export function resetMirrorState(): void {
  inFlight = 0;
  tokens = BUCKET_CAPACITY;
  lastRefill = 0;
  mirrorCounters.sent = mirrorCounters.failed = mirrorCounters.droppedRate = mirrorCounters.droppedInFlight = 0;
}

/** 0 for absent or anything but an integer 0-100 */
export function mirrorPercent(env: Pick<MirrorEnv, 'MIRROR_SAMPLE_PERCENT'>): number {
  const raw = env.MIRROR_SAMPLE_PERCENT;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw.trim())) return 0;
  const n = Number(raw.trim());
  return n >= 0 && n <= 100 ? n : 0;
}

function takeToken(now: number): boolean {
  if (lastRefill === 0) lastRefill = now;
  tokens = Math.min(BUCKET_CAPACITY, tokens + ((now - lastRefill) / 1000) * BUCKET_REFILL_PER_SECOND);
  lastRefill = now;
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

/** What a request is reduced to: null when it must not be mirrored */
export function describeRequest(method: string, pathname: string, env: Pick<MirrorEnv, 'MIRROR_ROUTE_WORDS'>): MirrorDescriptor | null {
  const upper = method.toUpperCase();
  if (!(MIRROR_METHODS as readonly string[]).includes(upper)) return null;
  if (SKIPPED_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) return null;
  return { v: 1, method: upper as MirrorDescriptor['method'], path: routeTemplate(pathname, routeWords({ MIRROR_ROUTE_WORDS: [...PLATFORM_ROUTE_WORDS, env.MIRROR_ROUTE_WORDS ?? ''].join(',') })) };
}

/**
 * Schedules the mirror work. `method`, `pathname` and `marked` are read by the caller before the request is consumed or reassigned.
 * Returns the promise handed to ctx.waitUntil, or null when nothing is scheduled (the gate is off, or the request is skipped).
 */
export function mirrorAfterResponse(
  input: { method: string; pathname: string; marked: boolean },
  env: MirrorEnv,
  deps: { random?: () => number; now?: () => number } = {}
): Promise<void> | null {
  const percent = mirrorPercent(env);
  if (percent === 0) return null; // off: no parsing, no I/O
  if (input.marked) return null; // a request the router sent (candidate or baseline fetch): never mirror it again
  if (!env.SHADOW_ROUTER || !env.API_AUTH_TOKEN) return null;
  const descriptor = describeRequest(input.method, input.pathname, env);
  if (!descriptor) return null;
  if ((deps.random ?? Math.random)() * 100 >= percent) return null;
  if (!takeToken((deps.now ?? Date.now)())) {
    mirrorCounters.droppedRate++;
    return null;
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    mirrorCounters.droppedInFlight++;
    return null;
  }
  inFlight++;
  const router = env.SHADOW_ROUTER;
  const token = env.API_AUTH_TOKEN;
  return (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MIRROR_TIMEOUT_MS);
    try {
      const response = await router.fetch('https://shadow-router.internal/mirror', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(descriptor),
        signal: controller.signal,
      });
      void response.body?.cancel();
      if (response.ok) mirrorCounters.sent++;
      else mirrorCounters.failed++; // a non-OK answer is an error, never "mirrored" (an older router has no /mirror route; its generic path answers 200 without fanning out, which counts as sent but does nothing)
    } catch {
      mirrorCounters.failed++;
    } finally {
      clearTimeout(timer);
      inFlight--;
    }
  })();
}

export { MIRROR_MARKER_HEADER };

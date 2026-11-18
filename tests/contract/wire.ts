/**
 * Contract-test wiring (docs/plans/wave-1-plan.md part A, review e M3): one real Spec DO on node:sqlite (foreign keys on, no dev seed: the
 * env has no DEV) and the real worker handlers bound to it. Rule for files that use this: no vi.fn() and no hand-written fake for SPEC_DO or a
 * peer binding; only the network outside the platform (GitHub, Artifacts, candidate Workers) may be stubbed.
 *
 * Workers get the raw DO and carry their own tier-1 token (spec-do/tests/do-tokens.ts), so a worker that calls an admin route fails here as
 * it would in production. `direct` (both tokens) is only for the test's own arrange calls.
 */
import { vi } from 'vitest';
import { makeSqliteState, makeSpecDo } from '../../workers/spec-do/tests/sqlite-state';
import { authedDo, TEST_INTERNAL_ONLY } from '../../workers/spec-do/tests/do-tokens';
import gateWorkflow from '../../workers/gate-workflow/index';

export const API_TOKEN = 'contract-api-token';

/** Bindings are called both as fetch(request) and fetch(url, init) */
const asRequest = (input: Request | string | URL, init?: RequestInit) => (input instanceof Request && !init ? input : new Request(input, init));

export function wire() {
  const store = makeSqliteState();
  const spec = makeSpecDo(store, false);
  const direct = authedDo(spec);
  const SPEC_DO = { idFromName: () => 'main', get: () => ({ fetch: (i: Request | string, init?: RequestInit) => spec.fetch(asRequest(i, init)) }) };
  const base = { SPEC_DO, API_AUTH_TOKEN: API_TOKEN, ...TEST_INTERNAL_ONLY };
  const ctx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;

  const gateEnv = { ...base };
  const GATE_WORKFLOW = { fetch: (i: Request | string, init?: RequestInit) => gateWorkflow.fetch(asRequest(i, init), gateEnv as never, ctx) };
  const previewCalls: Request[] = [];
  const PREVIEW_MANAGER = {
    fetch: async (i: Request | string, init?: RequestInit) => {
      previewCalls.push(asRequest(i, init));
      return Response.json({ success: true, data: {} });
    },
  };

  const count = (sql: string, ...args: unknown[]) => (store.raw.prepare(sql).get(...(args as never[])) as { n: number }).n;
  return { store, spec, direct, base, ctx, GATE_WORKFLOW, PREVIEW_MANAGER, previewCalls, count };
}

/** A Cloudflare-queue batch whose messages record ack/retry */
export function batch<T>(queue: string, bodies: T[]) {
  const messages = bodies.map((body, i) => ({
    id: `m${i}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return { queue, messages, ackAll: vi.fn(), retryAll: vi.fn() };
}

/** Run waitUntil promises in order, including ones registered while earlier ones run, until `done` holds or none are left */
export function drainingCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
  const drain = async (done: () => boolean = () => false) => {
    while (pending.length && !done()) await pending.shift();
  };
  return { ctx, drain };
}

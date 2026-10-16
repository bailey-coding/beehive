/**
 * Test fixtures for the Spec DO's two-tier internal auth (workers/shared/spec-do-auth.ts).
 * Real DOs in tests are built with TEST_DO_TOKENS; direct-call tests wrap them with authedDo
 * (the headers a worker would attach), worker-wiring tests use the raw DO and give the worker
 * env the matching tokens, so the worker's own client is what authenticates.
 */
import { authedSpecDoStub } from '../../shared/spec-do-auth';

export const TEST_INTERNAL_TOKEN = 'test-do-internal-token';
export const TEST_ADMIN_TOKEN = 'test-do-admin-token';

/** The DO host's secrets */
export const TEST_DO_TOKENS = {
  SPEC_DO_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
  SPEC_DO_ADMIN_TOKEN: TEST_ADMIN_TOKEN,
};

/** What a non-API worker holds: tier 1 only */
export const TEST_INTERNAL_ONLY = { SPEC_DO_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN };

/** The same DO whose fetch carries both tokens (admin only on admin routes), like the API worker */
export function authedDo<T extends { fetch(request: Request): Promise<Response> }>(spec: T): T {
  const stub = authedSpecDoStub({ fetch: (r) => spec.fetch(r as Request) as never }, TEST_DO_TOKENS);
  return new Proxy(spec, {
    get(target, prop) {
      if (prop === 'fetch') return (request: Request) => stub.fetch(request);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

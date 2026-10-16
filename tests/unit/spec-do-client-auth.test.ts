/**
 * Every worker that calls the Spec DO attaches its own tier-1 token (X-Beehive-Internal) from its
 * env, and none of them sends the admin token (only the beehive API worker holds it).
 * Each worker is driven through its real entry point or client against a recording stub.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import candidateService from '../../workers/candidate-service/index';
import gateWorkflow from '../../workers/gate-workflow/index';
import previewManager from '../../workers/preview-manager/index';
import { deployRefsClient } from '../../workers/canary-worker/canary';
import { getSpecDo } from '../../workers/promotion-worker/spec-do';
import { SpecDOClient } from '../../workers/scientist-comparator/storage/spec-do';
import { specDoFetcher } from '../../workers/shadow-router/index';
import { ADMIN_TOKEN_HEADER, INTERNAL_TOKEN_HEADER } from '../../workers/shared/spec-do-auth';

const TOKEN = 'worker-tier1-token';

function recorder() {
  const calls: Request[] = [];
  const stub = {
    fetch: async (request: Request) => {
      calls.push(request);
      return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    },
  };
  const SPEC_DO = { idFromName: () => 'id', get: () => stub } as never;
  return { calls, SPEC_DO };
}

function expectTier1Only(calls: Request[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.headers.get(INTERNAL_TOKEN_HEADER), new URL(call.url).pathname).toBe(TOKEN);
    expect(call.headers.has(ADMIN_TOKEN_HEADER)).toBe(false);
  }
}

// Env deliberately holds only the tier-1 token; if a worker ever were handed the admin token
// the helper would still send it only on admin routes, which none of these workers call.
const AUTH = { Authorization: 'Bearer edge-token' };

describe('non-API workers attach the Spec DO tier-1 token', () => {
  it('canary-worker (DeployRefsClient)', async () => {
    const { calls, SPEC_DO } = recorder();
    await deployRefsClient({ SPEC_DO, SPEC_DO_INTERNAL_TOKEN: TOKEN } as never).getCanaryDeployment('d1');
    expectTier1Only(calls);
  });

  it('promotion-worker (getSpecDo, and the ledger client built on it)', async () => {
    const { calls, SPEC_DO } = recorder();
    await getSpecDo({ SPEC_DO, SPEC_DO_INTERNAL_TOKEN: TOKEN } as never).fetch('/promotion-mode');
    await getSpecDo({ SPEC_DO, SPEC_DO_INTERNAL_TOKEN: TOKEN } as never).fetch('/promotion-states', { method: 'GET' });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/promotion-mode', '/promotion-states']);
    expectTier1Only(calls);
  });

  it('scientist-comparator (SpecDOClient)', async () => {
    const { calls, SPEC_DO } = recorder();
    await new SpecDOClient({ SPEC_DO, SPEC_DO_INTERNAL_TOKEN: TOKEN } as never).getSpec('spec-1');
    expectTier1Only(calls);
  });

  it('shadow-router (deploy-ref read)', async () => {
    const { calls, SPEC_DO } = recorder();
    await specDoFetcher({ SPEC_DO, SPEC_DO_INTERNAL_TOKEN: TOKEN })!.fetch('/deploy-refs/live?rung=canary');
    expectTier1Only(calls);
  });

  it('candidate-service', async () => {
    const { calls, SPEC_DO } = recorder();
    const env = { SPEC_DO, SPEC_DO_INTERNAL_TOKEN: TOKEN, API_AUTH_TOKEN: 'edge-token' };
    await candidateService.fetch(new Request('https://x/api/candidates/c1/preview', { headers: AUTH }), env as never, {} as never);
    expectTier1Only(calls);
  });

  it('gate-workflow', async () => {
    const { calls, SPEC_DO } = recorder();
    const env = { SPEC_DO, SPEC_DO_INTERNAL_TOKEN: TOKEN, API_AUTH_TOKEN: 'edge-token' };
    const body = { candidateId: crypto.randomUUID(), specId: crypto.randomUUID(), commitSha: 'a'.repeat(40), baseCommitSha: 'b'.repeat(40), actorId: crypto.randomUUID() };
    await gateWorkflow.fetch(
      new Request('https://x/gates/pre-merge', {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env as never,
      {} as never
    );
    expectTier1Only(calls);
  });

  it('preview-manager', async () => {
    const { calls, SPEC_DO } = recorder();
    const env = {
      SPEC_DO,
      SPEC_DO_INTERNAL_TOKEN: TOKEN,
      API_AUTH_TOKEN: 'edge-token',
      WORKER_VERSIONS_MODE: 'stub',
      BEEHIVE_LOCAL_DEV: '1',
    };
    await previewManager.fetch(
      new Request('https://x/api/preview/canary', {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId: 'c1', specId: 's1' }),
      }),
      env as never,
      {} as never
    );
    expectTier1Only(calls);
  });
});

describe('guard: no worker reaches the Spec DO except through the authed stub', () => {
  // queue-consumer is covered here: it only reaches the DO from queue batches
  const root = join(__dirname, '..', '..', 'workers');
  const allowed = new Set(['shared/spec-do-auth.ts']);

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules' || name === 'tests' || name === 'ui') return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
    });
  }

  it('no source builds a stub from the namespace by hand', () => {
    const offenders = sources(root)
      .filter((file) => !allowed.has(relative(root, file)))
      .filter((file) => /SPEC_DO\s*\.\s*(get|idFromName)\s*\(|specDo\s*\.\s*(get|idFromName)\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  it('queue-consumer builds its Spec DO stub with getSpecDoStub', () => {
    const src = readFileSync(join(root, 'queue-consumer', 'index.ts'), 'utf8');
    expect(src).toMatch(/getSpecDoStub\(env/);
  });
});

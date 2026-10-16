/**
 * Two-tier internal auth on the Spec DO's fetch router (workers/shared/spec-do-auth.ts).
 * Real SpecDO over node:sqlite; requests are sent raw, with no token helper in between.
 */
import { describe, it, expect } from 'vitest';
import { makeSqliteState } from './sqlite-state';
import { SpecDO } from '../index';
import { TEST_ADMIN_TOKEN, TEST_INTERNAL_TOKEN } from './do-tokens';
import {
  ADMIN_TOKEN_HEADER,
  INTERNAL_TOKEN_HEADER,
  authedSpecDoStub,
  isAdminRoute,
  specDoAuthGate,
  timingSafeEqual,
} from '../../shared/spec-do-auth';

const TIER1 = { [INTERNAL_TOKEN_HEADER]: TEST_INTERNAL_TOKEN };
const BOTH = { ...TIER1, [ADMIN_TOKEN_HEADER]: TEST_ADMIN_TOKEN };

function makeDo(env: Record<string, string> = { SPEC_DO_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN, SPEC_DO_ADMIN_TOKEN: TEST_ADMIN_TOKEN }) {
  return new SpecDO(makeSqliteState().state as never, env as never);
}

const send = (spec: SpecDO, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );

// One representative request per privileged route
const ADMIN_ROUTES: Array<[string, string, unknown]> = [
  ['POST', '/internal/purge', { orgIds: [] }],
  ['POST', '/internal/tombstone', { entityType: 'organization', id: 'x' }],
  ['POST', '/internal/actors/a1/role', { role: 'maintainer' }],
  ['POST', '/internal/service-accounts', { name: 'n' }],
  ['GET', '/internal/service-accounts', undefined],
  ['POST', '/internal/service-accounts/s1/revoke', undefined],
  ['POST', '/internal/service-accounts/s1/tokens', {}],
  ['POST', '/internal/service-accounts/s1/tokens/t1/revoke', undefined],
  ['PATCH', '/api/actors/a1/promotion-authority', undefined],
];

// Routes the non-API workers call
const TIER1_ROUTES: Array<[string, string]> = [
  ['GET', '/health'],
  ['GET', '/api/organizations'],
  ['GET', '/promotion-mode'],
  ['GET', '/promotion-states'],
  ['GET', '/tournament-status'],
  ['GET', '/merge-train-status'],
  ['GET', '/deploy-refs/live?rung=canary'],
  ['GET', '/canary-deployments'],
];

describe('Spec DO internal auth gate', () => {
  it('missing token -> 401 on every route, admin or not', async () => {
    const spec = makeDo();
    for (const [method, path] of TIER1_ROUTES) expect((await send(spec, method, path)).status, path).toBe(401);
    for (const [method, path, body] of ADMIN_ROUTES) expect((await send(spec, method, path, {}, body)).status, path).toBe(401);
  });

  it('wrong tier-1 token -> 401, even with a valid admin token', async () => {
    const spec = makeDo();
    const wrong = { [INTERNAL_TOKEN_HEADER]: 'nope', [ADMIN_TOKEN_HEADER]: TEST_ADMIN_TOKEN };
    expect((await send(spec, 'GET', '/health', wrong)).status).toBe(401);
    expect((await send(spec, 'POST', '/internal/purge', wrong, { orgIds: [] })).status).toBe(401);
    // A prefix or a longer token is just as wrong
    expect((await send(spec, 'GET', '/health', { [INTERNAL_TOKEN_HEADER]: TEST_INTERNAL_TOKEN.slice(0, -1) })).status).toBe(401);
    expect((await send(spec, 'GET', '/health', { [INTERNAL_TOKEN_HEADER]: TEST_INTERNAL_TOKEN + 'x' })).status).toBe(401);
  });

  it('the edge API_AUTH_TOKEN is not a Spec DO token', async () => {
    const spec = makeDo({ API_AUTH_TOKEN: 'edge', SPEC_DO_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN, SPEC_DO_ADMIN_TOKEN: TEST_ADMIN_TOKEN });
    expect((await send(spec, 'GET', '/health', { Authorization: 'Bearer edge', [INTERNAL_TOKEN_HEADER]: 'edge' })).status).toBe(401);
  });

  it('a tier-1 token reaches every non-admin route', async () => {
    const spec = makeDo();
    for (const [method, path] of TIER1_ROUTES) {
      const status = (await send(spec, method, path, TIER1)).status;
      expect([401, 403, 503], `${method} ${path}`).not.toContain(status);
    }
  });

  it('a valid tier-1 token on an admin route -> 403, and nothing runs', async () => {
    const spec = makeDo();
    for (const [method, path, body] of ADMIN_ROUTES) {
      expect((await send(spec, method, path, TIER1, body)).status, `${method} ${path}`).toBe(403);
    }
    // wrong admin token is the same 403
    const wrongAdmin = { ...TIER1, [ADMIN_TOKEN_HEADER]: 'nope' };
    expect((await send(spec, 'POST', '/internal/purge', wrongAdmin, { orgIds: [] })).status).toBe(403);
    // the admin token alone (no tier 1) is 401
    expect((await send(spec, 'POST', '/internal/purge', { [ADMIN_TOKEN_HEADER]: TEST_ADMIN_TOKEN }, { orgIds: [] })).status).toBe(401);
  });

  it('both tokens pass the gate on admin routes', async () => {
    const spec = makeDo();
    for (const [method, path, body] of ADMIN_ROUTES) {
      const status = (await send(spec, method, path, BOTH, body)).status;
      expect([401, 403, 503], `${method} ${path}`).not.toContain(status);
    }
  });

  it('DO secret unset -> 503, never open (even /health and with any header)', async () => {
    const spec = makeDo({});
    expect((await send(spec, 'GET', '/health')).status).toBe(503);
    expect((await send(spec, 'GET', '/health', BOTH)).status).toBe(503);
    expect((await send(spec, 'GET', '/promotion-mode', { [INTERNAL_TOKEN_HEADER]: '' })).status).toBe(503);
    expect((await send(spec, 'POST', '/internal/purge', BOTH, { orgIds: [] })).status).toBe(503);
  });

  it('admin secret unset: tier-1 routes still work, admin routes are 503 (never open)', async () => {
    const spec = makeDo({ SPEC_DO_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN });
    expect((await send(spec, 'GET', '/health', TIER1)).status).toBe(200);
    expect((await send(spec, 'POST', '/internal/purge', TIER1, { orgIds: [] })).status).toBe(503);
    expect((await send(spec, 'POST', '/internal/purge', { ...TIER1, [ADMIN_TOKEN_HEADER]: '' }, { orgIds: [] })).status).toBe(503);
  });

  it('error bodies never contain a token value', async () => {
    const spec = makeDo();
    const texts = [
      await (await send(spec, 'GET', '/health', { [INTERNAL_TOKEN_HEADER]: 'guess-1' })).text(),
      await (await send(spec, 'POST', '/internal/purge', { ...TIER1, [ADMIN_TOKEN_HEADER]: 'guess-2' }, {})).text(),
      await (await send(makeDo({}), 'GET', '/health')).text(),
    ];
    for (const t of texts) {
      for (const secret of [TEST_INTERNAL_TOKEN, TEST_ADMIN_TOKEN, 'guess-1', 'guess-2']) expect(t).not.toContain(secret);
    }
  });

  it('the gate runs before the schema is touched', async () => {
    const state = makeSqliteState();
    const spec = new SpecDO(state.state as never, { SPEC_DO_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN } as never);
    expect((await send(spec, 'GET', '/api/organizations')).status).toBe(401);
    expect(state.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).toEqual([]);
  });
});

describe('timingSafeEqual', () => {
  it('compares equal and unequal strings, including length and encoding edge cases', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('abcd', 'abc')).toBe(false);
    expect(timingSafeEqual('', 'a')).toBe(false);
    expect(timingSafeEqual('é', 'é')).toBe(true);
    expect(timingSafeEqual('é', 'e')).toBe(false);
  });
});

describe('isAdminRoute / specDoAuthGate', () => {
  it('classifies privileged routes only', () => {
    for (const [method, path] of ADMIN_ROUTES) expect(isAdminRoute(method, path), `${method} ${path}`).toBe(true);
    for (const [method, path] of TIER1_ROUTES) expect(isAdminRoute(method, path.split('?')[0]), `${method} ${path}`).toBe(false);
    expect(isAdminRoute('POST', '/internal/service-tokens/verify')).toBe(false);
    expect(isAdminRoute('GET', '/api/actors/a1/promotion-authority')).toBe(false);
    expect(isAdminRoute('post', '/internal/purge')).toBe(true);
    // lookalikes are not privileged, and not accidentally matched mid-path
    expect(isAdminRoute('GET', '/internal/purge')).toBe(false);
    expect(isAdminRoute('POST', '/x/internal/purge')).toBe(false);
  });

  it('gate with an undefined env is 503', () => {
    expect(specDoAuthGate(new Request('https://spec-do.internal/health'), undefined)?.status).toBe(503);
  });
});

describe('authedSpecDoStub', () => {
  it('attaches tier 1 everywhere and the admin token only on admin routes, only when held', async () => {
    const seen: Request[] = [];
    const inner = { fetch: async (r: Request) => (seen.push(r), new Response('ok')) };
    const full = authedSpecDoStub(inner as never, { SPEC_DO_INTERNAL_TOKEN: 't1', SPEC_DO_ADMIN_TOKEN: 't2' });
    await full.fetch('/api/organizations');
    await full.fetch('https://spec-do.internal/internal/purge', { method: 'POST', body: '{}' });
    await full.fetch(new Request('https://spec-do.internal/internal/tombstone', { method: 'POST', body: '{}' }));
    expect(seen.map((r) => [new URL(r.url).pathname, r.headers.get(INTERNAL_TOKEN_HEADER), r.headers.get(ADMIN_TOKEN_HEADER)])).toEqual([
      ['/api/organizations', 't1', null],
      ['/internal/purge', 't1', 't2'],
      ['/internal/tombstone', 't1', 't2'],
    ]);

    seen.length = 0;
    const tier1Only = authedSpecDoStub(inner as never, { SPEC_DO_INTERNAL_TOKEN: 't1' });
    await tier1Only.fetch('/internal/purge', { method: 'POST', body: '{}' });
    expect(seen[0].headers.get(INTERNAL_TOKEN_HEADER)).toBe('t1');
    expect(seen[0].headers.has(ADMIN_TOKEN_HEADER)).toBe(false);
  });

  it('overwrites token headers the caller set, and keeps method, body and other headers', async () => {
    const seen: Request[] = [];
    const stub = authedSpecDoStub({ fetch: async (r: Request) => (seen.push(r), new Response('ok')) } as never, {
      SPEC_DO_INTERNAL_TOKEN: 't1',
    });
    await stub.fetch('/api/specs', { method: 'POST', headers: { [INTERNAL_TOKEN_HEADER]: 'spoof', 'X-Actor-ID': 'a' }, body: '{"k":1}' });
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers.get(INTERNAL_TOKEN_HEADER)).toBe('t1');
    expect(seen[0].headers.get('X-Actor-ID')).toBe('a');
    expect(await seen[0].text()).toBe('{"k":1}');
  });
});

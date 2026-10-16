/**
 * Service-account tests (read-only slice). The edge worker is driven against the
 * real SpecDO and the real SQL adapter, backed by node:sqlite, so token
 * storage, hashing, revocation and the adapter's bind/step behavior are exercised end to end.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../index';
import { SpecDO } from '../../spec-do/index';
import { createSqlStorage } from '../../spec-do/sql-storage';
import { generateServiceToken, hashToken, SERVICE_TOKEN_PREFIX } from '../../shared/service-tokens';

// Vite does not resolve node:sqlite as a static import; load the builtin directly.
const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

const MASTER = 'master-token-for-tests';

function fakeState() {
  const db = new DatabaseSync(':memory:');
  const kv = new Map<string, unknown>();
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      let rows: Record<string, unknown>[] = [];
      let columnNames: string[] = [];
      if (/^\s*SELECT/i.test(query)) {
        const stmt = db.prepare(query);
        rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
        columnNames = stmt.columns().map((c) => c.name);
      } else if (bindings.length) {
        db.prepare(query).run(...(bindings as never[]));
      } else {
        db.exec(query);
      }
      let i = 0;
      return {
        columnNames,
        next: () => (i < rows.length ? { value: rows[i++] } : { done: true as const }),
      };
    },
  };
  const state = {
    storage: {
      sql,
      get: async (k: string) => kv.get(k),
      put: async (k: string, v: unknown) => void kv.set(k, v),
      transactionSync: <T>(fn: () => T): T => {
        db.exec('BEGIN');
        try {
          const r = fn();
          db.exec('COMMIT');
          return r;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
  };
  return { state, db };
}

function setup() {
  const { state, db } = fakeState();
  const calls: { path: string; method: string; headers: Headers }[] = [];
  const real = new SpecDO(state as never, {} as never);
  const stub = {
    fetch: (req: Request) => {
      calls.push({ path: new URL(req.url).pathname, method: req.method, headers: req.headers });
      return real.fetch(req);
    },
  };
  const env = {
    SPEC_DO: { idFromName: () => 'id', get: () => stub },
    API_AUTH_TOKEN: MASTER,
  };
  const call = (path: string, method = 'GET', opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    worker.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }),
      env as never,
      {} as never
    );
  return { call, calls, db, env, real };
}

async function mint(call: ReturnType<typeof setup>['call'], name = 'monitor') {
  const res = await call('/api/admin/service-accounts', 'POST', { token: MASTER, body: { name, scopes: ['read'] } });
  return { res, json: (await res.json()) as any };
}

describe('service token helpers', () => {
  it('generates bh_svc_ tokens of 32 random bytes and hashes deterministically', async () => {
    const t = generateServiceToken();
    expect(t.startsWith(SERVICE_TOKEN_PREFIX)).toBe(true);
    expect(t.length).toBe(SERVICE_TOKEN_PREFIX.length + 43);
    const h = await hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken(t)).toBe(h);
    expect(generateServiceToken()).not.toBe(t);
  });
});

describe('fail-closed auth', () => {
  it('missing API_AUTH_TOKEN -> 503 for every bearer, including /health', async () => {
    const { env } = setup();
    for (const auth of [undefined, `Bearer ${MASTER}`, `Bearer ${generateServiceToken()}`]) {
      const res = await worker.fetch(
        new Request('http://localhost/health', { headers: auth ? { Authorization: auth } : {} }),
        { ...env, API_AUTH_TOKEN: undefined } as never,
        {} as never
      );
      expect(res.status).toBe(503);
    }
  });

  it('wrong or missing bearer -> 401 including /health, with no DO call', async () => {
    const { call, calls } = setup();
    expect((await call('/health')).status).toBe(401);
    expect((await call('/health', 'GET', { token: 'nope' })).status).toBe(401);
    expect((await call('/api/specs', 'GET', { token: 'bh_svc_short' })).status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it('master token still works via Authorization and X-API-Token', async () => {
    const { call } = setup();
    expect((await call('/health', 'GET', { token: MASTER })).status).toBe(200);
    expect((await call('/health', 'GET', { headers: { 'X-API-Token': MASTER } })).status).toBe(200);
  });
});

describe('service account lifecycle', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('create returns plaintext once; only hash and prefix are stored; list never leaks', async () => {
    const { res, json } = await mint(ctx.call);
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const plaintext: string = json.data.token.plaintext;
    expect(plaintext.startsWith('bh_svc_')).toBe(true);

    const rows = ctx.db.prepare('SELECT * FROM service_tokens').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].token_hash).toBe(await hashToken(plaintext));
    expect(JSON.stringify(rows)).not.toContain(plaintext);
    expect(JSON.stringify(rows)).not.toContain(plaintext.slice(12));

    const list = await ctx.call('/api/admin/service-accounts', 'GET', { token: MASTER });
    const text = await list.text();
    expect(text).not.toContain(plaintext);
    expect(text).not.toContain('token_hash');
    expect(text).toContain('monitor');
  });

  it('rejects non-read scopes, bad names, duplicates', async () => {
    const bad = await ctx.call('/api/admin/service-accounts', 'POST', {
      token: MASTER, body: { name: 'e2e', scopes: ['read', 'write'] },
    });
    expect(bad.status).toBe(400);
    const badName = await ctx.call('/api/admin/service-accounts', 'POST', {
      token: MASTER, body: { name: 'Bad Name' },
    });
    expect(badName.status).toBe(400);
    expect((await mint(ctx.call)).res.status).toBe(201);
    expect((await mint(ctx.call)).res.status).toBe(409);
  });

  it('read token: GET works, every write is 403, admin is 403, unknown route is 403', async () => {
    const { json } = await mint(ctx.call);
    const t = json.data.token.plaintext;
    expect((await ctx.call('/health', 'GET', { token: t })).status).toBe(200);
    expect((await ctx.call('/api/organizations', 'GET', { token: t })).status).toBe(200);
    const who = await ctx.call('/api/whoami', 'GET', { token: t });
    expect(who.status).toBe(200);
    expect(((await who.json()) as any).data.actorId).toBe(json.data.account.actorId);

    for (const [method, path] of [
      ['POST', '/api/organizations'],
      ['POST', '/api/specs'],
      ['PATCH', '/api/candidates/x/stage'],
      ['POST', '/api/promotions'],
      ['PATCH', '/api/actors/x/promotion-authority'],
      ['POST', '/api/admin/service-accounts'],
      ['GET', '/api/admin/service-accounts'],
      ['GET', '/internal/service-accounts'],
      ['GET', '/something-new'],
    ]) {
      const res = await ctx.call(path, method, { token: t, body: method === 'GET' ? undefined : { name: 'x' } });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('spoofed X-Actor-ID is replaced with the service actor on reads', async () => {
    const { json } = await mint(ctx.call);
    const t = json.data.token.plaintext;
    ctx.calls.length = 0;
    await ctx.call('/api/specs', 'GET', { token: t, headers: { 'X-Actor-ID': 'someone-else' } });
    const who = await ctx.call('/api/whoami', 'GET', { token: t, headers: { 'X-Actor-ID': 'someone-else' } });
    expect(((await who.json()) as any).data.actorId).toBe(json.data.account.actorId);
  });

  it('revocation is immediate; unknown token is 401', async () => {
    const { json } = await mint(ctx.call);
    const t = json.data.token.plaintext;
    expect((await ctx.call('/api/organizations', 'GET', { token: t })).status).toBe(200);
    const rev = await ctx.call(`/api/admin/service-accounts/${json.data.account.id}/revoke`, 'POST', { token: MASTER });
    expect(rev.status).toBe(200);
    expect((await ctx.call('/api/organizations', 'GET', { token: t })).status).toBe(401);
    expect((await ctx.call(`/api/admin/service-accounts/${json.data.account.id}/revoke`, 'POST', { token: MASTER })).status).toBe(200);
    expect((await ctx.call('/health', 'GET', { token: generateServiceToken() })).status).toBe(401);
    expect((await ctx.call('/api/admin/service-accounts/nope/revoke', 'POST', { token: MASTER })).status).toBe(404);
  });

  it('expired token is 401', async () => {
    const { json } = await mint(ctx.call);
    ctx.db.prepare('UPDATE service_tokens SET expires_at = ?').run(Date.now() - 1000);
    expect((await ctx.call('/health', 'GET', { token: json.data.token.plaintext })).status).toBe(401);
  });

  it('DO failure while verifying -> 503, never open', async () => {
    const { json } = await mint(ctx.call);
    ctx.db.exec('DROP TABLE service_tokens');
    const res = await ctx.call('/health', 'GET', { token: json.data.token.plaintext });
    expect(res.status).toBe(503);
  });
});

describe('resource IDs come from the pathname only', () => {
  it('PATCH /api/candidates/A/stage?x=/B/stage acts on A', async () => {
    const { call, calls } = setup();
    await call('/api/candidates/A/stage?x=/B/stage', 'PATCH', { token: MASTER, body: { stage: 'failed' } });
    expect(calls.map((c) => c.path)).toContain('/api/candidates/A/stage');
    expect(calls.map((c) => c.path)).not.toContain('/api/candidates/B/stage');
    calls.length = 0;
    await call('/api/specs/abc?x=/..', 'GET', { token: MASTER });
    expect(calls.map((c) => c.path)).toContain('/api/specs/abc');
  });
});

describe('SQL adapter statement reuse', () => {
  it('a reused statement drops the second write; fresh statements per write persist both', () => {
    const { state } = fakeState();
    const db = createSqlStorage(state as never);
    db.exec('CREATE TABLE m (k TEXT PRIMARY KEY, v TEXT)');
    const reused = db.prepare('INSERT INTO m (k, v) VALUES (?, ?)');
    reused.bind('a', '1');
    reused.step();
    reused.bind('b', '2');
    reused.step();
    reused.free();
    const rows = (state.storage.sql.exec('SELECT k FROM m') as any);
    let n = 0;
    while (!rows.next().done) n++;
    expect(n).toBe(1); // documents the adapter's behavior: callers must not reuse statements

    for (const [k, v] of [['c', '3'], ['d', '4']]) {
      const s = db.prepare('INSERT INTO m (k, v) VALUES (?, ?)');
      s.bind(k, v);
      s.step();
      s.free();
    }
    const again = state.storage.sql.exec('SELECT k FROM m') as any;
    let m = 0;
    while (!again.next().done) m++;
    expect(m).toBe(3);
  });

  it('SpecDO.init persists both schema_version and initialized_at', async () => {
    const { call, db } = setup();
    await call('/health', 'GET', { token: MASTER });
    // init runs lazily on the first DO request
    await call('/api/organizations', 'GET', { token: MASTER });
    const keys = (db.prepare('SELECT key, value FROM metadata').all() as any[]).map((r) => r.key).sort();
    expect(keys).toEqual(['initialized_at', 'schema_version']);
    const v = db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as any;
    expect(v.value).toBe('m3');
  });
});

describe('service token security properties (edge + real DO)', () => {
  // Like setup(), but records every DO request body and lets a test replace the DO
  function setupWithBodies() {
    const { state, db } = fakeState();
    const real = new SpecDO(state as never, {} as never);
    const bodies: string[] = [];
    const doHeaders: { path: string; actor: string | null }[] = [];
    let override: ((req: Request) => Promise<Response>) | null = null;
    const stub = {
      fetch: async (req: Request) => {
        bodies.push(await req.clone().text());
        doHeaders.push({ path: new URL(req.url).pathname, actor: req.headers.get('X-Actor-ID') });
        return override ? override(req) : real.fetch(req);
      },
    };
    const env = { SPEC_DO: { idFromName: () => 'id', get: () => stub }, API_AUTH_TOKEN: MASTER };
    const call = (path: string, method = 'GET', opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
      worker.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
            ...opts.headers,
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        }),
        env as never,
        {} as never
      );
    return { call, db, bodies, doHeaders, setOverride: (f: typeof override) => (override = f) };
  }

  it('plaintext never reaches the DO or any log line; the DO only sees the hash', async () => {
    const logged: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) {
      console[k] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    }
    try {
      const ctx = setupWithBodies();
      const created = await ctx.call('/api/admin/service-accounts', 'POST', { token: MASTER, body: { name: 'monitor' } });
      const json = (await created.json()) as any;
      const t = json.data.token.plaintext as string;
      const rotated = await ctx.call(`/api/admin/service-accounts/${json.data.account.id}/tokens`, 'POST', { token: MASTER });
      const t2 = ((await rotated.json()) as any).data.token.plaintext as string;
      await ctx.call('/api/organizations', 'GET', { token: t });
      await ctx.call('/api/organizations', 'GET', { token: t2 });
      await ctx.call(`/api/admin/service-accounts/${json.data.account.id}/revoke`, 'POST', { token: MASTER });
      await ctx.call('/api/organizations', 'GET', { token: t });
      ctx.db.exec('DROP TABLE service_tokens');
      await ctx.call('/api/organizations', 'GET', { token: t2 });

      const doTraffic = ctx.bodies.join('\n');
      for (const secret of [t, t2]) {
        expect(doTraffic).not.toContain(secret);
        expect(doTraffic).not.toContain(secret.slice(12));
        expect(logged.join('\n')).not.toContain(secret.slice(12));
        expect(logged.join('\n')).not.toContain(await hashToken(secret));
      }
      expect(doTraffic).toContain(await hashToken(t));
    } finally {
      Object.assign(console, orig);
    }
  });

  it('a service principal reaches the DO as its own actor whatever X-Actor-ID it sends', async () => {
    const ctx = setupWithBodies();
    const json = (await (await ctx.call('/api/admin/service-accounts', 'POST', { token: MASTER, body: { name: 'monitor' } })).json()) as any;
    const victim = 'some-human-actor';
    ctx.doHeaders.length = 0;
    for (const path of ['/api/specs', '/api/organizations', '/api/candidates', '/api/whoami']) {
      expect((await ctx.call(path, 'GET', { token: json.data.token.plaintext, headers: { 'X-Actor-ID': victim } })).status).toBe(200);
    }
    // Read handlers forward no actor, or the rewritten one; the spoofed id never reaches the DO
    expect(ctx.doHeaders.length).toBeGreaterThan(0);
    for (const h of ctx.doHeaders) expect([null, json.data.account.actorId]).toContain(h.actor);
    expect(ctx.bodies.join('\n')).not.toContain(victim);
  });

  it('service principals cannot purge, tombstone, grant roles, or read tombstones', async () => {
    const ctx = setupWithBodies();
    const json = (await (await ctx.call('/api/admin/service-accounts', 'POST', { token: MASTER, body: { name: 'monitor' } })).json()) as any;
    const t = json.data.token.plaintext;
    ctx.doHeaders.length = 0;
    for (const [method, path, body] of [
      ['POST', '/api/admin/purge', { orgIds: ['x'], dryRun: true }],
      ['DELETE', '/api/organizations/x', {}],
      ['POST', `/api/admin/actors/${json.data.account.actorId}/role`, { role: 'maintainer' }],
      ['GET', '/api/organizations?include_deleted=1', undefined],
      ['POST', `/api/admin/service-accounts/${json.data.account.id}/tokens`, {}],
      ['POST', `/api/admin/service-accounts/${json.data.account.id}/revoke`, {}],
    ] as const) {
      const res = await ctx.call(path, method, { token: t, body });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // Only the token verifications reached the DO
    expect(ctx.doHeaders.every((h) => h.path === '/internal/service-tokens/verify')).toBe(true);
  });

  it('DO unreachable, erroring or answering a non-service principal -> 503, never master or anonymous', async () => {
    const ctx = setupWithBodies();
    const json = (await (await ctx.call('/api/admin/service-accounts', 'POST', { token: MASTER, body: { name: 'monitor' } })).json()) as any;
    const t = json.data.token.plaintext;
    const answers: (() => Promise<Response>)[] = [
      () => Promise.reject(new Error('DO down')),
      async () => new Response('boom', { status: 500 }),
      async () => new Response('not json', { status: 200 }),
      async () => new Response(JSON.stringify({ success: true, data: { kind: 'master', actorId: 'x' } }), { status: 200 }),
      async () => new Response(JSON.stringify({ success: true, data: { kind: 'service' } }), { status: 200 }),
    ];
    for (const answer of answers) {
      ctx.setOverride(answer);
      expect((await ctx.call('/api/organizations', 'GET', { token: t })).status).toBe(503);
      expect((await ctx.call('/api/organizations', 'POST', { token: t, body: { name: 'x' } })).status).toBe(503);
    }
  });

  it('rotation: a second token is shown once, both work, revoking one leaves the other', async () => {
    const ctx = setupWithBodies();
    const json = (await (await ctx.call('/api/admin/service-accounts', 'POST', { token: MASTER, body: { name: 'monitor' } })).json()) as any;
    const id = json.data.account.id;
    const t1 = json.data.token.plaintext;
    const rotated = await ctx.call(`/api/admin/service-accounts/${id}/tokens`, 'POST', { token: MASTER, body: { expiresInDays: 7 } });
    expect(rotated.status).toBe(201);
    expect(rotated.headers.get('Cache-Control')).toBe('no-store');
    const token2 = ((await rotated.json()) as any).data.token;
    expect(token2.plaintext.startsWith('bh_svc_')).toBe(true);
    expect(token2.expiresAt - Date.now()).toBeLessThanOrEqual(7 * 24 * 3_600_000);

    const list = await (await ctx.call('/api/admin/service-accounts', 'GET', { token: MASTER })).text();
    expect(list).not.toContain(t1);
    expect(list).not.toContain(token2.plaintext);
    expect(list).toContain(token2.prefix);

    const rev = await ctx.call(`/api/admin/service-accounts/${id}/tokens/${json.data.token.id}/revoke`, 'POST', { token: MASTER });
    expect(rev.status).toBe(200);
    expect((await ctx.call('/api/organizations', 'GET', { token: t1 })).status).toBe(401);
    expect((await ctx.call('/api/organizations', 'GET', { token: token2.plaintext })).status).toBe(200);

    expect((await ctx.call(`/api/admin/service-accounts/${id}/tokens`, 'POST', { token: MASTER, body: { expiresInDays: 0 } })).status).toBe(400);
    expect((await ctx.call('/api/admin/service-accounts/nope/tokens', 'POST', { token: MASTER })).status).toBe(404);
    await ctx.call(`/api/admin/service-accounts/${id}/revoke`, 'POST', { token: MASTER });
    expect((await ctx.call(`/api/admin/service-accounts/${id}/tokens`, 'POST', { token: MASTER })).status).toBe(409);
    expect((await ctx.call('/api/organizations', 'GET', { token: token2.plaintext })).status).toBe(401);
  });

  it('mint with an unknown X-Actor-ID -> 400; with a known one, it is recorded', async () => {
    const ctx = setupWithBodies();
    const bad = await ctx.call('/api/admin/service-accounts', 'POST', {
      token: MASTER,
      body: { name: 'monitor' },
      headers: { 'X-Actor-ID': 'nobody' },
    });
    expect(bad.status).toBe(400);
    const actor = (await (await ctx.call('/api/actors', 'POST', { token: MASTER, body: { type: 'human', name: 'alice' } })).json()) as any;
    const ok = await ctx.call('/api/admin/service-accounts', 'POST', {
      token: MASTER,
      body: { name: 'monitor' },
      headers: { 'X-Actor-ID': actor.data.id },
    });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).data.account.createdBy).toBe(actor.data.id);
  });

  it('the retired /api/service-accounts routes answer 410 and never list hashes', async () => {
    const ctx = setupWithBodies();
    const json = (await (await ctx.call('/api/admin/service-accounts', 'POST', { token: MASTER, body: { name: 'monitor' } })).json()) as any;
    for (const token of [MASTER, json.data.token.plaintext]) {
      const res = await ctx.call('/api/service-accounts', 'GET', { token });
      expect(res.status).toBe(410);
      expect(await res.text()).not.toContain('token_hash');
      expect((await ctx.call(`/api/service-accounts/${json.data.account.id}`, 'GET', { token })).status).toBe(410);
    }
    expect((await ctx.call('/api/service-accounts', 'POST', { token: MASTER, body: { name: 'x', scopes: 'write' } })).status).toBe(410);
  });
});

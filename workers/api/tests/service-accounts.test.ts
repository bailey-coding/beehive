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

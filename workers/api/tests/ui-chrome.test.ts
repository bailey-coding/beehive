/**
 * Lazy navigation source (M9 L2): the organization list is read once, only when a page renders,
 * never for non-GET requests, and a failed read is "unavailable", not "no organizations".
 *
 * Task: L2 | Spec: docs/M9-NAV-PLAN.md#2.1
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeSqliteState, makeSpecDo } from '../../spec-do/tests/sqlite-state';
import type { SpecDO } from '../../spec-do/index';
import { handleUi, signSession, type UiEnv } from '../ui';
import { loadChrome, lightChrome, makeChromeSource, memoizeReader, once } from '../ui-layout';
import type { DoReader, DoRow, Session } from '../ui-pages';

const session: Session = { login: 'testuser', actorId: 'a1', exp: Math.floor(Date.now() / 1000) + 3600 };
const url = new URL('http://localhost/app');

function fakeReader(impl: (path: string) => Promise<DoRow[]>): DoReader & { lists: string[] } {
  const lists: string[] = [];
  return {
    lists,
    get: async () => null,
    list: async (path) => {
      lists.push(path);
      return impl(path);
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('loadChrome', () => {
  it('reads /api/organizations unfiltered (limit only) and keeps valid ids', async () => {
    const reader = fakeReader(async () => [{ id: 'o1', name: 'Acme' }, { id: 'bad id', name: 'X' }]);
    const c = await loadChrome(reader, session, url);
    expect(reader.lists).toEqual(['/api/organizations']);
    expect(c.orgs).toEqual({ ok: true, orgs: [{ id: 'o1', name: 'Acme' }], total: 1 });
    expect(c.login).toBe('testuser');
  });

  it('does not throw when the reader throws; the result is ok:false', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await loadChrome(fakeReader(async () => { throw new Error('Spec DO error: boom'); }), session, url);
    expect(c.orgs).toEqual({ ok: false });
  });

  it('lightChrome skips the read', () => {
    expect(lightChrome(session, url).orgs).toEqual({ skipped: true });
  });
});

describe('makeChromeSource', () => {
  it('GET and HEAD read the list once however often the source is awaited', async () => {
    for (const method of ['GET', 'HEAD']) {
      const reader = fakeReader(async () => []);
      const source = makeChromeSource(method, reader, session, url);
      expect(reader.lists).toEqual([]); // lazy: nothing before a page awaits it
      await Promise.all([source(), source()]);
      await source();
      expect(reader.lists).toEqual(['/api/organizations']);
    }
  });

  it('every other method gets the light chrome and never reads', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const reader = fakeReader(async () => { throw new Error('must not be read'); });
      const c = await makeChromeSource(method, reader, session, url)();
      expect(c.orgs).toEqual({ skipped: true });
      expect(reader.lists).toEqual([]);
    }
  });

  it('once shares the in-flight promise, rejections included', async () => {
    const fn = vi.fn(async () => { throw new Error('x'); });
    const f = once(fn);
    await expect(f()).rejects.toThrow('x');
    await expect(f()).rejects.toThrow('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('memoizeReader keys', () => {
  it('a different limit is a different read (the key includes the limit)', async () => {
    const seen: Array<number | undefined> = [];
    const r = memoizeReader({
      get: async () => null,
      list: async (_p, limit) => {
        seen.push(limit);
        return [];
      },
    });
    await r.list('/api/organizations', 500);
    await r.list('/api/organizations', 100);
    expect(seen).toEqual([500, 100]);
  });
});

describe('memoizeReader', () => {
  it('shares identical reads by path and limit, in flight, rejections included', async () => {
    const lists: string[] = [];
    const gets: string[] = [];
    const inner: DoReader = {
      get: async (p) => { gets.push(p); return { id: p }; },
      list: async (p, limit) => {
        lists.push(`${p}|${limit}`);
        if (p === '/api/bad') throw new Error('bad');
        return [];
      },
    };
    const r = memoizeReader(inner);
    await Promise.all([r.list('/api/organizations', 500), r.list('/api/organizations', 500), r.list('/api/organizations')]);
    await r.get('/api/x/1');
    await r.get('/api/x/1');
    await expect(r.list('/api/bad')).rejects.toThrow('bad');
    await expect(r.list('/api/bad')).rejects.toThrow('bad');
    // an omitted limit is the reader's default 500, so it shares the explicit-500 read
    expect(lists).toEqual(['/api/organizations|500', '/api/bad|undefined']);
    expect(gets).toEqual(['/api/x/1']);
  });
});

// ============================================================================
// handleUi against the real Spec DO: the source is wired but must add no read to writes
// ============================================================================

const TOKEN = 'test-auth-token';
const env: UiEnv = { API_AUTH_TOKEN: TOKEN, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ALLOWED_GITHUB_USERS: 'testuser' };
const ORIGIN = 'http://localhost';

describe('handleUi reads', () => {
  let spec: SpecDO;
  let calls: Request[];
  let actorId: string;
  const stub = {
    async fetch(req: Request): Promise<Response> {
      calls.push(req.clone());
      return spec.fetch(req);
    },
  };

  beforeEach(async () => {
    spec = makeSpecDo(makeSqliteState());
    await spec.init();
    calls = [];
    actorId = spec.createActor('human', 'user').id;
  });

  async function post(path: string, form: Record<string, string>, origin: string | null = ORIGIN): Promise<Response> {
    const token = await signSession({ login: 'testuser', actorId, exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN);
    const headers: Record<string, string> = { Cookie: `__Host-beehive_session=${token}` };
    if (origin) headers.Origin = origin;
    const body = new FormData();
    for (const [k, v] of Object.entries(form)) body.append(k, v);
    return (await handleUi(new Request(`http://localhost${path}`, { method: 'POST', headers, body }), env, stub as never)) as Response;
  }

  const listReads = () => calls.filter((c) => c.method === 'GET' && new URL(c.url).pathname === '/api/organizations');

  it('a successful POST /app/organizations makes no organization list read', async () => {
    const res = await post('/app/organizations', { name: 'Acme', type: 'github' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('/app?ok=');
    expect(listReads()).toHaveLength(0);
    expect(calls.filter((c) => c.method !== 'GET').map((c) => new URL(c.url).pathname)).toEqual(['/api/organizations']);
  });

  it('a refused cross-origin POST reads only /api/actors', async () => {
    const res = await post('/app/organizations', { name: 'Acme', type: 'github' }, 'http://evil.example');
    expect(res.status).toBe(403);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/actors']);
  });
});

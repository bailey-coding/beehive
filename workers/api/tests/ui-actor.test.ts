/**
 * UI actor derivation (M8 plan section 15 item 5): the acting identity comes from the signed
 * session, never from a form field, and a session whose actor row is gone is sent to /login.
 *
 * Task: actor | Spec: docs/M8-UI-ISSUES-PLAN.md#15
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeSqliteState, makeSpecDo } from '../../spec-do/tests/sqlite-state';
import { handleUi, signSession, type UiEnv } from '../ui';

const TOKEN = 'test-auth-token';
const env: UiEnv = { API_AUTH_TOKEN: TOKEN, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ALLOWED_GITHUB_USERS: 'testuser' };

async function cookie(actorId: string): Promise<string> {
  const session = await signSession({ login: 'testuser', actorId, exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN);
  return `__Host-beehive_session=${session}`;
}

function stubWith(actors: { id: string }[], calls: Request[] = []) {
  return {
    async fetch(req: Request): Promise<Response> {
      calls.push(req.clone());
      const url = new URL(req.url);
      if (url.pathname === '/api/actors') return Response.json({ success: true, data: actors });
      if (url.pathname.startsWith('/api/actors/')) {
        const row = actors.find((a) => a.id === decodeURIComponent(url.pathname.slice('/api/actors/'.length)));
        return row
          ? Response.json({ success: true, data: row })
          : Response.json({ success: false, error: 'Not found' }, { status: 404 });
      }
      if (url.pathname === '/api/issues/issue-001') {
        return Response.json({ success: true, data: { id: 'issue-001', repository_id: 'repo-1', visibility: 'public' } });
      }
      if (url.pathname === '/api/repositories/repo-1') {
        return Response.json({ success: true, data: { id: 'repo-1', name: 'r', organization_id: 'org-1', namespace: 'ns' } });
      }
      if (url.pathname === '/api/organizations/org-1') return Response.json({ success: true, data: { id: 'org-1', name: 'acme' } });
      return Response.json({ success: true, data: {} });
    },
  };
}

describe('UI actor derivation', () => {
  it('sends a session whose actor row does not exist back to /login and clears the cookie', async () => {
    const res = await handleUi(
      new Request('http://localhost/app', { headers: { Cookie: await cookie('ghost-actor') } }),
      env,
      stubWith([{ id: 'actor-1' }]) as never
    );
    expect(res?.status).toBe(302);
    expect(res?.headers.get('Location')).toBe('/login');
    expect(res?.headers.get('Set-Cookie')).toMatch(/__Host-beehive_session=;/);
  });

  it('a comment post ignores a forged createdBy form field: the header carries the session actor and the payload only the body', async () => {
    const calls: Request[] = [];
    const form = new FormData();
    form.append('issueId', 'issue-001');
    form.append('body', 'hi');
    form.append('createdBy', 'someone-else');
    form.append('actorId', 'someone-else');
    const res = await handleUi(
      new Request('http://localhost/app/issue_comments', {
        method: 'POST',
        headers: { Cookie: await cookie('actor-1'), Origin: 'http://localhost' },
        body: form,
      }),
      env,
      stubWith([{ id: 'actor-1' }], calls) as never
    );
    expect(res?.status).toBe(302);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(new URL(post.url).pathname).toBe('/api/issues/issue-001/comments');
    expect(post.headers.get('X-Actor-ID')).toBe('actor-1');
    expect(await post.json()).toEqual({ body: 'hi' });
  });
});

describe('first-time login (no actors row)', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function login(stub: { fetch(r: Request): Promise<Response> }, githubId: number) {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/login/oauth/access_token')) return Response.json({ access_token: 'gh-token' });
      if (u.includes('api.github.com/user')) return Response.json({ login: 'testuser', id: githubId });
      throw new Error(`unexpected fetch ${u}`);
    });
    const res = await handleUi(
      new Request('http://localhost/auth/callback?code=c&state=s', { headers: { Cookie: '__Host-beehive_oauth_state=s' } }),
      env,
      stub as never
    );
    expect(res?.status).toBe(302);
    expect(res?.headers.get('Location')).toBe('/app');
    const set = res!.headers.getSetCookie().find((c) => c.startsWith('__Host-beehive_session='))!;
    return set.split(';')[0];
  }

  it('creates the actor row on login; that session can then write an issue, and a second login reuses the row', async () => {
    const store = makeSqliteState();
    const spec = makeSpecDo(store);
    await spec.init();
    const count = () => (store.raw.prepare('SELECT COUNT(*) AS n FROM actors').get() as { n: number }).n;
    expect(count()).toBe(0);

    const sessionCookie = await login(spec, 4242);
    expect(count()).toBe(1);
    const row = store.raw.prepare('SELECT id, type, name, github_user_id, role FROM actors').get() as Record<string, string | null>;
    expect(row).toMatchObject({ type: 'human', name: 'testuser', github_user_id: '4242', role: null });

    // The session carries the new id and /app accepts it (the existence check finds the row)
    const app = await handleUi(new Request('http://localhost/app', { headers: { Cookie: sessionCookie } }), env, spec as never);
    expect(app?.status).toBe(200);

    // The new actor is a plain user: it can write an issue and is not a maintainer
    const org = spec.createOrganization('acme', 'artifacts');
    const repo = spec.createRepository('r', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'ns');
    const create = await spec.fetch(
      new Request('https://spec-do.internal/api/issues', {
        method: 'POST',
        headers: { 'X-Actor-ID': row.id as string },
        body: JSON.stringify({ repositoryId: repo.id, title: 'first' }),
      })
    );
    expect(create.status).toBe(201);
    const lock = await spec.fetch(
      new Request(`https://spec-do.internal/api/issues/x/comment-policy`, {
        method: 'PATCH',
        headers: { 'X-Actor-ID': row.id as string },
        body: JSON.stringify({ commentPolicy: 'locked' }),
      })
    );
    expect(lock.status).toBe(403);

    await login(spec, 4242);
    expect(count()).toBe(1);
  });
});

// ============================================================================
// M12 T0: lookup by id / GitHub id past the 500-row page; a failed lookup never creates an actor
// ============================================================================

describe('actor lookup (M12 T0)', () => {
  afterEach(() => vi.unstubAllGlobals());

  type Stub = { fetch(r: Request): Promise<Response> };

  function stubGithub(githubId: number) {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/login/oauth/access_token')) return Response.json({ access_token: 'gh-token' });
      if (u.includes('api.github.com/user')) return Response.json({ login: 'testuser', id: githubId });
      throw new Error(`unexpected fetch ${u}`);
    });
  }

  function callback(stub: Stub): Promise<Response> {
    return handleUi(
      new Request('http://localhost/auth/callback?code=c&state=s', { headers: { Cookie: '__Host-beehive_oauth_state=s' } }),
      env,
      stub as never
    ) as Promise<Response>;
  }

  function sessionIdOf(res: Response): string {
    const set = res.headers.getSetCookie().find((c) => c.startsWith('__Host-beehive_session='))!;
    return set.split(';')[0];
  }

  /** Wraps a stub so tests can see every request and fail chosen ones. */
  function recording(inner: Stub, fail: (req: Request) => Response | Promise<Response> | undefined = () => undefined) {
    const calls: Request[] = [];
    return {
      calls,
      posts: () => calls.filter((c) => c.method === 'POST' && new URL(c.url).pathname === '/api/actors'),
      async fetch(req: Request): Promise<Response> {
        calls.push(req.clone());
        return (await fail(req)) ?? inner.fetch(req);
      },
    };
  }

  async function ledgerWith501Actors() {
    const store = makeSqliteState();
    const spec = makeSpecDo(store);
    await spec.init();
    // The target is the oldest row, so it is the 501st of the newest-first list.
    const target = spec.createActor('human', 'testuser', '4242').id;
    store.raw.prepare('UPDATE actors SET created_at = 1 WHERE id = ?').run(target);
    for (let i = 0; i < 500; i++) {
      const id = spec.createActor('human', `u${i}`, `g${i}`).id;
      store.raw.prepare('UPDATE actors SET created_at = ? WHERE id = ?').run(1000 + i, id);
    }
    const count = () => (store.raw.prepare('SELECT COUNT(*) AS n FROM actors').get() as { n: number }).n;
    return { store, spec, target, count };
  }

  it('with 501 actors the session check finds the oldest by id', async () => {
    const { spec, target } = await ledgerWith501Actors();
    const res = await handleUi(new Request('http://localhost/app', { headers: { Cookie: await cookie(target) } }), env, spec as never);
    expect(res?.status).toBe(200);
  });

  it('with 501 actors a login finds the oldest by GitHub id and creates no duplicate', async () => {
    const { spec, target, count } = await ledgerWith501Actors();
    stubGithub(4242);
    const stub = recording(spec);
    const res = await callback(stub);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/app');
    expect(stub.posts()).toHaveLength(0);
    expect(count()).toBe(501);
    const sessionCookie = sessionIdOf(res);
    const app = await handleUi(new Request('http://localhost/app', { headers: { Cookie: sessionCookie } }), env, spec as never);
    expect(app?.status).toBe(200);
    expect(sessionActor(sessionCookie)).toBe(target);
  });

  it('the lookup sends the GitHub id filter and a login on an empty ledger still creates the row', async () => {
    const store = makeSqliteState();
    const spec = makeSpecDo(store);
    await spec.init();
    stubGithub(4242);
    const stub = recording(spec);
    expect((await callback(stub)).status).toBe(302);
    const lookup = stub.calls.find((c) => c.method === 'GET')!;
    expect(new URL(lookup.url).searchParams.get('github_user_id')).toBe('4242');
    expect(stub.posts()).toHaveLength(1);
  });

  it('Spec DO 500 on the session check gives a 503 page, not a redirect, and keeps the cookie', async () => {
    const stub = recording(stubWith([{ id: 'actor-1' }]), (req) =>
      new URL(req.url).pathname.startsWith('/api/actors') ? Response.json({ success: false, error: 'boom' }, { status: 500 }) : undefined
    );
    const res = await handleUi(new Request('http://localhost/app', { headers: { Cookie: await cookie('actor-1') } }), env, stub as never);
    expect(res?.status).toBe(503);
    expect(res?.headers.get('Location')).toBeNull();
    expect(res?.headers.get('Set-Cookie')).toBeNull();
  });

  it('a thrown or unreadable answer on the session check is a 503 too', async () => {
    for (const fail of [
      () => {
        throw new Error('unreachable');
      },
      () => new Response('<html>oops</html>', { status: 200 }),
      () => Response.json({ success: true, data: { id: 'someone-else' } }),
    ]) {
      const stub = recording(stubWith([{ id: 'actor-1' }]), fail);
      const res = await handleUi(new Request('http://localhost/app', { headers: { Cookie: await cookie('actor-1') } }), env, stub as never);
      expect(res?.status).toBe(503);
    }
  });

  it('Spec DO 500 on the login lookup fails the request and makes zero POST /api/actors', async () => {
    for (const fail of [
      () => Response.json({ success: false, error: 'boom' }, { status: 500 }),
      () => new Response('not json', { status: 502 }),
      () => {
        throw new Error('unreachable');
      },
    ]) {
      const store = makeSqliteState();
      const spec = makeSpecDo(store);
      await spec.init();
      stubGithub(4242);
      const stub = recording(spec, (req) => (req.method === 'GET' && new URL(req.url).pathname === '/api/actors' ? fail() : undefined));
      const res = await callback(stub);
      expect(res.status).toBe(500);
      expect(await res.text()).toContain('Login failed');
      expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-beehive_session=') && !c.startsWith('__Host-beehive_session=;'))).toBe(false);
      expect(stub.posts()).toHaveLength(0);
      expect((store.raw.prepare('SELECT COUNT(*) AS n FROM actors').get() as { n: number }).n).toBe(0);
    }
  });

  async function twoRowsOneGithubId() {
    const store = makeSqliteState();
    const spec = makeSpecDo(store);
    await spec.init();
    const older = spec.createActor('human', 'testuser', '4242').id;
    const newer = spec.createActor('human', 'testuser', '4242').id;
    const other = spec.createActor('human', 'someone', '1').id;
    store.raw.prepare('UPDATE actors SET created_at = 100 WHERE id = ?').run(older);
    store.raw.prepare('UPDATE actors SET created_at = 300 WHERE id = ?').run(newer);
    store.raw.prepare('UPDATE actors SET created_at = 200 WHERE id = ?').run(other);
    const count = () => (store.raw.prepare('SELECT COUNT(*) AS n FROM actors').get() as { n: number }).n;
    return { spec, older, newer, count };
  }

  function sessionActor(sessionCookie: string): string {
    const payload = sessionCookie.split('=')[1].split('.')[0];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { actorId: string }).actorId;
  }

  it('two rows with one GitHub id resolve to the newest, with the filter', async () => {
    const { spec, newer, count } = await twoRowsOneGithubId();
    stubGithub(4242);
    const res = await callback(spec);
    expect(res.status).toBe(302);
    expect(sessionActor(sessionIdOf(res))).toBe(newer);
    expect(count()).toBe(3);
  });

  it('two rows with one GitHub id resolve to the newest against an old Spec DO that ignores the filter', async () => {
    const { spec, newer, count } = await twoRowsOneGithubId();
    stubGithub(4242);
    // An old DO: the filter parameter is dropped, so the unfiltered newest-first list comes back.
    const oldDo: Stub = {
      fetch(req: Request) {
        const url = new URL(req.url);
        url.searchParams.delete('github_user_id');
        return spec.fetch(new Request(url, req));
      },
    };
    const stub = recording(oldDo);
    const res = await callback(stub);
    expect(res.status).toBe(302);
    expect(sessionActor(sessionIdOf(res))).toBe(newer);
    expect(stub.posts()).toHaveLength(0);
    expect(count()).toBe(3);
  });
});

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

  it('a comment post ignores a forged createdBy form field: header and payload carry the session actor', async () => {
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
    expect(await post.json()).toMatchObject({ createdBy: 'actor-1' });
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

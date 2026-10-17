/**
 * UI actor derivation (M8 plan section 15 item 5): the acting identity comes from the signed
 * session, never from a form field, and a session whose actor row is gone is sent to /login.
 *
 * Task: actor | Spec: docs/M8-UI-ISSUES-PLAN.md#15
 */
import { describe, it, expect } from 'vitest';
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

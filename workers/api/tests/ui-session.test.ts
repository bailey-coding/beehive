/**
 * The session cookie and the OAuth state check (docs/plans/wave-0-plan.md part 4, review d S2): a cookie signed with another secret,
 * a tampered payload or an expired cookie is no session; a callback whose state differs from the state cookie never reaches GitHub;
 * the session cookie carries the __Host- prefix, HttpOnly, Secure, SameSite=Lax and Path=/.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { makeSqliteState, makeSpecDo } from '../../spec-do/tests/sqlite-state';
import { handleUi, signSession, type UiEnv } from '../ui';

const TOKEN = 'test-auth-token';
const env: UiEnv = { API_AUTH_TOKEN: TOKEN, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ALLOWED_GITHUB_USERS: 'testuser' };
const now = () => Math.floor(Date.now() / 1000);

let spec: ReturnType<typeof makeSpecDo>;
let actorId: string;

beforeEach(async () => {
  spec = makeSpecDo(makeSqliteState());
  await spec.init();
  actorId = spec.createActor('human', 'testuser', '4242').id;
});
afterEach(() => vi.unstubAllGlobals());

const app = (cookieValue: string) =>
  handleUi(new Request('http://localhost/app', { headers: { Cookie: `__Host-beehive_session=${cookieValue}` } }), env, spec as never);
const isSignedOut = (res: Response | null) => res?.status === 302 && res.headers.get('Location')?.startsWith('/login');

describe('session cookie checks', () => {
  it('a cookie signed with the right secret, unexpired, is a session (control)', async () => {
    const res = await app(await signSession({ login: 'testuser', actorId, exp: now() + 3600 }, TOKEN));
    expect(res?.status).toBe(200);
  });

  it('a cookie signed with another secret is no session', async () => {
    expect(isSignedOut(await app(await signSession({ login: 'testuser', actorId, exp: now() + 3600 }, 'another-secret')))).toBe(true);
  });

  it('a payload changed under the old signature is no session', async () => {
    const good = await signSession({ login: 'testuser', actorId, exp: now() + 3600 }, TOKEN);
    const forged = await signSession({ login: 'testuser', actorId, exp: now() + 999_999 }, TOKEN);
    const tampered = `${forged.split('.')[0]}.${good.split('.')[1]}`;
    expect(isSignedOut(await app(tampered))).toBe(true);
  });

  it('an expired cookie is no session', async () => {
    expect(isSignedOut(await app(await signSession({ login: 'testuser', actorId, exp: now() - 1 }, TOKEN)))).toBe(true);
  });
});

describe('OAuth callback', () => {
  function stubGithub() {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const u = String(input);
      calls.push(u);
      if (u.includes('/login/oauth/access_token')) return Response.json({ access_token: 'gh-token' });
      if (u.includes('api.github.com/user')) return Response.json({ login: 'testuser', id: 4242 });
      throw new Error(`unexpected fetch ${u}`);
    });
    return calls;
  }
  const callback = (state: string, cookieState: string) =>
    handleUi(
      new Request(`http://localhost/auth/callback?code=c&state=${state}`, { headers: { Cookie: `__Host-beehive_oauth_state=${cookieState}` } }),
      env,
      spec as never
    );

  it('a state that differs from the state cookie is refused before any call to GitHub', async () => {
    const calls = stubGithub();
    const res = await callback('attacker', 'mine');
    expect(res?.headers.get('Location')).not.toBe('/app');
    expect(res?.headers.getSetCookie().some((c) => c.startsWith('__Host-beehive_session=') && !c.includes('Max-Age=0'))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('the session cookie set by a good callback has the __Host- prefix and HttpOnly, Secure, SameSite=Lax, Path=/', async () => {
    stubGithub();
    const res = await callback('s', 's');
    expect(res?.headers.get('Location')).toBe('/app');
    const set = res!.headers.getSetCookie().find((c) => c.startsWith('__Host-beehive_session='))!;
    const attrs = set.split(';').map((a) => a.trim());
    for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(attrs).toContain(a);
  });
});

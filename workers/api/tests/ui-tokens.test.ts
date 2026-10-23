/**
 * The API tokens settings page (M12): /app/settings/tokens. handleUi against the real Spec DO
 * (real SQL, FKs on) behind a recording stub that can override single DO paths.
 * Rows: S5 (actor from the session only), S13 (shown once, no-store, no-referrer), S14 (origin
 * and freshness before any DO call), S4 (another actor's token is a 404), S3 (no logging).
 *
 * Task: T5 | Spec: docs/M12-IMPL-PLAN.md §1 PR-B, §4
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeSqliteState, makeSpecDo, type SqliteState } from '../../spec-do/tests/sqlite-state';
import type { SpecDO } from '../../spec-do/index';
import { handleUi, signSession, type UiEnv } from '../ui';
import { isFresh, MINT_FRESHNESS_SECONDS } from '../ui-tokens';
import { generateUserToken, hashToken, tokenPrefix } from '../../shared/service-tokens';

// A real token is base64url and can hold no markup; the escaping test swaps in a hostile one
const fakeToken = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('../../shared/service-tokens', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../shared/service-tokens')>();
  return { ...real, generateUserToken: () => fakeToken.value ?? real.generateUserToken() };
});

const TOKEN = 'test-auth-token';
const env: UiEnv = { API_AUTH_TOKEN: TOKEN, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ALLOWED_GITHUB_USERS: 'testuser' };
const ORIGIN = 'http://localhost';
const PATH = '/app/settings/tokens';

let store: SqliteState;
let spec: SpecDO;
let calls: Request[];
let overrides: Array<(req: Request) => Response | undefined>;
let alice: string;
let bob: string;
let maint: string;

const stub = {
  async fetch(req: Request): Promise<Response> {
    calls.push(req.clone());
    for (const o of overrides) {
      const res = o(req);
      if (res) return res;
    }
    return spec.fetch(req);
  },
};

const now = () => Math.floor(Date.now() / 1000);

/** `iat: null` signs a pre-M12 cookie (no iat at all) */
async function cookie(actorId: string, iat: number | null): Promise<string> {
  const s = await signSession({ login: 'testuser', actorId, ...(iat === null ? {} : { iat }), exp: now() + 3600 }, TOKEN);
  return `__Host-beehive_session=${s}`;
}

interface Opts {
  actor?: string;
  iat?: number | null;
  origin?: string | null;
  form?: Record<string, string>;
  method?: string;
}

async function ui(path: string, opts: Opts = {}): Promise<Response> {
  const method = opts.method ?? (opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = {
    Cookie: await cookie(opts.actor ?? alice, opts.iat === undefined ? now() : opts.iat),
  };
  if (method !== 'GET' && opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  let body: FormData | undefined;
  if (opts.form) {
    body = new FormData();
    for (const [k, v] of Object.entries(opts.form)) body.append(k, v);
  }
  return (await handleUi(new Request(`http://localhost${path}`, { method, headers, body }), env, stub as never)) as Response;
}

const rows = () => store.raw.prepare('SELECT * FROM user_tokens ORDER BY created_at').all() as Record<string, unknown>[];
const tokenCalls = () => calls.filter((c) => new URL(c.url).pathname.startsWith('/internal/user-tokens'));
const mintForm = (extra: Record<string, string> = {}) => ({ name: 'laptop', scope: 'read_write', expiresInDays: '30', ...extra });
const plaintextOf = (html: string) => html.match(/bh_usr_[A-Za-z0-9_-]{43}/)?.[0];
const oldDo = (req: Request) =>
  new URL(req.url).pathname.startsWith('/internal/user-tokens')
    ? new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    : undefined;

/** A token for `actorId` straight in the DO (admin path), for list and revoke tests */
async function seed(actorId: string, name = 'seeded') {
  const plaintext = generateUserToken();
  return spec.mintUserToken(
    {
      actorId,
      name,
      scope: 'read',
      createdVia: 'admin',
      tokenHash: await hashToken(plaintext),
      tokenPrefix: tokenPrefix(plaintext),
      expiresAt: Date.now() + 86_400_000,
    },
    false
  ) as { id: string; prefix: string };
}

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  calls = [];
  overrides = [];
  alice = spec.createActor('human', 'alice', '1001').id;
  bob = spec.createActor('human', 'bob', '1002').id;
  maint = spec.createActor('human', 'maint', '1003').id;
  store.raw.prepare(`UPDATE actors SET role = 'maintainer' WHERE id = ?`).run(maint);
});

afterEach(() => {
  vi.restoreAllMocks();
  fakeToken.value = null;
});

// ============================================================================
// Escaping (review S1): every DO-sourced or generated value on these pages goes through esc()
// ============================================================================

describe('HTML escaping on /app/settings/tokens (review S1)', () => {
  const HOSTILE = `<script>x</script>"'`;
  const ESCAPED = '&lt;script&gt;x&lt;/script&gt;&quot;&#39;';
  /** A stub answer for the DO mint route */
  const mintAnswer = (status: number, body: unknown) => (req: Request) =>
    new URL(req.url).pathname === '/internal/user-tokens' && req.method === 'POST'
      ? new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      : undefined;

  it('a token name set by the master (admin mint) is escaped in the list', async () => {
    await seed(alice, HOSTILE);
    const html = await (await ui(PATH)).text();
    expect(html).toContain(ESCAPED);
    expect(html).not.toContain('<script>x</script>');
  });

  it('the show-once page escapes the plaintext and the name', async () => {
    fakeToken.value = 'bh_usr_"><script>tok()</script>';
    overrides.push(
      mintAnswer(201, {
        success: true,
        data: { id: 't1', actorId: alice, name: '<img src=x onerror=nm()>', prefix: 'bh_usr_"><sc', scope: 'read', expiresAt: Date.now() + 86_400_000 },
      })
    );
    const res = await ui(PATH, { form: mintForm() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('bh_usr_&quot;&gt;&lt;script&gt;tok()&lt;/script&gt;');
    expect(html).not.toContain('<script>tok()</script>');
    expect(html).toContain('&lt;img src=x onerror=nm()&gt;');
    expect(html).not.toContain('<img src=x');
  });

  it.each([400, 403, 409])("the DO's %s refusal text is escaped", async (status) => {
    overrides.push(mintAnswer(status, { success: false, error: `<script>err${status}()</script>` }));
    const res = await ui(PATH, { form: mintForm() });
    expect(res.status).toBe(status);
    const html = await res.text();
    expect(html).toContain(`&lt;script&gt;err${status}()&lt;/script&gt;`);
    expect(html).not.toContain(`<script>err${status}()</script>`);
  });
});

describe('GET /app/settings/tokens', () => {
  it("lists the session actor's own tokens by prefix and offers the mint form to a fresh session", async () => {
    const mine = await seed(alice, 'mine');
    await seed(bob, 'theirs');
    const res = await ui(PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('mine');
    expect(html).toContain(mine.prefix);
    expect(html).not.toContain('theirs');
    expect(html).toContain(`action="${PATH}/${mine.id}/revoke"`);
    expect(html).toContain(`<form method="POST" action="${PATH}"`);
    expect(html).not.toContain('value="maintainer"');
    // The DO was asked for this actor only
    expect(tokenCalls().map((c) => new URL(c.url).searchParams.get('actorId'))).toEqual([alice]);
  });

  it('offers the maintainer scope only to a maintainer', async () => {
    expect(await (await ui(PATH, { actor: maint })).text()).toContain('value="maintainer"');
  });

  it('a stale or pre-M12 session sees a sign-in link instead of the form', async () => {
    for (const iat of [now() - MINT_FRESHNESS_SECONDS - 1, null]) {
      const html = await (await ui(PATH, { iat })).text();
      expect(html).not.toContain(`<form method="POST" action="${PATH}"`);
      expect(html).toContain('href="/login"');
    }
  });

  it('an old Spec DO (404 on the list route) is "Token service unavailable", never "no tokens"', async () => {
    overrides.push(oldDo);
    const res = await ui(PATH);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('Token service unavailable');
    expect(html).not.toContain('None yet');
  });
});

describe('POST /app/settings/tokens (mint)', () => {
  it('mints for the session actor, shows the plaintext once on a 200 page with no-store and no-referrer (S13)', async () => {
    const res = await ui(PATH, { form: mintForm() });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Location')).toBeNull();
    const plaintext = plaintextOf(await res.text())!;
    expect(plaintext).toBeDefined();
    const [row] = rows();
    expect(row).toMatchObject({ actor_id: alice, created_by: alice, created_via: 'session', scope: 'read_write', name: 'laptop' });
    expect(row.token_hash).toBe(await hashToken(plaintext));
    expect((row.expires_at as number) - (row.created_at as number)).toBeLessThanOrEqual(30 * 86_400_000);

    // The next list page shows the prefix, never the plaintext
    const list = await (await ui(PATH)).text();
    expect(list).toContain(plaintext.slice(0, 12));
    expect(list).not.toContain(plaintext);
  });

  it('ignores any actor named in the form (S5)', async () => {
    const res = await ui(PATH, { form: mintForm({ actorId: bob, actor_id: bob, createdBy: bob }) });
    expect(res.status).toBe(200);
    expect(rows().map((r) => [r.actor_id, r.created_by])).toEqual([[alice, alice]]);
    const minted = tokenCalls().find((c) => c.method === 'POST')!;
    const body = JSON.parse(await minted.text());
    expect(body.actorId).toBe(alice);
    expect(minted.headers.get('X-Actor-ID')).toBe(alice);
    expect(JSON.stringify(body)).not.toContain(bob);
  });

  it('a cross-origin or Origin-less POST is 403 with zero DO calls (S14)', async () => {
    for (const origin of ['https://evil.example', null]) {
      calls = [];
      const res = await ui(PATH, { form: mintForm(), origin });
      expect(res.status, String(origin)).toBe(403);
      expect(calls, String(origin)).toHaveLength(0);
    }
    expect(rows()).toHaveLength(0);
  });

  it('a stale, missing or future iat gets "sign in again" and zero DO calls (S14)', async () => {
    for (const iat of [now() - MINT_FRESHNESS_SECONDS - 1, null, now() + 5]) {
      calls = [];
      const res = await ui(PATH, { form: mintForm(), iat });
      expect(res.status, String(iat)).toBe(403);
      expect(await res.text()).toContain('Sign in again');
      expect(calls, String(iat)).toHaveLength(0);
    }
    expect(rows()).toHaveLength(0);
  });

  it('isFresh: the 10-minute boundary is inclusive; the future is not fresh', () => {
    const t = 1_000_000;
    const s = (iat?: number) => ({ login: 'x', actorId: 'a', exp: t + 1, ...(iat === undefined ? {} : { iat }) });
    expect(isFresh(s(t), t)).toBe(true);
    expect(isFresh(s(t - 600), t)).toBe(true);
    expect(isFresh(s(t - 601), t)).toBe(false);
    expect(isFresh(s(t + 1), t)).toBe(false);
    expect(isFresh(s(), t)).toBe(false);
    expect(isFresh({ ...s(), iat: 'x' } as never, t)).toBe(false);
  });

  it('bad input is a 400 page with no DO write: 91 days, no name, an unknown scope', async () => {
    for (const extra of [{ expiresInDays: '91' }, { expiresInDays: '1.5' }, { expiresInDays: 'abc' }, { name: '' }, { scope: 'admin' }]) {
      const res = await ui(PATH, { form: mintForm(extra) });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(tokenCalls()).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it('passes the DO refusals on: the maintainer scope for a non-maintainer (403), the 11th token (409)', async () => {
    expect((await ui(PATH, { form: mintForm({ scope: 'maintainer' }) })).status).toBe(403);
    expect((await ui(PATH, { actor: maint, form: mintForm({ scope: 'maintainer' }) })).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await ui(PATH, { form: mintForm({ name: `t${i}` }) })).status).toBe(200);
    const over = await ui(PATH, { form: mintForm({ name: 'eleventh' }) });
    expect(over.status).toBe(409);
    expect(plaintextOf(await over.text())).toBeUndefined();
  });

  it('an old Spec DO (404 on the mint route) is a 503 page with no plaintext', async () => {
    overrides.push(oldDo);
    const res = await ui(PATH, { form: mintForm() });
    expect(res.status).toBe(503);
    expect(plaintextOf(await res.text())).toBeUndefined();
  });

  it('never logs the plaintext or its hash (S3)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const plaintext = plaintextOf(await (await ui(PATH, { form: mintForm() })).text())!;
    await ui(`${PATH}/${rows()[0].id}/revoke`, { form: {} });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain(plaintext);
    expect(logged).not.toContain(await hashToken(plaintext));
  });
});

describe('POST /app/settings/tokens/:id/revoke', () => {
  it('revokes an own token and redirects back with a flash; no freshness needed', async () => {
    const t = await seed(alice);
    const res = await ui(`${PATH}/${t.id}/revoke`, { form: {}, iat: null });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${PATH}?ok=Token%20revoked`);
    expect(store.raw.prepare('SELECT revoked_by FROM user_tokens WHERE id = ?').get(t.id)).toEqual({ revoked_by: alice });
  });

  it("another actor's token and an unknown id are the same 404, and nothing is revoked (S4)", async () => {
    const theirs = await seed(bob);
    const a = await ui(`${PATH}/${theirs.id}/revoke`, { form: {} });
    const b = await ui(`${PATH}/00000000-0000-0000-0000-000000000000/revoke`, { form: {} });
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.text()).toBe(await b.text());
    expect(store.raw.prepare('SELECT revoked_at FROM user_tokens').get()).toEqual({ revoked_at: null });
    expect((await ui(`${PATH}/bad%2Fid/revoke`, { form: {} })).status).toBe(404);
    expect((await ui(`${PATH}/%E0%A4%A/revoke`, { form: {} })).status).toBe(404);
  });

  it('cross-origin revoke is 403 with zero DO calls', async () => {
    const t = await seed(alice);
    calls = [];
    expect((await ui(`${PATH}/${t.id}/revoke`, { form: {}, origin: 'https://evil.example' })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('an old Spec DO (catch-all 404) is a 503, never "not found" or "revoked"', async () => {
    const t = await seed(alice);
    overrides.push(oldDo);
    expect((await ui(`${PATH}/${t.id}/revoke`, { form: {} })).status).toBe(503);
  });

  it('other methods and paths under the page are a 404 page', async () => {
    expect((await ui(`${PATH}/x`, {})).status).toBe(404);
    expect((await ui(PATH, { method: 'DELETE', form: {} })).status).toBe(404);
  });
});

describe('sign-in records iat', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the session cookie from /auth/callback carries iat = now, so a new login can mint', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes('/login/oauth/access_token')) return Response.json({ access_token: 'gh-token' });
      if (u.includes('api.github.com/user')) return Response.json({ login: 'testuser', id: 1001 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const before = now();
    const res = (await handleUi(
      new Request('http://localhost/auth/callback?code=c&state=s', { headers: { Cookie: '__Host-beehive_oauth_state=s' } }),
      env,
      stub as never
    )) as Response;
    const set = res.headers.getSetCookie().find((c) => c.startsWith('__Host-beehive_session='))!;
    const payload = set.split(';')[0].split('=')[1].split('.')[0];
    const session = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    expect(session.iat).toBeGreaterThanOrEqual(before);
    expect(session.iat).toBeLessThanOrEqual(now());
    expect(session.exp - session.iat).toBe(12 * 3600);

    const minted = await handleUi(
      new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: { Cookie: set.split(';')[0], Origin: ORIGIN },
        body: (() => {
          const f = new FormData();
          for (const [k, v] of Object.entries(mintForm())) f.append(k, v);
          return f;
        })(),
      }),
      env,
      stub as never
    );
    expect(minted?.status).toBe(200);
  });
});

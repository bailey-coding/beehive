/**
 * Repo issue pages E2E (local only): the server-rendered UI against the real beehive worker and
 * Spec DO. Needs the workers started with E2E_UI=1 (scripts/start-e2e-workers.sh gives the beehive
 * worker dummy GitHub OAuth vars so /app answers). OAuth is never exercised: the session cookie is
 * forged with signSession and the local API_AUTH_TOKEN. Never runs against production.
 *
 * Flow: list -> new -> create #1 -> create #2 -> parallel creates -> comment -> lock (API, maintainer)
 * -> comment refused -> unlock -> close -> reopen -> legacy 302 -> other repo 404 -> 2-part / 3-part /
 * UUID all 200. Private issues are unit-tested only: no API can set `visibility` yet. Cleanup:
 * tombstone + purge by prefix.
 *
 * Task: U4 | Spec: docs/M8-UI-ISSUES-PLAN.md#8
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getConfig } from './config';
import { createRequest, ensureMaintainer, readJson } from './helpers';
import { signSession } from '../../workers/api/ui';

const config = getConfig();
const isLocal = config.environment === 'local';
const PREFIX = 'e2e-ui-issues-';

async function api(path: string, method = 'GET', body?: unknown, actorId?: string) {
  const res = await fetch(createRequest(path, method, body, actorId ? { 'X-Actor-ID': actorId } : {}));
  return { status: res.status, json: await readJson(res).catch(() => ({})) };
}

/** The UI answers 503 when the worker has no GitHub vars (E2E_UI unset): then this suite skips. */
async function uiConfigured(): Promise<boolean> {
  if (!isLocal) return false;
  try {
    const res = await fetch(`${config.baseUrl}/app`, { redirect: 'manual' });
    return res.status !== 503;
  } catch {
    return false;
  }
}

const enabled = await uiConfigured();

describe.skipIf(!isLocal || !enabled)('Repo issue pages (local UI)', () => {
  const orgName = `${PREFIX}${Date.now()}`;
  const origin = new URL(config.baseUrl).origin;
  let maintainer: string;
  let creator: string;
  let stranger: string;
  let orgId: string;
  let repoId: string; // 3-part: <org>/ns/shop
  let widgetsId: string; // 2-part: <org>/widgets
  let otherId: string; // <org>/other
  const cookies: Record<string, string> = {};

  async function cookieFor(actorId: string): Promise<string> {
    const s = await signSession({ login: 'e2e-ui-user', actorId, exp: Math.floor(Date.now() / 1000) + 3600 }, config.apiToken);
    return `__Host-beehive_session=${s}`;
  }

  async function ui(path: string, actor: string, form?: Record<string, string>, originHeader: string | null = origin) {
    const headers: Record<string, string> = { Cookie: cookies[actor] };
    let body: URLSearchParams | undefined;
    if (form) {
      body = new URLSearchParams(form);
      if (originHeader !== null) headers.Origin = originHeader;
    }
    return fetch(`${config.baseUrl}${path}`, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
  }

  const loc = (res: Response) => decodeURIComponent(res.headers.get('location') ?? '');
  const issueIdFrom = (res: Response) => (res.headers.get('location') ?? '').match(/\/issues\/([^/?#]+)/)![1];

  beforeAll(async () => {
    maintainer = await ensureMaintainer(api, 'e2e-ui-maintainer');
    creator = ((await api('/api/actors', 'POST', { type: 'human', name: 'e2e-ui-creator' })).json.data as { id: string }).id;
    stranger = ((await api('/api/actors', 'POST', { type: 'human', name: 'e2e-ui-stranger' })).json.data as { id: string }).id;
    for (const a of [maintainer, creator, stranger]) cookies[a] = await cookieFor(a);

    const org = await api('/api/organizations', 'POST', { name: orgName, type: 'artifacts' }, maintainer);
    expect(org.status).toBe(201);
    orgId = (org.json.data as { id: string }).id;
    const mk = async (name: string, namespace: string) => {
      const r = await api('/api/repositories', 'POST', { name, organizationId: orgId, repoType: 'baseline', remoteUrl: 'https://example.invalid/r.git', namespace }, maintainer);
      expect(r.status).toBe(201);
      return (r.json.data as { id: string }).id;
    };
    repoId = await mk('shop', 'ns');
    widgetsId = await mk('widgets', orgName);
    otherId = await mk('other', orgName);
  });

  afterAll(async () => {
    if (!orgId) return;
    await api(`/api/organizations/${orgId}`, 'DELETE', { reason: 'e2e ui-issues cleanup' }, maintainer);
    const dry = await api('/api/admin/purge', 'POST', { orgNamePrefix: PREFIX }, maintainer);
    const total = (dry.json.data as { total: number }).total;
    await api('/api/admin/purge', 'POST', { orgNamePrefix: PREFIX, dryRun: false, confirm: total }, maintainer);
  });

  const base = () => `/app/repos/${orgName}/ns/shop`;
  let first: string;
  let second: string;

  it('requires a session and an Origin on POST', async () => {
    expect((await fetch(`${config.baseUrl}${base()}/issues`, { redirect: 'manual' })).status).toBe(302);
    const noOrigin = await ui(`${base()}/issues`, creator, { title: 'x' }, null);
    expect(noOrigin.status).toBe(403);
    const evil = await ui(`${base()}/issues`, creator, { title: 'x' }, 'http://evil.example');
    expect(evil.status).toBe(403);
  });

  it('list -> new -> create #1 -> create #2', async () => {
    const list = await ui(`${base()}/issues`, creator);
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('No issues found');
    const form = await ui(`${base()}/issues/new`, creator);
    expect(form.status).toBe(200);
    expect(await form.text()).not.toContain('name="number"');

    const a = await ui(`${base()}/issues`, creator, { title: '#1 first & foremost', body: 'details' });
    expect(a.status).toBe(302);
    expect(loc(a)).toContain('?ok=Created issue #1');
    first = issueIdFrom(a);
    const b = await ui(`${base()}/issues`, creator, { title: 'second' });
    expect(loc(b)).toContain('?ok=Created issue #2');
    second = issueIdFrom(b);

    const detail = await ui(`${base()}/issues/${first}`, creator);
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain('#1 first &amp; foremost');
    expect(html).toContain('Close issue');
  });

  it('parallel creates get distinct numbers', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => ui(`${base()}/issues`, creator, { title: `parallel ${i}` })));
    const numbers = results.map((r) => Number(/Created issue #(\d+)/.exec(loc(r))![1]));
    expect(new Set(numbers).size).toBe(5);
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(3);
  });

  it('comment, then lock via the API as maintainer: refused for others, allowed for the maintainer, unlock', async () => {
    const ok = await ui(`${base()}/issues/${first}/comments`, stranger, { body: 'hello there' });
    expect(loc(ok)).toContain('?ok=Comment added');
    expect(await (await ui(`${base()}/issues/${first}`, creator)).text()).toContain('hello there');

    expect((await api(`/api/issues/${first}/comment-policy`, 'PATCH', { commentPolicy: 'locked' }, maintainer)).status).toBe(200);
    const page = await (await ui(`${base()}/issues/${first}`, stranger)).text();
    expect(page).toContain('Locked');
    expect(page).not.toContain(`/issues/${first}/comments"`);
    const refused = await ui(`${base()}/issues/${first}/comments`, stranger, { body: 'blocked' });
    expect(loc(refused)).toMatch(/error=.*locked/);
    expect(await (await ui(`${base()}/issues/${first}`, creator)).text()).not.toContain('blocked');
    const byMaintainer = await ui(`${base()}/issues/${first}/comments`, maintainer, { body: 'maintainer note' });
    expect(loc(byMaintainer)).toContain('?ok=Comment added');

    expect((await api(`/api/issues/${first}/comment-policy`, 'PATCH', { commentPolicy: 'open' }, maintainer)).status).toBe(200);
    expect(loc(await ui(`${base()}/issues/${first}/comments`, stranger, { body: 'open again' }))).toContain('?ok=Comment added');
  });

  it('close -> reopen; a stranger cannot', async () => {
    const denied = await ui(`${base()}/issues/${second}/status`, stranger, { status: 'closed' });
    expect(loc(denied)).toMatch(/error=.*creator or a maintainer/);
    expect(loc(await ui(`${base()}/issues/${second}/status`, creator, { status: 'closed' }))).toContain('?ok=Issue closed');
    expect(await (await ui(`${base()}/issues/${second}`, creator)).text()).toContain('Reopen issue');
    expect(loc(await ui(`${base()}/issues/${second}/status`, maintainer, { status: 'open' }))).toContain('?ok=Issue reopened');
  });

  it('legacy URL 302s to the canonical one; another repo\'s URL is 404', async () => {
    const legacy = await ui(`/app/issues/${first}`, creator);
    expect(legacy.status).toBe(302);
    expect(legacy.headers.get('location')).toBe(`${base()}/issues/${first}`);
    expect((await ui(`/app/repos/${orgName}/other/issues/${first}`, creator)).status).toBe(404);
    expect((await ui(`/app/repos/${otherId}/issues/${first}`, creator)).status).toBe(404);
  });

  it('2-part, 3-part and UUID forms all answer 200 for list, new and detail', async () => {
    const wid = issueIdFrom(await ui(`/app/repos/${orgName}/widgets/issues`, creator, { title: 'on widgets' }));
    for (const [prefix, id] of [
      [`/app/repos/${orgName}/widgets`, wid],
      [`/app/repos/${orgName}/ns/shop`, first],
      [`/app/repos/${repoId}`, first],
      [`/app/repos/${widgetsId}`, wid],
    ] as const) {
      expect((await ui(`${prefix}/issues`, creator)).status, prefix).toBe(200);
      expect((await ui(`${prefix}/issues/new`, creator)).status, prefix).toBe(200);
      expect((await ui(`${prefix}/issues/${id}`, creator)).status, prefix).toBe(200);
    }
  });
});

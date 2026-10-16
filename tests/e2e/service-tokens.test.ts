/**
 * Service tokens E2E (local only): mint a read-only service token with the master
 * token, use it, check it cannot write or reach admin routes, rotate it, revoke
 * it and see 401.
 *
 * Needs the beehive worker on :8787 (scripts/start-e2e-workers.sh). Never runs
 * against production: it mints real credentials into the ledger.
 *
 * Task: service-accounts | Spec: AGENTS.md#state-management
 */

import { describe, it, expect } from 'vitest';
import { getConfig } from './config';
import { createRequest, readJson } from './helpers';

const config = getConfig();
const isLocal = config.environment === 'local';

async function master(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(createRequest(path, method, body));
  return { status: res.status, headers: res.headers, json: (await readJson(res).catch(() => ({}))) as any };
}

async function withToken(token: string, path: string, method = 'GET', headers: Record<string, string> = {}) {
  const res = await fetch(new URL(path, config.baseUrl), {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify({ name: 'x' }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

describe.skipIf(!isLocal)('Service tokens (local)', () => {
  it('mint -> use -> cannot write -> rotate -> revoke -> 401', async () => {
    const name = `e2e-svc-${Date.now()}`;
    const minted = await master('/api/admin/service-accounts', 'POST', { name, scopes: ['read'], expiresInDays: 1 });
    expect(minted.status).toBe(201);
    expect(minted.headers.get('Cache-Control')).toBe('no-store');
    const { account, token } = minted.json.data;
    expect(token.plaintext).toMatch(/^bh_svc_[A-Za-z0-9_-]{43}$/);
    expect(account.actorId).toBeTruthy();

    // Read works, as the account's own actor even with a spoofed X-Actor-ID
    expect((await withToken(token.plaintext, '/health')).status).toBe(200);
    expect((await withToken(token.plaintext, '/api/organizations')).status).toBe(200);
    const who = await withToken(token.plaintext, '/api/whoami', 'GET', { 'X-Actor-ID': 'someone-else' });
    expect(who.json.data).toMatchObject({ kind: 'service', actorId: account.actorId, scopes: ['read'] });

    // Read scope cannot write or administer
    expect((await withToken(token.plaintext, '/api/organizations', 'POST')).status).toBe(403);
    expect((await withToken(token.plaintext, '/api/admin/service-accounts')).status).toBe(403);
    expect((await withToken(token.plaintext, '/api/admin/purge', 'POST')).status).toBe(403);

    // The list never shows plaintext or hashes
    const list = await master('/api/admin/service-accounts');
    expect(list.status).toBe(200);
    const listed = JSON.stringify(list.json);
    expect(listed).not.toContain(token.plaintext);
    expect(listed).not.toContain('token_hash');
    expect(listed).toContain(name);

    // Rotate: a second token works; revoking the first leaves the second
    const rotated = await master(`/api/admin/service-accounts/${account.id}/tokens`, 'POST', { expiresInDays: 1 });
    expect(rotated.status).toBe(201);
    const second = rotated.json.data.token.plaintext as string;
    expect((await withToken(second, '/api/organizations')).status).toBe(200);
    expect((await master(`/api/admin/service-accounts/${account.id}/tokens/${token.id}/revoke`, 'POST')).status).toBe(200);
    expect((await withToken(token.plaintext, '/api/organizations')).status).toBe(401);
    expect((await withToken(second, '/api/organizations')).status).toBe(200);

    // Revoke the account: every token is 401 at once
    expect((await master(`/api/admin/service-accounts/${account.id}/revoke`, 'POST')).status).toBe(200);
    expect((await withToken(second, '/api/organizations')).status).toBe(401);
    expect((await withToken(second, '/health')).status).toBe(401);
  });
});

import { describe, expect, it } from 'vitest';
import { hasScope, requireScope, withActor, withAuth, withMaintainerScope, withReadScope, withWriteScope, type Principal } from '../../workers/shared/principal';
import { authorize } from '../../workers/api/principal';

const master = (actorId: string): Principal => ({
  kind: 'master',
  actorId,
  scopes: ['read', 'write'],
  promotionAuthority: true,
  organizationId: null,
});

describe('withActor', () => {
  it('lets master without X-Actor-ID through as "unknown" (health/bootstrap keep working)', () => {
    const p = master('unknown');
    const r = withActor(withAuth(new Request('https://x/health'), p), p);
    expect(r).not.toBeInstanceOf(Response);
    expect((r as { actorId: string }).actorId).toBe('unknown');
  });

  it('fails closed with 503 on an empty actorId', async () => {
    const p = master('');
    const r = withActor(withAuth(new Request('https://x/health'), p), p);
    expect(r).toBeInstanceOf(Response);
    expect((r as Response).status).toBe(503);
  });
});

describe('scope wrappers share one scope test with authorize()', () => {
  const user = (scopes: Principal['scopes']): Principal => ({ ...master('u1'), kind: 'user', scopes, promotionAuthority: false });
  const authed = (p: Principal) => withAuth(new Request('https://x/api/specs'), p);

  it.each([
    [['read'], withReadScope, withWriteScope, withMaintainerScope],
    [['read', 'write'], withReadScope, withWriteScope, withMaintainerScope],
    [['read', 'write', 'maintainer'], withReadScope, withWriteScope, withMaintainerScope],
  ] as const)('%j', (scopes, r, w, m) => {
    const req = authed(user([...scopes]));
    expect(r(req) instanceof Response).toBe(!scopes.includes('read'));
    expect(w(req) instanceof Response).toBe(!scopes.includes('write'));
    expect(m(req) instanceof Response).toBe(!scopes.includes('maintainer'));
  });

  it('a denied wrapper is a 403, and agrees with requireScope', () => {
    const req = authed(user(['read']));
    const viaWrapper = withWriteScope(req) as Response;
    expect(viaWrapper.status).toBe(403);
    expect(requireScope(req.principal, 'write')!.status).toBe(403);
  });

  it('authorize() lets a read-only user GET but not POST a write route (same scope source)', () => {
    const p = user(['read']);
    expect(authorize(p, 'GET', '/api/specs')).toBeNull();
    expect(authorize(p, 'POST', '/api/specs')!.status).toBe(403);
    expect(hasScope(p, 'write')).toBe(false);
  });
});

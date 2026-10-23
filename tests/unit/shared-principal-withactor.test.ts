import { describe, expect, it } from 'vitest';
import { withActor, withAuth, type Principal } from '../../workers/shared/principal';

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

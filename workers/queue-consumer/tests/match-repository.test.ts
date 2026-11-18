/**
 * How the queue consumer finds the repository a push is for (docs/plans/wave-1-plan.md part D, review b2 S1/S3): the match keys, an
 * older Spec DO that ignores the list filters, and a ledger name that differs from the Artifacts name.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { matchRepository } from '../index';

afterEach(() => vi.restoreAllMocks());

const ref = { namespace: 'acme', name: 'cand-1', full_name: 'acme/cand-1' };

describe('matchRepository', () => {
  it('matches namespace and name first', () => {
    const rows = [
      { id: 'by-url', remote_url: 'acme/cand-1' },
      { id: 'by-fields', namespace: 'acme', name: 'cand-1', remote_url: 'https://a.artifacts.cloudflare.net/git/acme/cand-1.git' },
    ];
    expect(matchRepository(rows, ref)?.id).toBe('by-fields');
  });

  it('falls back to remote_url equal to full_name (the old key)', () => {
    expect(matchRepository([{ id: 'old', namespace: 'x', name: 'y', remote_url: 'acme/cand-1' }], ref)?.id).toBe('old');
  });

  it('falls back to remote_url ending in /<namespace>/<name>.git (ledger name differs from the Artifacts name)', () => {
    const rows = [{ id: 'renamed', namespace: 'acme', name: 'local-name', remote_url: 'https://a.artifacts.cloudflare.net/git/acme/cand-1.git' }];
    expect(matchRepository(rows, ref)?.id).toBe('renamed');
  });

  it('matches nothing for another namespace or name', () => {
    const rows = [{ id: 'other', namespace: 'acme', name: 'cand-2', remote_url: 'https://a.artifacts.cloudflare.net/git/acme/cand-2.git' }];
    expect(matchRepository(rows, ref)).toBeUndefined();
  });
});

describe('repository lookup against a Spec DO', () => {
  /** A fake Spec DO list route; `honorsFilters` false behaves like a DO older than the filters (query parameters ignored) */
  function env(rows: Array<Record<string, unknown>>, honorsFilters: boolean) {
    const seen: string[] = [];
    const stub = {
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        seen.push(url.pathname + url.search);
        if (url.pathname === '/api/repositories') {
          const ns = url.searchParams.get('namespace');
          const name = url.searchParams.get('name');
          const data = honorsFilters && ns && name ? rows.filter((r) => r.namespace === ns && r.name === name) : rows;
          return Response.json({ success: true, data });
        }
        if (url.pathname === '/api/candidates') return Response.json({ success: true, data: [] });
        return Response.json({ success: true, data: {} }, { status: 201 });
      },
    };
    return {
      seen,
      env: {
        SPEC_DO: { idFromName: () => 'id', get: () => stub },
        SPEC_DO_INTERNAL_TOKEN: 't',
        GATE_WORKFLOW: { fetch: vi.fn() },
        PREVIEW_MANAGER: { fetch: vi.fn() },
        API_AUTH_TOKEN: 't',
      },
    };
  }
  const push = (attempts = 1) => ({
    queue: 'beehive-artifacts-push',
    messages: [{
      id: 'm0', timestamp: new Date(), attempts, ack: vi.fn(), retry: vi.fn(),
      body: { event: { id: 'e1', type: 'push', repository: ref, commit: { sha: 'a'.repeat(40) }, ref: 'refs/heads/main', created_at: '2026-11-18T00:00:00Z' }, received_at: 1 },
    }],
  });

  it('an older Spec DO that ignores the filters: the repository is still matched on the client (the next lookup is the candidates)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const e = env([{ id: 'r1', namespace: 'acme', name: 'cand-1', remote_url: 'https://a/git/acme/cand-1.git' }], false);
    await worker.queue(push() as never, e.env as never, {} as never);
    expect(e.seen.some((p) => p.startsWith('/api/candidates') && p.includes('repositoryId=r1'))).toBe(true);
  });

  it('a ledger name that differs from the Artifacts name: the filtered lookup misses, the unfiltered one matches by remote_url', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const e = env([{ id: 'r9', namespace: 'acme', name: 'local-name', remote_url: 'https://a/git/acme/cand-1.git' }], true);
    await worker.queue(push() as never, e.env as never, {} as never);
    const repoLookups = e.seen.filter((p) => p.startsWith('/api/repositories'));
    expect(repoLookups).toEqual(['/api/repositories?limit=100&namespace=acme&name=cand-1', '/api/repositories?limit=100']);
    expect(e.seen.some((p) => p.includes('repositoryId=r9'))).toBe(true);
  });

  it('no match is transient (retried), never a permanent drop', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const e = env([], true);
    const b = push();
    await worker.queue(b as never, e.env as never, {} as never);
    expect(b.messages[0].retry).toHaveBeenCalled();
    expect(lines.join('\n')).toContain('no repository found');
  });
});

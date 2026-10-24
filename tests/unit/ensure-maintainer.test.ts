import { describe, expect, it } from 'vitest';
import { ensureMaintainer } from '../e2e/helpers';

type Call = (path: string, method?: string, body?: unknown, actorId?: string) => Promise<{ status: number; json: any }>;

function fakeLedger(opts: { loseRace?: boolean } = {}) {
  const actors: { id: string; role?: string }[] = [];
  let n = 0;
  const call: Call = async (path, method = 'GET', _body, _actor) => {
    if (path.startsWith('/api/actors?') && method === 'GET') return { status: 200, json: { data: actors.map((a) => ({ ...a })) } };
    if (path === '/api/actors' && method === 'POST') {
      const a = { id: `a${++n}` };
      actors.push(a);
      return { status: 201, json: { data: a } };
    }
    if (path.endsWith('/role') && method === 'POST') {
      if (opts.loseRace) {
        // another file's self-grant wins first
        actors.push({ id: 'winner', role: 'maintainer' });
        return { status: 403, json: {} };
      }
      actors.find((a) => path.includes(a.id))!.role = 'maintainer';
      return { status: 200, json: {} };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call, actors };
}

describe('ensureMaintainer', () => {
  it('reuses an existing maintainer without creating anything', async () => {
    const { call, actors } = fakeLedger();
    actors.push({ id: 'old', role: 'maintainer' });
    expect(await ensureMaintainer(call, 'm')).toBe('old');
    expect(actors).toHaveLength(1);
  });
  it('bootstraps by self-grant on a fresh ledger', async () => {
    const { call, actors } = fakeLedger();
    const id = await ensureMaintainer(call, 'm');
    expect(actors.find((a) => a.id === id)!.role).toBe('maintainer');
  });
  it('uses the winner when its self-grant loses the race', async () => {
    const { call } = fakeLedger({ loseRace: true });
    expect(await ensureMaintainer(call, 'm')).toBe('winner');
  });
  it('throws if the grant fails and no maintainer ever appears', async () => {
    const call: Call = async (path, method = 'GET') => {
      if (path.startsWith('/api/actors?')) return { status: 200, json: { data: [] } };
      if (method === 'POST' && path === '/api/actors') return { status: 201, json: { data: { id: 'x' } } };
      return { status: 403, json: {} };
    };
    await expect(ensureMaintainer(call, 'm')).rejects.toThrow(/no maintainer appeared/);
  }, 5000);
});

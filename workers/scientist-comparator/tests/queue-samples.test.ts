/**
 * Scientist comparator queue handler (PR A, docs/plans/promotion-gaps-plan.md sections 3.3, 11 B2 and 12 V8-V10): one shadow sample
 * per ledger candidate and request, an Idempotency-Key so a redelivery is a replay, and per-message ack/retry: retry only when the
 * Spec DO is unavailable, never a blanket ackAll.
 *
 * Task: promotion-gaps | Spec: docs/plans/promotion-gaps-plan.md PR A
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import handler from '../index';
import type { ScientistEnv, ScientistQueueMessage } from '../types';
import { CANDIDATE_NOT_FOUND } from '../../shared/shadow-verdict';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const SPEC = '33333333-3333-4333-8333-333333333333';

type Call = { method: string; path: string; headers: Headers; body: any };

interface Fake {
  calls: Call[];
  /** per-path override of the POST answer; default is a 200 */
  post: (candidateId: string) => Response;
  /** GET /api/candidates/:id */
  candidate: (id: string) => Response;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeEnv(fake: Fake): ScientistEnv {
  const stub = {
    fetch: async (input: Request | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      const text = await request.clone().text();
      fake.calls.push({ method: request.method, path, headers: request.headers, body: text ? JSON.parse(text) : undefined });
      const sample = path.match(/^\/api\/candidates\/([^/]+)\/shadow-samples$/);
      if (sample && request.method === 'POST') return fake.post(decodeURIComponent(sample[1]));
      const cand = path.match(/^\/api\/candidates\/([^/]+)$/);
      if (cand && request.method === 'GET') return fake.candidate(decodeURIComponent(cand[1]));
      if (path.startsWith('/api/specs/')) return json(404, { success: false, error: 'Not found' });
      return json(500, { success: false, error: `unexpected ${request.method} ${path}` });
    },
  };
  return {
    SPEC_DO: { idFromName: () => 'id', get: () => stub },
    SPEC_DO_INTERNAL_TOKEN: 'tier-1',
    ANALYTICS: { writeDataPoint: vi.fn() },
  } as unknown as ScientistEnv;
}

let fake: Fake;
beforeEach(() => {
  fake = {
    calls: [],
    post: () => json(200, { success: true, data: {} }),
    candidate: (id) => json(200, { success: true, data: { id, specId: SPEC } }),
  };
});
afterEach(() => vi.restoreAllMocks());

const response = (candidateId: string, status = 200) => ({ candidateId, specId: '', status, headers: {}, latencyMs: 10 });
function message(requestId: string, candidateIds: string[]): ScientistQueueMessage {
  return {
    requestId,
    timestamp: 1_700_000_000_000,
    path: '/x',
    method: 'GET',
    headers: {},
    // the router's placeholder baseline
    baseline: { candidateId: 'production', specId: '', status: 200, headers: {}, latencyMs: 50 },
    candidates: candidateIds.map((id) => response(id)),
  };
}

function batch(bodies: ScientistQueueMessage[]) {
  const messages = bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
  const b = { queue: 'beehive-scientist-comparisons', messages, ackAll: vi.fn(), retryAll: vi.fn() };
  return b;
}
const run = async (b: ReturnType<typeof batch>, env = makeEnv(fake)) => {
  await handler.queue(b as never, env, {} as ExecutionContext);
};
const posts = () => fake.calls.filter((c) => c.method === 'POST');

describe('samples', () => {
  it('posts one sample per ledger candidate with an Idempotency-Key, the placeholder baseline and the spec id from the ledger', async () => {
    const b = batch([message('req-1', [C1, C2])]);
    await run(b);
    expect(posts().map((c) => c.path)).toEqual([`/api/candidates/${C1}/shadow-samples`, `/api/candidates/${C2}/shadow-samples`]);
    expect(posts().map((c) => c.headers.get('Idempotency-Key'))).toEqual([`req-1:${C1}`, `req-1:${C2}`]);
    const body = posts()[0].body;
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0]).toMatchObject({ requestId: 'req-1', baseline: 'placeholder', matched: expect.any(Boolean) });
    expect(body.samples[0].score).toBeGreaterThanOrEqual(0);
    expect(body.samples[0].score).toBeLessThanOrEqual(100);
    // the router sends specId '' ; the comparator looked the candidate up and asked for that spec, not for ''
    expect(fake.calls.filter((c) => c.path === `/api/candidates/${C1}` && c.method === 'GET')).toHaveLength(1);
    expect(fake.calls.some((c) => c.path === `/api/specs/${SPEC}`)).toBe(true);
    expect(fake.calls.some((c) => c.path === '/api/specs/')).toBe(false);
    expect(b.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(b.messages[0].retry).not.toHaveBeenCalled();
    expect(b.ackAll).not.toHaveBeenCalled();
  });

  it('never posts or looks up the shadow router static targets (beehive-main has no ledger row)', async () => {
    const b = batch([message('req-2', ['beehive-main', C1])]);
    await run(b);
    expect(posts().map((c) => c.path)).toEqual([`/api/candidates/${C1}/shadow-samples`]);
    expect(fake.calls.some((c) => c.path.includes('beehive-main'))).toBe(false);
    expect(b.messages[0].ack).toHaveBeenCalledTimes(1);
  });
});

describe('fan-out (review S4)', () => {
  it('looks a candidate and its spec up once per batch, however many messages mention them', async () => {
    const b = batch([message('req-a', [C1, C2]), message('req-b', [C1, C2]), message('req-c', [C1])]);
    await run(b);
    expect(fake.calls.filter((c) => c.method === 'GET' && c.path === `/api/candidates/${C1}`)).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === 'GET' && c.path === `/api/candidates/${C2}`)).toHaveLength(1);
    expect(fake.calls.filter((c) => c.path === `/api/specs/${SPEC}`)).toHaveLength(1);
    expect(posts()).toHaveLength(5); // the samples themselves are never memoized
  });

  it('a failed read is not memoized, so the next message in the batch asks again', async () => {
    let n = 0;
    fake.candidate = (id) => (n++ === 0 ? json(500, { success: false }) : json(200, { success: true, data: { id, specId: SPEC } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = batch([message('req-d', [C1])]);
    await run(b);
    expect(b.messages[0].retry).toHaveBeenCalledTimes(1);
    const b2 = batch([message('req-d', [C1])]);
    await run(b2); // a new batch has a new client in any case
    expect(b2.messages[0].ack).toHaveBeenCalledTimes(1);
  });
});

describe('ack and retry, per message', () => {
  it("the Spec DO's coded 404 (unknown or tombstoned candidate) is acked, never retried", async () => {
    fake.post = () => json(404, { success: false, error: CANDIDATE_NOT_FOUND });
    const b = batch([message('req-3', [C1])]);
    await run(b);
    expect(b.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(b.messages[0].retry).not.toHaveBeenCalled();
  });

  it('a code-less 404 (an older Spec DO without the route) is acked, with one warning per batch, not one per message', async () => {
    fake.post = () => json(404, { success: false, error: 'Not found' });
    // The logger's sink is not fixed (console.log today): capture them all
    const lines: string[] = [];
    for (const level of ['warn', 'log', 'info', 'debug', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    }
    const b = batch([message('req-4', [C1]), message('req-5', [C1])]);
    await run(b);
    for (const m of b.messages) {
      expect(m.ack).toHaveBeenCalledTimes(1);
      expect(m.retry).not.toHaveBeenCalled();
    }
    expect(lines.filter((l) => l.includes('shadow_samples_unsupported'))).toHaveLength(1);
  });

  it('a 5xx from the Spec DO retries the message and does not ack it', async () => {
    fake.post = () => json(503, { success: false, error: 'busy' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = batch([message('req-6', [C1])]);
    await run(b);
    expect(b.messages[0].retry).toHaveBeenCalledTimes(1);
    // backs off with the attempt number (attempts = 1 here)
    expect(b.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(b.messages[0].ack).not.toHaveBeenCalled();
    expect(b.ackAll).not.toHaveBeenCalled();
  });

  it('a failing candidate read (5xx) retries; the router-sent specId is never trusted over the ledger', async () => {
    fake.candidate = () => json(500, { success: false, error: 'boom' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = batch([message('req-7', [C1])]);
    await run(b);
    expect(b.messages[0].retry).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(0);
  });

  it('a 400 (a body that can never be accepted) is acked, not retried', async () => {
    fake.post = () => json(400, { success: false, error: 'Invalid shadow samples' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = batch([message('req-8', [C1])]);
    await run(b);
    expect(b.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(b.messages[0].retry).not.toHaveBeenCalled();
  });

  it('settles each message on its own: one retried, one acked, in the same batch', async () => {
    fake.post = (id) => (id === C2 ? json(503, { success: false }) : json(200, { success: true, data: {} }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = batch([message('req-9', [C1]), message('req-10', [C2])]);
    await run(b);
    expect(b.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(b.messages[0].retry).not.toHaveBeenCalled();
    expect(b.messages[1].retry).toHaveBeenCalledTimes(1);
    expect(b.messages[1].ack).not.toHaveBeenCalled();
    expect(b.ackAll).not.toHaveBeenCalled();
  });

  it('an unparsable body is acked (it can never succeed)', async () => {
    const b = batch([undefined as never]);
    await run(b);
    expect(b.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(b.messages[0].retry).not.toHaveBeenCalled();
  });
});

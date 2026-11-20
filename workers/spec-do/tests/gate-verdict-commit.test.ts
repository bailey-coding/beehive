/**
 * Gate verdicts carry the commit they were decided for and whether they were simulated (schema m16, wave-2a-plan part C), and advance logs,
 * on a real move only, when pre-merge evidence is for another commit (commit_mismatch) or cannot be bound to one (evidence_unbound). The
 * evidence result is unchanged in 2a: enforcement waits for a candidates.commit_sha writer (b2-S8). Real SQL (node:sqlite) through the router.
 *
 * Task: wave-2a part C | Spec: docs/plans/wave-2a-plan.md part C; review b2-S4, b1-S8
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SpecDO } from '../index';
import { makeSqliteState, makeSpecDo, type SqliteState } from './sqlite-state';
import { freshLedger, loadLegacyLedger, readVersion, LATEST_VERSION } from './legacy-ledger';
import { legacyFixtures } from './fixtures/legacy';

let store: SqliteState;
let spec: SpecDO;
let actor: string;

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

async function call(path: string, method = 'GET', body?: unknown) {
  const res = await spec.fetch(
    new Request(`https://spec-do.internal${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-ID': actor },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  return { status: res.status, json: (await res.json()) as any };
}

const verdictRow = (candidateId: string) =>
  store.raw.prepare(`SELECT * FROM gate_verdicts WHERE candidate_id = ? AND gate = 'pre-merge'`).get(candidateId) as Record<string, any>;
const events = (event: string) => store.raw.prepare('SELECT * FROM governance_events WHERE event = ?').all(event) as Record<string, any>[];
const columns = (s: SqliteState, t: string) => (s.raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

function seed(commitSha = SHA_A) {
  const org = spec.createOrganization('gv-org', 'artifacts');
  const repo = spec.createRepository('gv-repo', org.id, 'baseline', undefined, undefined, 'https://example.invalid/r.git', 'gv-org');
  const s = spec.createSpec('gv-spec', 'd', 'contract', [], org.id, actor);
  return spec.createCandidate(s.id, repo.id, commitSha, SHA_B, actor);
}
const postVerdict = (candidateId: string, extra: Record<string, unknown> = {}) =>
  call('/api/gate-verdicts', 'POST', { candidateId, gate: 'pre-merge', status: 'pass', score: 90, complexityDelta: 0, notes: 'n', ...extra });

beforeEach(async () => {
  store = makeSqliteState();
  spec = makeSpecDo(store);
  await spec.init();
  actor = spec.createActor('agent', 'gv-agent').id;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('schema m16: gate_verdicts.commit_sha and simulated', () => {
  it.fails('a fresh ledger has both columns and is stamped m16', async () => {
    const fresh = await freshLedger();
    expect(columns(fresh, 'gate_verdicts')).toEqual(expect.arrayContaining(['commit_sha', 'simulated']));
    expect(LATEST_VERSION).toBe('m16');
  });

  it.fails('an m15 ledger gains both columns, its verdict keeps its values with NULL in the new columns, and a re-run changes nothing', async () => {
    const fx = legacyFixtures().find((f) => f.startVersion === 'm15')!;
    const s = loadLegacyLedger({ ddl: fx.ddl, seed: fx.seed, version: 'm15' });
    await makeSpecDo(s).init();
    expect(readVersion(s)).toBe('m16');
    expect(columns(s, 'gate_verdicts')).toEqual(expect.arrayContaining(['commit_sha', 'simulated']));
    expect(s.raw.prepare(`SELECT status, score, notes, commit_sha, simulated FROM gate_verdicts WHERE id = 'gv-1'`).get()).toEqual({
      status: 'pass', score: 90, notes: 'old', commit_sha: null, simulated: null,
    });
    await makeSpecDo(s).init();
    expect(readVersion(s)).toBe('m16');
  });
});

describe('POST /api/gate-verdicts stores the commit and the simulated flag', () => {
  it.fails('stores and returns them', async () => {
    const c = seed();
    const r = await postVerdict(c.id, { commitSha: SHA_A, simulated: true });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ commit_sha: SHA_A, simulated: true });
    expect(verdictRow(c.id)).toMatchObject({ commit_sha: SHA_A, simulated: 1 });
  });

  it.fails('a later verdict without them clears both (the upsert overwrites, review S2)', async () => {
    const c = seed();
    await postVerdict(c.id, { commitSha: SHA_A, simulated: true });
    await postVerdict(c.id);
    expect(verdictRow(c.id)).toMatchObject({ commit_sha: null, simulated: null });
  });

  it('a verdict without them still works (older callers)', async () => {
    const c = seed();
    expect((await postVerdict(c.id)).status).toBe(201);
  });
});

describe('advance: pre-merge evidence and the commit (log-only in 2a)', () => {
  it.fails('a verdict for another commit: a real advance moves and writes one commit_mismatch row', async () => {
    const c = seed(SHA_A);
    await postVerdict(c.id, { commitSha: SHA_B });
    const r = await call(`/api/candidates/${c.id}/advance`, 'POST', { toRung: 'shadow' });
    expect(r.status).toBe(200);
    expect(r.json.data.stage).toBe('passed_premerge');
    const rows = events('commit_mismatch');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail)).toMatchObject({ rung: 'pre-merge', evidenceCommit: SHA_B, candidateCommit: SHA_A });
    expect(events('evidence_unbound')).toEqual([]);
  });

  it.fails('a verdict with no commit: a real advance moves and writes one evidence_unbound row', async () => {
    const c = seed(SHA_A);
    await postVerdict(c.id);
    expect((await call(`/api/candidates/${c.id}/advance`, 'POST', { toRung: 'shadow' })).status).toBe(200);
    const rows = events('evidence_unbound');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail)).toMatchObject({ rung: 'pre-merge', candidateCommit: SHA_A });
  });

  it.fails('a candidate with no commit (claimed) is unbound too', async () => {
    const c = seed('');
    await postVerdict(c.id, { commitSha: SHA_A });
    expect((await call(`/api/candidates/${c.id}/advance`, 'POST', { toRung: 'shadow' })).status).toBe(200);
    expect(events('evidence_unbound')).toHaveLength(1);
  });

  it('a verdict for the candidate\'s commit writes neither row', async () => {
    const c = seed(SHA_A);
    await postVerdict(c.id, { commitSha: SHA_A });
    expect((await call(`/api/candidates/${c.id}/advance`, 'POST', { toRung: 'shadow' })).status).toBe(200);
    expect(events('commit_mismatch')).toEqual([]);
    expect(events('evidence_unbound')).toEqual([]);
  });

  it('a dry run writes neither row', async () => {
    const c = seed(SHA_A);
    await postVerdict(c.id, { commitSha: SHA_B });
    expect((await call(`/api/candidates/${c.id}/advance`, 'POST', { toRung: 'shadow', dryRun: true })).status).toBe(200);
    expect(events('commit_mismatch')).toEqual([]);
    expect(events('evidence_unbound')).toEqual([]);
  });
});

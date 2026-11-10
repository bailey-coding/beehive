/**
 * `npm run demo` (scripts/demo/tournament.ts) against the local workers, so the demo cannot rot silently.
 * Local only: the demo writes records, and e2e never writes to production without human approval (AGENTS.md).
 *
 * Task: demo-tournament | Spec: docs/plans/demo-tournament-plan.md
 */
import { describe, it, expect } from 'vitest';
import { getConfig } from './config';
import { runDemo, LOCAL_URLS } from '../../scripts/demo/tournament';

const config = getConfig();
const isLocal = config.environment === 'local';

describe.skipIf(!isLocal)('npm run demo (local)', () => {
  it('runs the whole story and leaves the ledger and refs in the end state it narrates', async () => {
    const lines: string[] = [];
    const result = await runDemo({ urls: LOCAL_URLS, token: config.apiToken, log: (l) => lines.push(l) });

    // A is recorded at full; the rollback put the canary ref back on A, not A2.
    expect(result.winnerRung).toBe('full');
    expect(result.canaryStatus).toEqual({ a: 'deployed', a2: 'rolled_back' });
    expect(result.liveCanaries).toEqual([result.candidates.a]);

    // The ledger holds the trial A won, and C's failed pre-merge verdict. Every read must be a 2xx (AGENTS.md).
    const headers = { Authorization: `Bearer ${config.apiToken}` };
    const get = async <T>(url: string): Promise<T> => {
      const res = await fetch(url, { headers });
      expect(res.ok, url).toBe(true);
      return (await res.json()) as T;
    };
    const trial = await get<{ data: { winner_id?: string; winnerId?: string } }>(`${LOCAL_URLS.api}/api/trials/${result.trialId}`);
    expect(trial.data.winner_id ?? trial.data.winnerId).toBe(result.candidates.a);
    const verdicts = await get<{ data: { gate: string; status: string }[] | { gate: string; status: string } }>(
      `${LOCAL_URLS.api}/api/candidates/${result.candidates.c}/gate-verdicts`
    );
    const list = Array.isArray(verdicts.data) ? verdicts.data : [verdicts.data];
    expect(list).toContainEqual(expect.objectContaining({ gate: 'pre-merge', status: 'fail' }));

    // The promotion worker refused C (no passing pre-merge verdict); C has no promotion state and never left pending.
    expect(result.refusedC).toEqual({ status: 409, code: 'evidence_missing' });
    const stageOf = async (id: string) => (await get<{ data: { stage: string } }>(`${LOCAL_URLS.api}/api/candidates/${id}`)).data.stage;
    expect(await stageOf(result.candidates.c)).toBe('pending');
    const cPromo = await get<{ status?: string; state?: unknown }>(`${LOCAL_URLS.promotion}/promote/${result.candidates.c}`);
    expect(cPromo.status).toBe('not_started');
    // B lost the tournament: it stays on the shadow rung. A was advanced one rung at a time and ended promoted.
    expect(await stageOf(result.candidates.b)).toBe('passed_premerge');
    expect(await stageOf(result.candidates.a)).toBe('promoted');

    // Every step is labelled, and the summary says what was simulated.
    expect(lines.filter((l) => /^── \d+\. .*\[(REAL|REAL record|REAL record, SCRIPTED input|REAL ref move, STUB build|REAL ref move, SCRIPTED breach)\]$/.test(l))).toHaveLength(10);
    expect(lines).toContain('── What was simulated');
    expect(lines.some((l) => l.startsWith('── Known gaps'))).toBe(true);
  }, 60000);

  it('a second run does not collide with the first', async () => {
    const quiet = { urls: LOCAL_URLS, token: config.apiToken, log: () => {} };
    const [one, two] = [await runDemo(quiet), await runDemo(quiet)];
    expect(one.specId).not.toBe(two.specId);
    expect(two.winnerRung).toBe('full');
  }, 60000);
});

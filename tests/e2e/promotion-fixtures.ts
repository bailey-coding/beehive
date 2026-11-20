/**
 * Fixtures for e2e tests that promote candidates (promotion-gaps PR C). The promotion worker asks the Spec DO's `advance` whether each move is
 * legal, so a promotion test needs a real candidate row in the stage it starts from, and real evidence where the move needs it.
 * Everything goes through the edge with the master token, like the rest of the suite; `test-org-e2e-*` is what the purge-by-prefix cleanup targets.
 *
 * Task: promotion-gaps | Spec: docs/plans/promotion-gaps-plan.md PR C
 */
import { expect } from 'vitest';
import { createRequest, readJson } from './helpers';
import { SHADOW_MIN_SAMPLES } from '../../workers/shared/shadow-verdict';

export interface PromotionWorld {
  actor: string;
  orgId: string;
  repoId: string;
  specId: string;
}

async function post(path: string, body: unknown, actor?: string, expected = 201): Promise<Record<string, any>> {
  const res = await fetch(createRequest(path, 'POST', body, actor ? { 'X-Actor-ID': actor } : {}));
  expect(res.status, `${path} -> ${JSON.stringify(await res.clone().json().catch(() => null)).slice(0, 200)}`).toBe(expected);
  return readJson(res);
}

/** An agent, an organization, a repository and a spec: the rows candidates hang from */
export async function seedWorld(label: string): Promise<PromotionWorld> {
  const stamp = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const actor = ((await post('/api/actors', { type: 'agent', name: `e2e-${stamp}` })).data as { id: string }).id;
  const orgId = ((await post('/api/organizations', { name: `test-org-e2e-${stamp}`, type: 'artifacts' }, actor)).data as { id: string }).id;
  const repoId = ((await post('/api/repositories', {
    name: 'repo', organizationId: orgId, repoType: 'baseline', remoteUrl: 'https://example.invalid/r.git', namespace: 'e2e',
  }, actor)).data as { id: string }).id;
  const specId = ((await post('/api/specs', { name: `spec-${stamp}`, contract: '{}', declaredDeltaSurface: [], organizationId: orgId }, actor)).data as { id: string }).id;
  return { actor, orgId, repoId, specId };
}

/** A 40-hex commit sha, unique per call (the gate refuses anything else, wave-2a part C) */
export function fakeSha(): string {
  return Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}

/** advance's target rung for each ladder stage (TARGET_STAGE in workers/shared/promotion-advance.ts, inverted) */
const RUNG_FOR_STAGE: Record<string, 'shadow' | 'train' | 'canary' | 'full'> = {
  passed_premerge: 'shadow',
  passed_shadow: 'train',
  passed_train: 'canary',
  promoted: 'full',
};
const LADDER = ['pending', 'passed_premerge', 'passed_shadow', 'passed_train', 'promoted'];

/**
 * A candidate at `stage`. Non-pending stages are reached the legal way (wave-2a part A: the stage PATCH writes only failed/rolled_back): a
 * passing pre-merge verdict, then the master-only edge `advance`, one rung per call, with the evidence each rung enforces (pre-merge; and for
 * `promoted` a live canary, deployed through the canary worker, soak 0 locally). The moves under test then go through /promote.
 */
export async function candidateAt(w: PromotionWorld, stage = 'pending'): Promise<string> {
  const id = ((await post('/api/candidates', { specId: w.specId, repositoryId: w.repoId, commitSha: fakeSha(), baseCommitSha: fakeSha() }, w.actor)).data as { id: string }).id;
  if (stage !== 'pending') await advanceTo(w, id, stage);
  return id;
}

/** Move a pending candidate up the ladder to `stage` through the edge `advance` (master token) */
export async function advanceTo(w: PromotionWorld, candidateId: string, stage: string): Promise<void> {
  const target = LADDER.indexOf(stage);
  expect(target, `advanceTo: ${stage} is not a ladder stage the fixture can reach`).toBeGreaterThan(0);
  const current = LADDER.indexOf(await stageOf(candidateId));
  if (current === 0) await passPremerge(w, candidateId);
  for (let i = current + 1; i <= target; i++) {
    const next = LADDER[i];
    if (next === 'promoted') await deployCanaryFor(w, candidateId);
    const res = await fetch(createRequest(`/api/candidates/${candidateId}/advance`, 'POST', { toRung: RUNG_FOR_STAGE[next], notes: 'e2e fixture' }, { 'X-Actor-ID': w.actor }));
    expect(res.status, `advance to ${next}: ${JSON.stringify(await res.clone().json().catch(() => null)).slice(0, 200)}`).toBe(200);
  }
  expect(await stageOf(candidateId)).toBe(stage);
}

/** A live canary for the candidate (the evidence for leaving the canary rung) */
async function deployCanaryFor(w: PromotionWorld, candidateId: string): Promise<void> {
  const res = await fetch(createRequest('/deploy-canary', 'POST', { candidateId, specId: w.specId, trafficPercentage: 10, holdoutPercentage: 5 }, {}, 'canary'));
  expect(res.ok, `deploy-canary for ${candidateId}: ${res.status}`).toBe(true);
}

/** A passing pre-merge gate verdict: the evidence for leaving the pre-merge rung */
export async function passPremerge(w: PromotionWorld, candidateId: string): Promise<void> {
  await post('/api/gate-verdicts', { candidateId, gate: 'pre-merge', status: 'pass', score: 90, complexityDelta: 0, notes: 'e2e' }, w.actor);
}

/** Shadow samples averaging `score`, through the maintainer-only edge route (the comparator's own path is the queue) */
export async function shadowScore(w: PromotionWorld, candidateId: string, score: number): Promise<void> {
  const samples = Array.from({ length: SHADOW_MIN_SAMPLES }, (_, i) => ({ requestId: `e2e-${candidateId}-${i}`, score, matched: score >= 100, diffs: [], baseline: 'production' }));
  await post(`/api/candidates/${candidateId}/shadow-samples`, { samples }, w.actor, 200);
}

export async function stageOf(candidateId: string): Promise<string> {
  const res = await fetch(createRequest(`/api/candidates/${candidateId}`));
  expect(res.status).toBe(200);
  return ((await readJson(res)).data as { stage: string }).stage;
}

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

/** A candidate at `stage`. Non-pending stages are placed with the master-tier stage PATCH (the documented break-glass), which is what a test
 * that starts mid-ladder needs; the moves under test then go through /promote. */
export async function candidateAt(w: PromotionWorld, stage = 'pending'): Promise<string> {
  const id = ((await post('/api/candidates', { specId: w.specId, repositoryId: w.repoId, commitSha: 'abc', baseCommitSha: 'base' }, w.actor)).data as { id: string }).id;
  if (stage !== 'pending') await setStage(w, id, stage);
  return id;
}

export async function setStage(w: PromotionWorld, candidateId: string, stage: string): Promise<void> {
  const res = await fetch(createRequest(`/api/candidates/${candidateId}/stage`, 'PATCH', { stage, notes: 'e2e fixture' }, { 'X-Actor-ID': w.actor }));
  expect(res.status, `stage PATCH to ${stage}`).toBe(200);
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

/**
 * The comparator's delta surface for a ledger spec (docs/plans/wave-1-plan.md part C, review c M1): a stored v1 object is used; anything
 * else (missing, invalid JSON, the edge's string array, a wrong version) falls back to the default surface instead of dropping the
 * comparison, with one log line per spec. getSpec reads the Spec DO's snake_case field and the camelCase one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { deltaSurfaceFor } from '../index';
import { getDefaultDeltaSurface, SUPPORTED_VERSION } from '../delta-surface';
import { SpecDOClient } from '../storage/spec-do';

afterEach(() => vi.restoreAllMocks());

const v1 = JSON.stringify({ version: SUPPORTED_VERSION, paths: { '/price': { status: 'strict' } }, defaults: getDefaultDeltaSurface().defaults });

describe('deltaSurfaceFor', () => {
  it('uses a stored v1 object', () => {
    const surface = deltaSurfaceFor({ id: 'v1-spec', declaredDeltaSurface: v1 });
    expect(Object.keys(surface.paths)).toEqual(['/price']);
  });

  it.each([
    ['the edge string array []', '[]'],
    ['a string array with a path', '["/price"]'],
    ['null (field missing)', 'null'],
    ['invalid JSON', '{not json'],
    ['a wrong version', JSON.stringify({ version: '999', paths: {} })],
  ])('falls back to the default surface for %s', (_n, stored) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(deltaSurfaceFor({ id: `spec-${_n}`, declaredDeltaSurface: stored })).toEqual(getDefaultDeltaSurface());
  });

  it('logs the fallback once per spec', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) deltaSurfaceFor({ id: 'once-spec', declaredDeltaSurface: '[]' });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('once-spec'))).toHaveLength(1);
  });
});

describe('SpecDOClient.getSpec', () => {
  const clientAnswering = (data: Record<string, unknown>) =>
    new SpecDOClient({
      SPEC_DO: { idFromName: () => 'id', get: () => ({ fetch: async () => Response.json({ success: true, data }) }) },
      SPEC_DO_INTERNAL_TOKEN: 't',
    } as never);

  it.each([
    ['snake_case (the current Spec DO)', { id: 's', declared_delta_surface: '["/a"]' }],
    ['camelCase', { id: 's', declaredDeltaSurface: '["/a"]' }],
  ])('reads the stored surface from %s', async (_n, data) => {
    expect(await clientAnswering(data).getSpec('s')).toEqual({ id: 's', declaredDeltaSurface: '["/a"]' });
  });
});

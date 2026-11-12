/** The seeders post at least the shadow minimum of production samples, so they work with the production-only switches on (plan section 16, S4). */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { SHADOW_MIN_SAMPLES, shadowMinProductionSamples } from '../../workers/shared/shadow-verdict';

describe('shadow seeders', () => {
  it('the demo and the shell seeder post exactly the minimum, as production samples', () => {
    const demo = readFileSync('scripts/demo/tournament.ts', 'utf8');
    expect(demo).toContain(`const DEMO_SHADOW_SAMPLES = ${shadowMinProductionSamples()};`);
    expect(demo).toContain("baseline: 'production'");
    const sh = readFileSync('scripts/prod-verify-promotion.sh', 'utf8');
    expect(sh).toContain(`range(0;${SHADOW_MIN_SAMPLES})`);
    expect(sh).toContain(`= "${SHADOW_MIN_SAMPLES}"`);
    expect(sh).toContain('baseline: \\"production\\"'.replace(/\\"/g, '"'));
  });
});

/**
 * MIRROR_SAMPLE_PERCENT and SHADOW_RUNG_MIRRORING open an exposure path (a sample of requests goes to candidates). The maintainer sets
 * them in `[vars]` of the Cloudflare Artifacts deploy repo (dashboard vars are overwritten by the next push, docs/OPS.md); the GitHub copy
 * of every wrangler config must never enable them, so an agent's pull request cannot turn mirroring on.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('mirror exposure vars', () => {
  const files = ['wrangler.toml', ...readdirSync('workers').map((w) => `workers/${w}/wrangler.toml`)].filter((f) => existsSync(f));
  it('are enabled in no wrangler config in this repo', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      // a commented-out example is fine; an assignment is not
      expect(text, f).not.toMatch(/^\s*MIRROR_SAMPLE_PERCENT\s*=\s*"?(?!0"?\s*$)\S/m);
      expect(text, f).not.toMatch(/^\s*SHADOW_RUNG_MIRRORING\s*=\s*"?true/im);
    }
  });
});

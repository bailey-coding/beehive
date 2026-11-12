/**
 * MIRROR_SAMPLE_PERCENT and SHADOW_RUNG_MIRRORING open an exposure path (a sample of requests goes to candidates). The maintainer sets
 * them in `[vars]` of the Cloudflare Artifacts deploy repo (dashboard vars are overwritten by the next push, docs/OPS.md); the GitHub copy
 * of every wrangler config must never enable them, so an agent's pull request cannot turn mirroring on.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { assignments } from '../helpers/toml-assignments';

describe('mirror exposure vars', () => {
  const files = ['wrangler.toml', ...readdirSync('workers').map((w) => `workers/${w}/wrangler.toml`), 'tests/e2e/probe/wrangler.toml'].filter((f) => existsSync(f));
  it('are enabled in no wrangler config in this repo', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const v of assignments(text, 'MIRROR_SAMPLE_PERCENT')) expect(v.trim(), f).toBe('0');
      for (const v of assignments(text, 'SHADOW_RUNG_MIRRORING')) expect(v.trim().toLowerCase(), f).not.toBe('true');
    }
  });

  it('the scanner sees inline tables, quoted keys and bare values, and ignores comments and "0"', () => {
    expect(assignments('vars = { MIRROR_SAMPLE_PERCENT = "5" }', 'MIRROR_SAMPLE_PERCENT')).toEqual(['5']);
    expect(assignments('"MIRROR_SAMPLE_PERCENT" = "5"', 'MIRROR_SAMPLE_PERCENT')).toEqual(['5']);
    expect(assignments('MIRROR_SAMPLE_PERCENT = 5', 'MIRROR_SAMPLE_PERCENT')).toEqual(['5']);
    expect(assignments('# MIRROR_SAMPLE_PERCENT = "5"', 'MIRROR_SAMPLE_PERCENT')).toEqual([]);
    expect(assignments('MIRROR_SAMPLE_PERCENT = "0"', 'MIRROR_SAMPLE_PERCENT')).toEqual(['0']);
  });
});

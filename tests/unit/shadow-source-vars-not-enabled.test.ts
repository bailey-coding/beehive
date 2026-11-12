/** SHADOW_VERDICT_SOURCE and TOURNAMENT_SHADOW_SOURCE are set by the maintainer in the deploy repo's `[vars]`; no config in this repo sets either to `production`. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { assignments } from '../helpers/toml-assignments';

describe('shadow source vars', () => {
  const files = ['wrangler.toml', ...readdirSync('workers').map((w) => `workers/${w}/wrangler.toml`)].filter((f) => existsSync(f));
  it('are not production in any wrangler config in this repo', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const k of ['SHADOW_VERDICT_SOURCE', 'TOURNAMENT_SHADOW_SOURCE']) for (const v of assignments(text, k)) expect(v.trim().toLowerCase(), `${f} ${k}`).not.toBe('production');
    }
  });
});

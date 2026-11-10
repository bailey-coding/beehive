/**
 * CANARY_MIN_SOAK_MINUTES shortens the canary soak that `advance` requires before a candidate reaches full. It exists for local e2e and the
 * demo (scripts/start-e2e-workers.sh passes it); a deployed wrangler.toml must never set it (docs/OPS.md, promotion-gaps plan V3).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('CANARY_MIN_SOAK_MINUTES', () => {
  it('is set in no wrangler config that deploys', () => {
    const files = ['wrangler.toml', ...readdirSync('workers').map((w) => `workers/${w}/wrangler.toml`)].filter((f) => existsSync(f));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain('CANARY_MIN_SOAK_MINUTES');
  });

  it('is passed by the local e2e start script', () => {
    expect(readFileSync('scripts/start-e2e-workers.sh', 'utf8')).toContain('CANARY_MIN_SOAK_MINUTES:0');
  });
});

/** The edge mirror source and the shadow router template with the same words: the router's MIRROR_ROUTE_WORDS must list every platform word. */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { PLATFORM_ROUTE_WORDS } from '../../workers/shared/route-template';

describe('route words', () => {
  it("the router's MIRROR_ROUTE_WORDS lists every PLATFORM_ROUTE_WORDS entry", () => {
    const toml = readFileSync('workers/shadow-router/wrangler.toml', 'utf8');
    const listed = new Set((toml.match(/^MIRROR_ROUTE_WORDS = "([^"]*)"/m)?.[1] ?? '').split(','));
    for (const w of PLATFORM_ROUTE_WORDS) expect(listed.has(w), w).toBe(true);
  });
});

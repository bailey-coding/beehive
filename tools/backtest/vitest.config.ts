// Standalone config: tools/backtest tests are NOT in the root vitest include, so `npm test` and CI do not run them.
// Run with `npm run test:backtest`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tools/backtest/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});

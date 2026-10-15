import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Test directories
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.spec.ts',
      'workers/**/tests/**/*.test.ts',
      'workers/**/tests/**/*.spec.ts',
    ],
    exclude: ['node_modules', 'dist', '**/node_modules/**'],
    
    // Environment
    environment: 'node',
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['workers/**/*.ts'],
      exclude: [
        'workers/**/*.test.ts',
        'workers/**/*.spec.ts',
        'node_modules/**',
      ],
    },
    
    // Output configuration
    outputFile: {
      junit: './test-results/junit.xml',
      json: './test-results/results.json',
    },
    
    // Setup files
    setupFiles: ['./tests/setup.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    
    // Timeout configuration
    testTimeout: process.env.E2E_ENVIRONMENT === 'production' ? 30000 : 15000,
    hookTimeout: 10000,
    
    // Parallel execution
    threads: true,
    maxThreads: process.env.E2E_ENVIRONMENT === 'local' ? 2 : 4,
    minThreads: 1,
    
    // Retries
    retries: process.env.CI ? 2 : 0,
    
    // Watch mode
    watch: false,
    
    // Pass through environment variables to tests
    passThroughEnv: [
      'E2E_ENVIRONMENT',
      'BEEHIVE_API_TOKEN',
      'STAGING_API_TOKEN',
      'CLOUDFLARE_ACCOUNT',
      'BEEHIVE_BASE_URL',
      'SHADOW_ROUTER_URL',
      'CANARY_WORKER_URL',
      'PROMOTION_WORKER_URL',
    ],
    
    // TypeScript support
    globals: true,
    
    // Cache configuration
    cache: {
      dir: './.vitest-cache',
    },
    
    // Silence console output in tests (can be overridden with --verbose)
    silent: false,
    
    // Allow tests to use top-level await
    allowTopLevelAwait: true,
    
    // Use chai for assertions (vitest uses chai internally)
    chaiConfig: {
      truncateThreshold: 0,
    },
  },
  
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@workers': path.resolve(__dirname, 'workers'),
      '@tests': path.resolve(__dirname, 'tests'),
      '@shared': path.resolve(__dirname, 'workers/shared'),
    },
  },
});

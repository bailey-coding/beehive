/**
 * Test Setup
 * 
 * Global setup for all tests
 * 
 * Phase: 4
 * Task: test-phase-4-setup
 * Spec: Testing
 * Confidence: 1.0
 */

import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Global test setup
beforeAll(() => {
  // Set test environment if not already set
  if (!process.env.E2E_ENVIRONMENT) {
    process.env.E2E_ENVIRONMENT = 'local';
  }
});

// Clean up after all tests
afterAll(() => {
  // Clean up any global state
  vi.restoreAllMocks();
});

// Clean up between tests - don't clearAllMocks as it breaks mock handlers in E2E tests
// beforeEach(() => {
//   vi.clearAllMocks();
// });

afterEach(() => {
  // Clean up after each test - don't restoreAllMocks as it breaks mock handlers in E2E tests
  // vi.restoreAllMocks();
});

// Export for potential use in other files
export { beforeAll, afterAll, beforeEach, afterEach, vi };

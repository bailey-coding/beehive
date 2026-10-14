/**
 * Global Test Setup
 * 
 * Runs once before all tests
 * 
 * Phase: 4
 * Task: test-phase-4-global-setup
 * Spec: Testing
 * Confidence: 1.0
 */

import { config } from 'dotenv';
import path from 'path';

// Load environment variables from .env.test files
function loadTestEnv() {
  const envPath = path.resolve(__dirname, `../.env.test.${process.env.E2E_ENVIRONMENT || 'local'}`);
  
  try {
    config({ path: envPath, override: true });
    console.log(`Loaded test environment from: ${envPath}`);
  } catch (error) {
    // If file doesn't exist, try to load from parent directory
    const parentEnvPath = path.resolve(__dirname, `../.env.test.${process.env.E2E_ENVIRONMENT || 'local'}`);
    try {
      config({ path: parentEnvPath, override: true });
      console.log(`Loaded test environment from: ${parentEnvPath}`);
    } catch {
      // File doesn't exist, use process.env
      console.log('No test environment file found, using process.env');
    }
  }
}

// Load environment for production tests
function loadProductionEnv() {
  if (process.env.E2E_ENVIRONMENT === 'production') {
    // Load production-specific environment
    const prodEnvPath = path.resolve(__dirname, '../.env.test.production');
    try {
      config({ path: prodEnvPath, override: true });
      console.log(`Loaded production environment from: ${prodEnvPath}`);
    } catch {
      console.log('No production environment file found');
    }
  }
}

// Main setup
export default async function globalSetup() {
  console.log('\n=== Global Test Setup ===\n');
  
  // Load test environment
  loadTestEnv();
  
  // Load production environment if needed
  loadProductionEnv();
  
  // Validate required environment variables for production
  if (process.env.E2E_ENVIRONMENT === 'production') {
    if (!process.env.BEEHIVE_API_TOKEN) {
      console.warn(
        'Warning: BEEHIVE_API_TOKEN not set for production tests. ' +
        'Some tests may fail.'
      );
    }
  }
  
  console.log(`Test Environment: ${process.env.E2E_ENVIRONMENT || 'local'}`);
  console.log('=== Global Test Setup Complete ===\n');
}

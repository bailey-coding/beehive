/**
 * CLI Smoke Tests
 * Basic syntax validation for CLI command files
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('CLI Command Files', () => {
  const commandsDir = join(__dirname, '../cli/src/commands');
  
  it('should have all expected command files', () => {
    const files = readdirSync(commandsDir);
    const expected = [
      'actor.ts',
      'auth.ts',
      'candidate.ts',
      'debug.ts',
      'gate.ts',
      'health.ts',
      'history.ts',
      'issue.ts',
      'org.ts',
      'promotion.ts',
      'repo.ts',
      'spec.ts',
      'trial.ts',
    ];
    
    for (const expectedFile of expected) {
      expect(files).toContain(expectedFile);
    }
  });

  it('should have register functions in each command file', () => {
    const files = readdirSync(commandsDir);
    
    for (const file of files) {
      if (file.endsWith('.ts')) {
        const content = readFileSync(join(commandsDir, file), 'utf-8');
        expect(content).toMatch(/export function register\w+Commands/);
      }
    }
  });

  it('should use requiredOption for required flags', () => {
    const files = readdirSync(commandsDir);
    
    // Check that we're using requiredOption instead of { required: true }
    for (const file of files) {
      if (file.endsWith('.ts')) {
        const content = readFileSync(join(commandsDir, file), 'utf-8');
        // Should not have the old syntax
        expect(content).not.toMatch(/\.option\([^,]+,[^,]+,\s*\{\s*required:\s*true\s*\}/);
      }
    }
  });
});

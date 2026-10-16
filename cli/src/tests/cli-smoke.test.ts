/**
 * CLI Smoke Tests
 * Tests that all CLI commands can be parsed with their flags
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createCli } from '../index';
import { Command } from 'commander';

// Helper to test command parsing
function testCommandParsing(program: Command, commandPath: string, args: string[] = []): { parsed: Record<string, unknown>; error?: string } {
  const argv = ['node', 'beehive', ...commandPath.split(' '), ...args];
  
  try {
    // Parse without executing actions
    const parsed = program.parse(argv, { from: 'user' });
    return { parsed: parsed.opts() || {} };
  } catch (error) {
    return { parsed: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

describe('CLI Smoke Tests', () => {
  let program: Command;

  beforeAll(() => {
    // Create the CLI without executing
    program = createCli();
  });

  describe('Command Registration', () => {
    it('should register all main command groups', () => {
      const commandNames = program.commands.map(cmd => cmd.name());
      
      const expectedGroups = [
        'org',
        'actor',
        'repo',
        'spec',
        'candidate',
        'trial',
        'promotion',
        'gate',
        'issue',
        'health',
        'auth',
        'history',
        'debug',
      ];
      
      for (const expected of expectedGroups) {
        expect(commandNames).toContain(expected);
      }
    });
  });

  describe('Option Parsing', () => {
    describe('Organization Commands', () => {
      it('should parse org create with required options', () => {
        const result = testCommandParsing(program, 'org create', ['--name', 'Test Org', '--type', 'github']);
        expect(result.error).toBeUndefined();
      });

      it('should parse org list', () => {
        const result = testCommandParsing(program, 'org list');
        expect(result.error).toBeUndefined();
      });
    });

    describe('Actor Commands', () => {
      it('should parse actor create with required options', () => {
        const result = testCommandParsing(program, 'actor create', ['--name', 'Test Actor', '--type', 'human']);
        expect(result.error).toBeUndefined();
      });
    });

    describe('Repository Commands', () => {
      it('should parse repo create with required options', () => {
        const result = testCommandParsing(program, 'repo create', ['TestRepo', '--organization', 'org-123', '--remote-url', 'https://github.com/test/repo', '--namespace', 'test', '--type', 'candidate']);
        expect(result.error).toBeUndefined();
      });

      it('should parse repo list', () => {
        const result = testCommandParsing(program, 'repo list');
        expect(result.error).toBeUndefined();
      });
    });

    describe('Spec Commands', () => {
      it('should parse spec create with required options', () => {
        const result = testCommandParsing(program, 'spec create', ['TestSpec', '--organization', 'org-123', '--contract', '{"type":"test"}', '--declared-delta-surface', 'api,db']);
        expect(result.error).toBeUndefined();
      });

      it('should parse spec claim with options', () => {
        const result = testCommandParsing(program, 'spec claim', ['spec-123', '--actor', 'actor-123', '--dry-run']);
        expect(result.error).toBeUndefined();
      });
    });

    describe('Candidate Commands', () => {
      it('should parse candidate create with required options', () => {
        const result = testCommandParsing(program, 'candidate create', ['--spec', 'spec-123', '--repository', 'repo-123', '--commit', 'abc123', '--base-commit', 'def456']);
        expect(result.error).toBeUndefined();
      });
    });

    describe('Issue Commands', () => {
      it('should parse issue create with required options', () => {
        const result = testCommandParsing(program, 'issue create', ['Test Issue', '--repository', 'repo-123', '--number', '1']);
        expect(result.error).toBeUndefined();
      });
    });

    describe('Trial Commands', () => {
      it('should parse trial create with required options', () => {
        const result = testCommandParsing(program, 'trial create', ['--candidate-a', 'cand-1', '--candidate-b', 'cand-2', '--spec', 'spec-123']);
        expect(result.error).toBeUndefined();
      });

      it('should parse trial decide with required options', () => {
        const metrics = '{"conformance_score":{"a":1,"b":0}}';
        const result = testCommandParsing(program, 'trial decide', ['trial-123', 'cand-1', '--comparison-metrics', metrics]);
        expect(result.error).toBeUndefined();
      });
    });

    describe('Promotion Commands', () => {
      it('should parse promotion create with required options', () => {
        const result = testCommandParsing(program, 'promotion create', ['cand-123', '--from-rung', 'pre-merge', '--to-rung', 'shadow']);
        expect(result.error).toBeUndefined();
      });
    });

    describe('Gate Commands', () => {
      it('should parse gate run with required options', () => {
        const result = testCommandParsing(program, 'gate run', ['cand-123', '--gate', 'pre-merge']);
        expect(result.error).toBeUndefined();
      });
    });

    describe('Health Commands', () => {
      it('should parse health check', () => {
        const result = testCommandParsing(program, 'health check');
        expect(result.error).toBeUndefined();
      });

      it('should parse health check with extended option', () => {
        const result = testCommandParsing(program, 'health check', ['--extended']);
        expect(result.error).toBeUndefined();
      });
    });
  });
});

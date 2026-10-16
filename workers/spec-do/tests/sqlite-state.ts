/**
 * Test-only DurableObjectState over node:sqlite, so SpecDO runs real SQL through
 * its real storage adapter. Foreign keys are enforced and transactionSync rolls
 * back on throw, as in Durable Object SQLite.
 */
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { SpecDO } from '../index';
import { authedDo, TEST_DO_TOKENS } from './do-tokens';

// vite strips the `node:` prefix from sqlite; load via require instead.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface SqliteState {
  raw: DatabaseSyncType;
  kv: Map<string, unknown>;
  transactions: { count: number };
  state: unknown;
}

// Pass an existing raw db and kv to model a restarted DO over the same storage
export function makeSqliteState(
  raw: DatabaseSyncType = newDatabase(),
  kv: Map<string, unknown> = new Map()
): SqliteState {
  const transactions = { count: 0 };
  const state = {
    storage: {
      get: async (k: string) => kv.get(k),
      put: async (k: string, v: unknown) => void kv.set(k, v),
      transactionSync<T>(fn: () => T): T {
        transactions.count++;
        raw.exec('SAVEPOINT tx');
        try {
          const result = fn();
          raw.exec('RELEASE tx');
          return result;
        } catch (e) {
          raw.exec('ROLLBACK TO tx');
          raw.exec('RELEASE tx');
          throw e;
        }
      },
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          if (bindings.length === 0 && /;\s*\S/.test(query.trim())) {
            raw.exec(query);
            return { next: () => ({ done: true as const }), columnNames: [] };
          }
          const stmt = raw.prepare(query);
          if (!/^\s*(select|pragma)/i.test(query)) {
            stmt.run(...(bindings as never[]));
            return { next: () => ({ done: true as const }), columnNames: [] };
          }
          const rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
          let i = 0;
          return {
            next: () => (i < rows.length ? { value: rows[i++] } : { done: true as const }),
            columnNames: stmt.columns().map((c) => c.name),
          };
        },
      },
    },
  };
  return { raw, kv, transactions, state };
}

/** A real DO built with the test tokens; `authed` (default) adds them to every fetch, like the API worker */
export function makeSpecDo(s: SqliteState = makeSqliteState(), authed = true): SpecDO {
  const spec = new SpecDO(s.state as never, { ...TEST_DO_TOKENS } as never);
  return authed ? authedDo(spec) : spec;
}

export function newDatabase(): DatabaseSyncType {
  return new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
}

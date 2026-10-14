/**
 * Adapter over the Durable Object's native SQLite storage (state.storage.sql),
 * exposing the same statement surface the SpecDO was written against
 * (prepare/bind/step/free/getColumnNames/get) so callsites stay unchanged.
 */

interface NativeRow {
  [column: string]: unknown;
}

export interface SqlStatement {
  bind(...values: (string | number | null)[]): SqlStatement;
  step(): boolean;
  reset(): void;
  free(): void;
  getColumnNames(): string[];
  get(index: number): unknown;
  getRow(): Record<string, unknown> | null;
}

export interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

export function createSqlStorage(state: DurableObjectState): SqlDb {
  const sql = (state.storage as unknown as { sql: SqlStorageShim }).sql;
  return {
    exec(query: string): void {
      sql.exec(query);
    },
    prepare(query: string): SqlStatement {
      let cursor:
        | {
            next: () => { done?: false; value: NativeRow } | { done: true; value?: never };
            columnNames: string[];
          }
        | null = null;
      let current: NativeRow | null = null;
      let boundValues: (string | number | null)[] = [];
      let started = false;
      const run = () => {
        if (cursor) return;
        // Native exec(query, ...bindings) returns a cursor; we pass bindings at exec time.
        cursor = sql.exec(query, ...boundValues) as NonNullable<typeof cursor>;
        started = true;
      };
      return {
        bind(...values: (string | number | null)[]): SqlStatement {
          boundValues.push(...values);
          return this;
        },
        step(): boolean {
          run();
          if (!cursor) return false;
          const result = cursor.next();
          if (result.done) {
            current = null;
            return false;
          }
          current = result.value;
          return true;
        },
        reset(): void {
          cursor = null;
          current = null;
          started = false;
          boundValues = [];
        },
        free(): void {
          cursor = null;
          current = null;
        },
        getColumnNames(): string[] {
          run();
          return cursor ? cursor.columnNames : [];
        },
        get(index: number): unknown {
          if (!current) return undefined;
          const names = cursor ? cursor.columnNames : [];
          const key = names[index];
          return key !== undefined ? current[key] : undefined;
        },
        getRow(): Record<string, unknown> | null {
          return current ? { ...current } : null;
        },
      };
    },
  };
}

interface SqlStorageShim {
  exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]): {
    next(): { done?: false; value: T } | { done: true; value?: never };
    columnNames: string[];
  };
}

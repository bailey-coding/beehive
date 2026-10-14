declare module 'sql.js' {
  export interface SqlJsStatement {
    bind(...args: unknown[]): void;
    step(): boolean;
    reset(): void;
    free(): void;
    getColumnNames(): string[];
    get(param: number): unknown;
  }
  export interface Database {
    exec(sql: string): void;
    prepare(sql: string): SqlJsStatement;
  }
  export class Database {
    constructor(data?: ArrayLike<number>);
    exec(sql: string): void;
    prepare(sql: string): SqlJsStatement;
  }
}

declare module '*.sql?raw' {
  const content: string;
  export default content;
}

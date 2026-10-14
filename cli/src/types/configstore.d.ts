// Type declaration for configstore module
// This is a work around for missing type definitions

declare module 'configstore' {
  interface Configstore {
    get<T = unknown>(key: string): T | undefined;
    set<T = unknown>(key: string, value: T): void;
    delete(key: string): void;
    get all(): Record<string, unknown>;
    get path(): string;
  }

  interface ConfigstoreConstructor {
    new (packageName: string, defaults?: Record<string, unknown>): Configstore;
  }

  const Configstore: ConfigstoreConstructor;
  export = Configstore;
}

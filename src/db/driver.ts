// ──────────────────────────────────────────────────────────────────────────
// DatabaseDriver — the runtime-agnostic seam between the library core and
// whatever actually talks to SQLite.
//
// db/sqlite.ts is the *Deno* implementation (shells out to the sqlite3 CLI
// via Deno.Command). Node.js consumers (the VS Code extension, via JSR's
// npm bridge — see backlog TASK-1) provide their own implementation, e.g.
// `child_process.exec`-based shelling or better-sqlite3. The core
// (db/helpers.ts, flows/, pipelines/) only ever sees this interface, so it
// never imports a `Deno.*` API. Companion to the CommandRunner / FileSystem
// abstractions in src/platform.ts (TASK-12/13). See backlog TASK-14.
//
// Why a module-level registry instead of threading the driver through every
// call? The helper layer (getAsync/queryAsync/runAsync) is called from
// dozens of sites in flows/ and pipelines/ with no context object to carry
// a driver. The pre-existing Deno driver already keeps its state (dbPath,
// logger) module-private for exactly this reason — JS runtimes are
// single-threaded, so one "current driver" slot is safe in practice and
// keeps the public helper signatures stable (AC #7: default Deno behaviour
// unchanged).
// ──────────────────────────────────────────────────────────────────────────

/** Optional logger injected by the caller (CLI vs library vs tests). */
export type Logger = {
  log: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
  error: (msg: string, ...rest: unknown[]) => void;
};

/**
 * Everything the library core needs from a SQLite backend.
 *
 * Contract notes for implementors:
 *   • `sql` strings use positional `?` placeholders; the *driver* is
 *     responsible for binding `params` safely (the Deno CLI driver does
 *     literal substitution with SQL-standard quote doubling, a native
 *     binding like better-sqlite3 gets real parameter binding for free).
 *   • `query` must return one plain object per row (the shape the sqlite3
 *     CLI's `-json` flag produces: https://sqlite.org/cli.html#json_output).
 *   • `transaction` wraps its statements in BEGIN/COMMIT with implicit
 *     rollback on failure; `batch` runs them independently (a partial apply
 *     is acceptable — used for idempotent migrations).
 *   • `applySchema` accepts SQL DDL text. (The Deno implementation also
 *     tolerates a filesystem path for backward compatibility.)
 */
export interface DatabaseDriver {
  /**
   * Open/point the driver at a database file and apply connection-level
   * settings (the Deno impl enables WAL + busy_timeout). Idempotent; a
   * second call may switch the driver to a different database file.
   */
  initialize(dbPath: string, logger?: Logger): Promise<void>;
  /** Run a query and return all rows. `T` is the caller-asserted row shape. */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Return the first row, or `undefined` when the query yields none. */
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Run a non-returning statement (INSERT/UPDATE/DELETE/ALTER). */
  run(sql: string, params?: unknown[]): Promise<void>;
  /** Run statements atomically inside a single BEGIN/COMMIT. */
  transaction(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void>;
  /** Run statements sequentially, non-transactionally (partial apply OK). */
  batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void>;
  /**
   * Merge the WAL back into the main database file — call before file-level
   * operations like backup copies. https://sqlite.org/pragma.html#pragma_wal_checkpoint
   */
  checkpoint(): Promise<void>;
  /** Apply SQL DDL (e.g. the bundled {@linkcode ../schema.ts:SCHEMA_SQL}). */
  applySchema(sql: string): Promise<void>;
  /** Absolute path of the current database file ('' if uninitialised). */
  getPath(): string;
}

// ── Active-driver registry ───────────────────────────────────────────────

/**
 * The driver all helper-layer calls (db/helpers.ts) route through.
 * `undefined` until something registers — we do NOT default to the Deno
 * implementation here, because importing it would drag `Deno.*` into every
 * consumer of this module and defeat the abstraction.
 */
let activeDriver: DatabaseDriver | undefined;

/**
 * Register the driver used by all subsequent helper-layer DB calls.
 *
 * Deno callers rarely need this: `initializeCli()` (and therefore the
 * `initDatabase` pipeline) self-registers the Deno driver. Non-Deno
 * consumers call this once at startup — or simply pass `driver` in
 * {@linkcode ../pipelines/initDatabase.ts:InitCtx}, which registers it.
 *
 * @param driver The implementation to make current.
 */
export function setDatabaseDriver(driver: DatabaseDriver): void {
  activeDriver = driver;
}

/**
 * The currently registered driver.
 *
 * @return The active {@link DatabaseDriver}.
 * @throws If nothing has been registered yet — mirrors the old
 *         "CLI wrapper not initialized" guard in db/sqlite.ts, but names
 *         both registration paths so the fix is obvious on any runtime.
 */
export function getDatabaseDriver(): DatabaseDriver {
  if (!activeDriver) {
    throw new Error(
      'No DatabaseDriver registered. Call initializeCli() (Deno default) or ' +
        'setDatabaseDriver(yourDriver) before using the DB helpers.',
    );
  }
  return activeDriver;
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { getDatabaseDriver, setDatabaseDriver } from './db/driver.ts';
// import { denoSqliteDriver } from './db/sqlite.ts';
//
// // 1. Deno default: initialize() via the concrete driver, registry follows
// await denoSqliteDriver.initialize('/tmp/way-test.db');
// getDatabaseDriver().getPath();                    // '/tmp/way-test.db'
//
// // 2. Substitute a custom driver (spy, in-memory fake, Node child_process…)
// const spy = { ...denoSqliteDriver, run: (sql) => (console.log(sql), denoSqliteDriver.run(sql)) };
// setDatabaseDriver(spy);
// await getDatabaseDriver().run('CREATE TABLE IF NOT EXISTS t (id INTEGER)');
//
// // 3. Unregistered access fails loudly with both fixes named
// // setDatabaseDriver(undefined as never)  // (don't) — getDatabaseDriver() would throw

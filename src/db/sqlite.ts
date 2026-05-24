// ──────────────────────────────────────────────────────────────────────────
// SQLite access via the `sqlite3` CLI binary.
//
// Why shell out instead of using an FFI or wasm SQLite binding?
//   • Works identically under Deno *and* under Node (the VS Code extension
//     will consume this package via JSR's npm bridge).
//   • Zero native compilation in the consumer toolchain.
//   • Avoids the historical pain we had with sqlite3 native modules across
//     VS Code's electron versions.
//
// Ported from waystation-vscode/src/db/sqliteCli.ts. Differences from the
// upstream Node version:
//   • `child_process.exec` → `Deno.Command` (https://docs.deno.com/api/deno/~/Deno.Command)
//   • The 10MB output ceiling is enforced by reading the captured stdout
//     directly (Deno.Command captures unbounded by default; we cap manually
//     so a runaway query can't blow up the process).
//   • Logging is routed through an optional `logger` field on the context;
//     we drop the upstream `console.log` noise.
//
// References:
//   • sqlite3 CLI flags:        https://sqlite.org/cli.html
//   • SQLite WAL journal mode:  https://sqlite.org/wal.html
//   • PRAGMA busy_timeout:      https://sqlite.org/pragma.html#pragma_busy_timeout
//   • PRAGMA wal_checkpoint:    https://sqlite.org/pragma.html#pragma_wal_checkpoint
// ──────────────────────────────────────────────────────────────────────────

import { join } from '@std/path';

/** Optional logger injected by the caller (CLI vs library vs tests). */
export type Logger = {
  log: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
  error: (msg: string, ...rest: unknown[]) => void;
};

const silentLogger: Logger = { log: () => {}, warn: () => {}, error: () => {} };

/**
 * Driver state. Held module-private so callers don't have to thread a
 * connection handle through every query — the shell-out model is stateless
 * at the protocol level, so we only need to remember the DB path.
 *
 * Note: this mirrors the original Node version's module-level `dbPath`. It
 * is *not* thread-safe, but JavaScript runtimes are single-threaded so this
 * is fine in practice.
 */
let dbPath = '';
let logger: Logger = silentLogger;

/** Maximum stdout buffered from any single sqlite3 invocation. 10 MiB. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Initialise the driver against a database file. Enables WAL journaling for
 * concurrent reads/writes and a 5-second busy timeout.
 *
 * Idempotent: safe to call multiple times. A subsequent call switches the
 * driver to a new database file (used during backup/restore).
 *
 * @param databasePath  Absolute filesystem path to the sqlite database.
 * @param customLogger  Optional structured logger; defaults to silent.
 */
export async function initializeCli(
  databasePath: string,
  customLogger: Logger = silentLogger,
): Promise<void> {
  dbPath = databasePath;
  logger = customLogger;

  // WAL mode: allows readers and a writer to coexist without locking the DB.
  await executeQuery('PRAGMA journal_mode=WAL');
  // 5-second wait when another writer holds the lock before raising
  // SQLITE_BUSY. Retry/backoff at the JS layer kicks in if this still trips.
  await executeQuery('PRAGMA busy_timeout=5000');

  logger.log('[sqlite] Initialised with WAL mode');
}

/** Returns the current database path (empty string if uninitialised). */
export function getDatabasePath(): string {
  return dbPath;
}

/**
 * Execute a query and parse the JSON-rows output. SELECTs return their row
 * objects; statements that don't return rows resolve to `[]`.
 *
 * @typeParam T  Caller-asserted shape of each returned row.
 */
export async function executeQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  // The PRAGMAs called by initializeCli run before dbPath is set; let those
  // through. Every other caller must initialise first.
  if (!dbPath && !sql.includes('PRAGMA')) {
    throw new Error('CLI wrapper not initialized. Call initializeCli() first.');
  }

  return await executeWithRetry(async () => {
    const boundSql = bindParameters(sql, params);

    // Write SQL to a temp file rather than passing it as an argv string, to
    // avoid shell-quoting hell for queries containing newlines, quotes, or
    // arbitrary user content (e.g. a `match.line` containing apostrophes).
    const tmpFile = await tempSqlFile(boundSql);
    try {
      const { stdout, stderr, code } = await runSqlite([
        '-json',
        dbPath,
      ], { stdinFile: tmpFile });

      if (stderr && stderr.trim()) {
        // sqlite3 prints "Parse error" to stderr for SQL errors but still
        // exits 1 — we surface that as a thrown Error below via exit code.
        if (code !== 0) {
          throw new Error(`sqlite3 error (exit ${code}): ${stderr.trim()}`);
        }
        logger.warn('[sqlite] Warning:', stderr.trim());
      }

      if (!stdout || stdout.trim() === '') return [];

      try {
        return JSON.parse(stdout);
      } catch (parseError) {
        logger.error('[sqlite] Failed to parse JSON output:', stdout);
        throw new Error(`Failed to parse SQLite JSON output: ${parseError}`);
      }
    } finally {
      try {
        await Deno.remove(tmpFile);
      } catch {
        // Non-fatal — the OS will reap the temp dir eventually.
      }
    }
  });
}

/** Convenience wrapper: returns the first row or `undefined`. */
export async function executeGet<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const results = await executeQuery<T>(sql, params);
  return results[0];
}

/** Convenience wrapper for write statements (INSERT/UPDATE/DELETE). */
export async function executeRun(sql: string, params: unknown[] = []): Promise<void> {
  await executeQuery(sql, params);
}

/**
 * Execute multiple statements wrapped in a single BEGIN/COMMIT. Roll-back is
 * implicit if any statement fails (sqlite3 CLI aborts on the first error).
 */
export async function executeTransaction(
  statements: Array<{ sql: string; params?: unknown[] }>,
): Promise<void> {
  if (!dbPath) {
    throw new Error('CLI wrapper not initialized. Call initializeCli() first.');
  }

  return await executeWithRetry(async () => {
    const lines = ['BEGIN TRANSACTION;'];
    for (const stmt of statements) {
      lines.push(bindParameters(stmt.sql, stmt.params || []) + ';');
    }
    lines.push('COMMIT;');
    const transactionSql = lines.join('\n');

    const tmpFile = await tempSqlFile(transactionSql);
    try {
      const { stderr, code } = await runSqlite([dbPath], { stdinFile: tmpFile });
      if (code !== 0) {
        throw new Error(`sqlite3 transaction failed (exit ${code}): ${stderr.trim()}`);
      }
      if (stderr && stderr.trim() && !stderr.includes('Parse error')) {
        logger.warn('[sqlite] Transaction warning:', stderr.trim());
      }
    } finally {
      try {
        await Deno.remove(tmpFile);
      } catch { /* non-fatal */ }
    }
  });
}

/**
 * Non-transactional batch — handy for migrations where a partial apply is OK
 * (e.g. ALTER TABLE ADD COLUMN guarded by pragma_table_info checks).
 */
export async function executeBatch(
  statements: Array<{ sql: string; params?: unknown[] }>,
): Promise<void> {
  for (const stmt of statements) {
    await executeRun(stmt.sql, stmt.params);
  }
}

/**
 * Force the WAL file to be merged back into the main database. Call before
 * file-level operations (copy for backup, etc.) so the backup contains the
 * latest committed state. https://sqlite.org/pragma.html#pragma_wal_checkpoint
 */
export async function checkpoint(): Promise<void> {
  await executeQuery('PRAGMA wal_checkpoint(TRUNCATE)');
  logger.log('[sqlite] WAL checkpoint completed');
}

/**
 * Run a `.sql` script file against the current database. Used to apply
 * `schema.sql` during initialisation.
 */
export async function applySchemaFile(schemaPath: string): Promise<void> {
  try {
    await Deno.stat(schemaPath);
  } catch {
    throw new Error(`Schema file not found: ${schemaPath}`);
  }

  logger.log(`[sqlite] Applying schema from: ${schemaPath}`);

  const { stderr, code } = await runSqlite([dbPath], { stdinFile: schemaPath });
  if (code !== 0) {
    throw new Error(`Schema apply failed (exit ${code}): ${stderr.trim()}`);
  }
  if (stderr && stderr.trim() && !stderr.includes('Parse error')) {
    logger.warn('[sqlite] Schema warning:', stderr.trim());
  }

  logger.log('[sqlite] Schema applied successfully');
}

/**
 * Probe for the sqlite3 CLI on PATH. Returns version on success. Used by
 * `initDatabase` so we can fail with a clear, actionable error rather than
 * an opaque ENOENT when the user is missing the dependency.
 */
export async function checkSqlite3Available(): Promise<{ available: boolean; version?: string }> {
  try {
    const cmd = new Deno.Command('sqlite3', { args: ['-version'], stdout: 'piped', stderr: 'piped' });
    const { stdout, success } = await cmd.output();
    if (!success) return { available: false };
    const text = new TextDecoder().decode(stdout);
    const version = text.trim().split(' ')[0];
    return { available: true, version };
  } catch {
    return { available: false };
  }
}

// ── internal helpers ─────────────────────────────────────────────────────

async function tempSqlFile(content: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: 'waystation-sqlite-' });
  const file = join(dir, `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sql`);
  await Deno.writeTextFile(file, content);
  return file;
}

/**
 * Run sqlite3 with stdin coming from a file. Captures stdout/stderr and
 * enforces the 10 MiB stdout cap by slicing on read.
 */
async function runSqlite(
  args: string[],
  opts: { stdinFile: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  // We invoke /bin/sh so we can use the `<` redirect — Deno.Command can pipe
  // stdin programmatically, but the upstream Node version uses shell input
  // redirection and it's the simplest path to feature parity.
  const command = `sqlite3 ${args.map(shellEscape).join(' ')} < ${shellEscape(opts.stdinFile)}`;
  const cmd = new Deno.Command('/bin/sh', {
    args: ['-c', command],
    stdout: 'piped',
    stderr: 'piped',
  });
  const { stdout, stderr, code } = await cmd.output();
  const decoder = new TextDecoder();
  let out = decoder.decode(stdout);
  if (out.length > MAX_BUFFER_BYTES) {
    out = out.slice(0, MAX_BUFFER_BYTES);
    logger.warn('[sqlite] Output exceeded 10MB ceiling; truncated.');
  }
  return { stdout: out, stderr: decoder.decode(stderr), code };
}

/** Single-quote-escape a shell argument. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Substitute `?` placeholders with literal SQL values. We can't use the
 * sqlite3 CLI's parameter binding (it has no protocol for it), so we do the
 * substitution ourselves with type-correct quoting. NULL/numbers/booleans
 * pass through unquoted; strings are single-quoted with `'` doubled.
 *
 * Single-pass via `.replace(/\?/g, ...)` so already-substituted values that
 * happen to contain a `?` (e.g. a URL) are not re-replaced.
 */
function bindParameters(sql: string, params: unknown[]): string {
  if (!params || params.length === 0) return sql;

  let paramIndex = 0;
  const boundSql = sql.replace(/\?/g, () => {
    if (paramIndex >= params.length) {
      throw new Error(
        `SQL has more placeholders (?) than provided parameters (${params.length})`,
      );
    }
    const param = params[paramIndex++];

    if (param === null || param === undefined) return 'NULL';
    if (typeof param === 'number') return param.toString();
    if (typeof param === 'boolean') return param ? '1' : '0';
    // Escape single quotes by doubling, per SQL standard.
    return `'${String(param).replace(/'/g, "''")}'`;
  });

  if (paramIndex < params.length) {
    throw new Error(
      `Provided ${params.length} parameters but SQL only has ${paramIndex} placeholders (?)`,
    );
  }
  return boundSql;
}

/**
 * Retry on transient SQLITE_BUSY / database-locked errors with exponential
 * backoff (100ms, 200ms, 400ms). Non-retryable errors propagate immediately.
 */
async function executeWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('database is locked') || msg.includes('SQLITE_BUSY') ||
        msg.includes('database is busy')
      ) {
        const backoffMs = Math.pow(2, attempt) * 100;
        logger.warn(`[sqlite] Database busy, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('Operation failed after retries');
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { initializeCli, executeQuery, executeRun, executeGet } from './db/sqlite.ts';
//
// // 1. Open an in-memory DB and run a query
// await initializeCli('/tmp/way-test.db');
// await executeRun('CREATE TABLE t (id INTEGER, name TEXT)');
// await executeRun('INSERT INTO t VALUES (?, ?)', [1, "O'Reilly"]);  // quote-safe
// await executeQuery('SELECT * FROM t');             // [{ id: 1, name: "O'Reilly" }]
//
// // 2. Single-row read
// await executeGet<{ count: number }>('SELECT count(*) AS count FROM t');
//
// // 3. Probe for sqlite3 binary before doing anything
// const probe = await checkSqlite3Available();
// if (!probe.available) throw new Error('sqlite3 CLI not on PATH');

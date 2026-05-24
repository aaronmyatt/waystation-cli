// ──────────────────────────────────────────────────────────────────────────
// Pipeline: initialise the SQLite database at $HOME/.waystation/way.db.
//
// Ported from waystation-vscode/src/db-init.ts: initializeDatabase (line 42),
// createTimestampedBackup (143), cleanupOldBackups (167), the
// ensureLocalOnlyColumn / ensureSyncedAtColumn migrations (11, 25), and
// cleanupOrphanedFlowMatches (378). Each chunk becomes one Pipeline stage.
//
// Why a Pipeline here:
//   • The original procedure is genuinely linear with named "phases" — it's
//     a textbook fit for staged composition.
//   • Future hooks (e.g. emit telemetry, run extra migrations, plug in a
//     custom backup strategy) can `.pipe(...)` themselves in without
//     touching this file.
//   • Each stage is independently testable with a small input/output ctx.
//
// References:
//   • SQLite PRAGMA table_info: https://sqlite.org/pragma.html#pragma_table_info
//   • WAL backup considerations: https://sqlite.org/wal.html
// ──────────────────────────────────────────────────────────────────────────

import { dirname, fromFileUrl, join } from '@std/path';
import { ensureDir } from '@std/fs';
import { Pipeline } from '../vendor/pipeline.ts';
import {
  applySchemaFile,
  checkSqlite3Available,
  executeQuery,
  initializeCli,
  type Logger,
} from '../db/sqlite.ts';
import { runAsync } from '../db/helpers.ts';
import { SCHEMA_SQL } from '../schema.ts';

/** Maximum number of timestamped backups to retain on disk. */
const MAX_BACKUPS_TO_RETAIN = 10;

/**
 * Pipeline context. Inputs are at the top; later stages append fields rather
 * than mutating earlier ones, so a partial run is debuggable by inspecting
 * the returned context.
 */
export type InitCtx = {
  /** $HOME or equivalent. Caller passes Deno.env.get('HOME') in CLI mode. */
  homeDir?: string;
  /** Override for the storage directory. Defaults to `$homeDir/.waystation`. */
  storageDir?: string;
  /** Override for the database path. Defaults to `$storageDir/way.db`. */
  dbPath?: string;
  /** Absolute path to the schema.sql to apply on init. */
  schemaPath?: string;
  /** Optional logger; silent if omitted. */
  logger?: Logger;

  // ── populated by stages ──────────────────────────────────────────────
  backupPath?: string | null;
  sqliteVersion?: string;
};

// ── Stage: resolve filesystem paths ──────────────────────────────────────

async function resolvePaths(ctx: InitCtx): Promise<InitCtx> {
  const home = ctx.homeDir ?? Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE');
  if (!home && !ctx.dbPath) {
    throw new Error('Cannot resolve database path: $HOME is unset and no dbPath given.');
  }
  const storageDir = ctx.storageDir ?? (home ? join(home, '.waystation') : Deno.cwd());
  const dbPath = ctx.dbPath ?? join(storageDir, 'way.db');

  // Resolve the schema source. When a custom schemaPath is provided, use
  // that file. Otherwise default to the bundled SCHEMA_SQL string — this
  // ensures the package works both when schema.sql is on disk (local dev)
  // and when it isn't (JSR consumers, who get the bundled string from
  // src/schema.ts).
  const schemaPath = ctx.schemaPath ??
    join(dirname(dirname(fromFileUrl(import.meta.url))), '..', 'schema.sql');

  // Check if the default file path actually exists — if not, fall back to
  // the bundled string. This handles JSR installs where schema.sql is not
  // extracted to disk.
  const schemaOnDisk = await Deno.stat(schemaPath).then(() => true).catch(() => false);
  const schemaForCtx = schemaOnDisk ? schemaPath : SCHEMA_SQL;

  return { ...ctx, storageDir, dbPath, schemaPath: schemaForCtx };
}

async function ensureStorageDir(ctx: InitCtx): Promise<InitCtx> {
  if (!ctx.storageDir) throw new Error('ensureStorageDir: storageDir missing from ctx');
  await ensureDir(ctx.storageDir);
  return ctx;
}

// ── Stage: take a timestamped backup of the existing DB (if any) ─────────

async function createTimestampedBackup(ctx: InitCtx): Promise<InitCtx> {
  const dbPath = ctx.dbPath!;
  try {
    await Deno.stat(dbPath);
  } catch {
    // Fresh install — nothing to back up.
    return { ...ctx, backupPath: null };
  }
  // Keep the suffix format compatible with the upstream cleanup regex.
  const backupPath = dbPath.replace(/\.db$/, `-backup-${Date.now()}.db`);
  await Deno.copyFile(dbPath, backupPath);
  ctx.logger?.log(`[init] Backup created: ${backupPath}`);
  return { ...ctx, backupPath };
}

async function cleanupOldBackups(ctx: InitCtx): Promise<InitCtx> {
  const storageDir = ctx.storageDir!;
  // Match the upstream pattern: `way-backup-<ts>.db`. We tolerate any prefix
  // before "-backup-" so renamed databases don't break cleanup.
  const backupPattern = /-backup-(\d+)\.db$/;
  try {
    const entries: Array<{ name: string; ts: number; path: string }> = [];
    for await (const entry of Deno.readDir(storageDir)) {
      const m = entry.name.match(backupPattern);
      if (m) {
        entries.push({
          name: entry.name,
          ts: parseInt(m[1], 10),
          path: join(storageDir, entry.name),
        });
      }
    }
    entries.sort((a, b) => b.ts - a.ts); // newest first
    const toDelete = entries.slice(MAX_BACKUPS_TO_RETAIN);
    for (const b of toDelete) {
      try {
        await Deno.remove(b.path);
        ctx.logger?.log(`[init] Deleted old backup: ${b.name}`);
      } catch (err) {
        ctx.logger?.warn(`[init] Failed to delete backup ${b.name}: ${err}`);
      }
    }
  } catch (err) {
    // Don't let backup cleanup failures block startup.
    ctx.logger?.warn(`[init] Backup cleanup skipped: ${err}`);
  }
  return ctx;
}

// ── Stage: verify the sqlite3 CLI is installed ───────────────────────────

async function ensureSqlite3Available(ctx: InitCtx): Promise<InitCtx> {
  const probe = await checkSqlite3Available();
  if (!probe.available) {
    // The upstream extension shows a VS Code modal here. The CLI just
    // throws — `bin/way` prints a platform-specific install hint from the
    // catch block in cli.ts.
    throw new Error(
      `sqlite3 CLI not found on PATH. Install it (macOS: \`brew install sqlite\`, ` +
        `Ubuntu/Debian: \`sudo apt install sqlite3\`, Fedora: \`sudo dnf install sqlite\`, ` +
        `Arch: \`sudo pacman -S sqlite\`, Windows: https://sqlite.org/download.html) and re-run.`,
    );
  }
  return { ...ctx, sqliteVersion: probe.version };
}

// ── Stage: open driver + apply schema ────────────────────────────────────

async function openAndApplySchema(ctx: InitCtx): Promise<InitCtx> {
  await initializeCli(ctx.dbPath!, ctx.logger);
  await applySchemaFile(ctx.schemaPath!);
  return ctx;
}

// ── Stage: idempotent column-level migrations ────────────────────────────

async function ensureLocalOnlyColumn(ctx: InitCtx): Promise<InitCtx> {
  // pragma_table_info is the supported way to introspect columns without
  // pulling the full schema:
  //   https://sqlite.org/pragma.html#pragma_table_info
  const rows = await executeQuery<{ count: number }>(
    "SELECT COUNT(*) AS count FROM pragma_table_info('flows') WHERE name='local_only'",
  );
  if (rows[0]?.count === 0) {
    ctx.logger?.log('[init] Adding local_only column to flows');
    await runAsync('ALTER TABLE flows ADD COLUMN local_only BOOLEAN DEFAULT FALSE');
  }
  return ctx;
}

async function ensureSyncedAtColumn(ctx: InitCtx): Promise<InitCtx> {
  const rows = await executeQuery<{ count: number }>(
    "SELECT COUNT(*) AS count FROM pragma_table_info('flows') WHERE name='synced_at'",
  );
  if (rows[0]?.count === 0) {
    ctx.logger?.log('[init] Adding synced_at column to flows');
    await runAsync('ALTER TABLE flows ADD COLUMN synced_at DATETIME');
  }
  return ctx;
}

// ── Stage: drop orphaned flow_matches ────────────────────────────────────

/**
 * Removes flow_matches whose `matches_id` no longer references any row in
 * `matches`. The upstream comment explains the origin of these orphans:
 *
 *   "When Client A and Client B both create a match for the same
 *    (line, file_path, git_commit_sha): both create local matches rows with
 *    different IDs, both create flow_matches referencing their local match
 *    IDs, and during sync the idx_unique_match_location constraint causes
 *    one match to be rejected — leaving the losing client's flow_matches
 *    referencing a non-existent match ID."
 *
 * Content-based IDs (sha256 of line|file_path|sha) mitigate the cause, but
 * existing databases may still have orphans.
 */
async function cleanupOrphanedFlowMatches(ctx: InitCtx): Promise<InitCtx> {
  await runAsync(`
    DELETE FROM flow_matches
    WHERE matches_id IS NOT NULL
      AND matches_id NOT IN (SELECT id FROM matches)
  `);
  return ctx;
}

/**
 * The full database-initialisation pipeline. Stages run in order; each
 * receives and returns the running `InitCtx`. Add new migrations by
 * `.pipe(yourStage)` either at construction time or at the call site.
 */
export const initDatabase: Pipeline<InitCtx> = new Pipeline<InitCtx>()
  .pipe(resolvePaths)
  .pipe(ensureStorageDir)
  .pipe(createTimestampedBackup)
  .pipe(cleanupOldBackups)
  .pipe(ensureSqlite3Available)
  .pipe(openAndApplySchema)
  .pipe(ensureLocalOnlyColumn)
  .pipe(ensureSyncedAtColumn)
  .pipe(cleanupOrphanedFlowMatches);

// ── REPL examples ────────────────────────────────────────────────────────
// import { initDatabase } from './pipelines/initDatabase.ts';
//
// // 1. Init at the default location ($HOME/.waystation/way.db)
// const ctx1 = await initDatabase.process({ homeDir: Deno.env.get('HOME') });
//
// // 2. Init at a custom path (e.g. for tests)
// const ctx2 = await initDatabase.process({ dbPath: '/tmp/way-test.db' });
//
// // 3. Add a custom post-init stage on the fly
// import { Pipeline } from '../vendor/pipeline.ts';
// const extended = new Pipeline([...initDatabase.stages,
//   async (c) => { console.log('init done at', c.dbPath); return c; }
// ]);
// await extended.process({ dbPath: '/tmp/way-test.db' });

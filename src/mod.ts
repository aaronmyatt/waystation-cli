// ──────────────────────────────────────────────────────────────────────────
// @atm/waystation-cli — public library entry point.
//
// Re-exports the surface that downstream consumers (the VS Code extension,
// the future agentic-session runner, etc.) are intended to use. Anything
// not re-exported here is considered internal and may change without notice.
// ──────────────────────────────────────────────────────────────────────────

// ── Vendored building blocks (the "two load-bearing primitives") ─────────
export { Pipeline } from './vendor/pipeline.ts';
export type { Input, Stage } from './vendor/pipeline.ts';
export * as jp from './vendor/jsonpointer.ts';
export { P } from './pointers.ts';

// ── Domain types ─────────────────────────────────────────────────────────
export type {
  Flow,
  FlowAggregate,
  FlowListItem,
  FlowMatch,
  FlowMatchState,
  GitInfo,
  Match,
  MatchNote,
  StepContent,
} from './types.ts';

// ── DB driver + helpers ──────────────────────────────────────────────────
export {
  applySchemaFile,
  checkpoint,
  checkSqlite3Available,
  executeBatch,
  executeGet,
  executeQuery,
  executeRun,
  executeTransaction,
  getDatabasePath,
  initializeCli,
} from './db/sqlite.ts';
export type { Logger } from './db/sqlite.ts';
export { getAsync, queryAsync, runAsync, upsertAsync } from './db/helpers.ts';

// ── Flow primitives ──────────────────────────────────────────────────────
export {
  archiveFlow,
  getFlow,
  getFlows,
  getFlowsWithCounts,
  insertChildFlow,
  insertFlow,
  resolveFlowId,
} from './flows/crud.ts';
export { getGitInfo, parseGitHubRepo } from './flows/git.ts';
export { addFrontmatter, generateFlowMarkdown, type RenderOptions } from './flows/markdown.ts';

// ── Pipelines ────────────────────────────────────────────────────────────
export { initDatabase } from './pipelines/initDatabase.ts';
export type { InitCtx } from './pipelines/initDatabase.ts';
export { saveMatch } from './pipelines/saveMatch.ts';
export type { SaveMatchCtx } from './pipelines/saveMatch.ts';
export { buildFlowAggregate } from './pipelines/buildFlowAggregate.ts';
export type { AggCtx } from './pipelines/buildFlowAggregate.ts';
export { exportMarkdown } from './pipelines/exportMarkdown.ts';
export type { ExportCtx } from './pipelines/exportMarkdown.ts';
export { pullTableRecords, pushTableRecords } from './pipelines/sync.ts';
export type { PullCtx, PushCtx } from './pipelines/sync.ts';

// ── Schema accessor ──────────────────────────────────────────────────────
import { SCHEMA_SQL } from './schema.ts';

/**
 * The canonical SQL DDL as a string, bundled so it works in JSR and Deno
 * environments where filesystem access to `schema.sql` may not be available.
 * Use with {@linkcode applySchemaFile} or read directly when bootstrapping
 * a custom DB lifecycle (e.g. an in-memory test harness).
 *
 * @example
 *   import { schemaSql, applySchemaFile, initializeCli } from '@atm/waystation-cli';
 *   await initializeCli('/tmp/test.db');
 *   await applySchemaFile(schemaSql);
 */
export const schemaSql: string = SCHEMA_SQL;

// Re-export the raw SCHEMA_SQL constant directly too, in case consumers
// imported from the sub-export `@atm/waystation-cli/schema`.
export { SCHEMA_SQL } from './schema.ts';

// ── REPL examples ────────────────────────────────────────────────────────
// import {
//   Pipeline, jp, P,
//   initDatabase, buildFlowAggregate, exportMarkdown,
//   insertFlow,
// } from '@atm/waystation-cli';
//
// // 1. Bootstrap + create + render
// await initDatabase.process({ dbPath: '/tmp/way.db' });
// const id = await insertFlow({ name: 'Demo' });
// const { aggregate } = await buildFlowAggregate.process({ flowId: id });
// jp.get(aggregate, P.flowName);                // 'Demo'
//
// // 2. Compose a custom pipeline of your own using the vendored Pipeline
// const pl = new Pipeline<{ n: number }>().pipe((c) => ({ ...c, n: c.n + 1 }));
// await pl.process({ n: 1 });                   // { n: 2 }

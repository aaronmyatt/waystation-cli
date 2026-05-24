// ──────────────────────────────────────────────────────────────────────────
// Pipeline: push/pull stubs for backend sync.
//
// Phase 1 deliberately ships *no* HTTP wiring — but it does ship the
// pipeline shape and the context types so the extension's existing
// pushCommand / pullCommand modules can be ported to slot their axios calls
// into a stage without rearranging the surrounding logic.
//
// See waystation-vscode/src/commands/pushCommand.ts and pullCommand.ts for
// the upstream algorithm:
//   • Push: POST /tables/{table_name}/batch with JSON records, paginated by
//     `updated_at > last_push`.
//   • Pull: GET /tables/{table_name}?updated_at_gt={timestamp} with cursor.
//
// Both rely on a configurable `apiUrl` and an API key from extension state.
// When this file is implemented in a follow-up, those become explicit
// fields on the contexts below.
// ──────────────────────────────────────────────────────────────────────────

import { Pipeline } from '../vendor/pipeline.ts';

export type PushCtx = {
  apiUrl: string;
  apiKey: string;
  /** Tables to push, in dependency order (flows → matches → flow_matches…). */
  tables: string[];
  /** Page size for batched POSTs. */
  pageSize?: number;
  // ── populated as stages run ──────────────────────────────────────────
  pushedCount?: number;
};

export type PullCtx = {
  apiUrl: string;
  apiKey: string;
  tables: string[];
  pageSize?: number;
  pulledCount?: number;
};

async function notImplemented<T extends Record<string, unknown>>(_ctx: T): Promise<T> {
  throw new Error(
    'sync pipelines are not implemented in this release — see plan §"Phase 1 out of scope".',
  );
}

export const pushTableRecords: Pipeline<PushCtx> = new Pipeline<PushCtx>()
  .pipe(notImplemented);

export const pullTableRecords: Pipeline<PullCtx> = new Pipeline<PullCtx>()
  .pipe(notImplemented);

// ── REPL examples ────────────────────────────────────────────────────────
// // 1. Not yet implemented — both forms throw a clear error.
// // await pushTableRecords.process({ apiUrl: '', apiKey: '', tables: [] });
// // await pullTableRecords.process({ apiUrl: '', apiKey: '', tables: [] });
//
// // 2. Inspect stage list for follow-up work
// import { pushTableRecords } from './pipelines/sync.ts';
// pushTableRecords.stages.length;   // 1 (the not-implemented guard)

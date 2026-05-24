// ──────────────────────────────────────────────────────────────────────────
// Pipeline: load a flow + its ordered steps into a single FlowAggregate.
//
// The canonical SELECT lives at
//   waystation-vscode/src/state/flowMatchStateManager.ts:36-76
// We keep the same query shape — `json_object(...)` nested blobs per row —
// because that's exactly what the extension's webview & the markdown
// renderer already consume. Stages here just orchestrate the loads and
// build the in-memory object via JSON pointers.
//
// References:
//   • SQLite json_object():  https://sqlite.org/json1.html#jobj
//   • SQLite LEFT JOIN:      https://sqlite.org/lang_select.html#join
// ──────────────────────────────────────────────────────────────────────────

import { Pipeline } from '../vendor/pipeline.ts';
import * as jp from '../vendor/jsonpointer.ts';
import { P } from '../pointers.ts';
import type { Flow, FlowAggregate, FlowMatchState } from '../types.ts';
import { getAsync, queryAsync } from '../db/helpers.ts';

export type AggCtx = {
  /** The flow to load. */
  flowId: string;
  // ── populated by stages ──────────────────────────────────────────────
  flow?: Flow;
  rawMatches?: AggregateRow[];
  aggregate?: FlowAggregate;
};

/**
 * Raw row shape returned by the aggregate SELECT. The `match` and
 * `step_content` columns arrive as JSON-encoded strings — they must be
 * `JSON.parse`d before they're useful.
 */
type AggregateRow = {
  flow_match_id: string;
  flows_id: string;
  matches_id: string | null;
  order_index: number;
  content_kind: 'match' | 'note' | 'image' | 'html' | 'link';
  content_id: string;
  flow_match_updated_at: string;
  match: string | null;
  step_content: string | null;
};

async function loadFlowRow(ctx: AggCtx): Promise<AggCtx> {
  const flow = await getAsync<Flow>(
    'SELECT * FROM flows WHERE id = ? AND archived = 0',
    [ctx.flowId],
  );
  if (!flow) throw new Error(`Flow not found: ${ctx.flowId}`);
  return { ...ctx, flow };
}

async function loadFlowMatchesOrdered(ctx: AggCtx): Promise<AggCtx> {
  // This is *the* canonical aggregate query. Keep it byte-for-byte aligned
  // with the upstream extension's version so any future webview consuming
  // the JSON shape doesn't have to special-case CLI output.
  const rows = await queryAsync<AggregateRow>(
    `SELECT
       fm.id AS flow_match_id,
       fm.flows_id,
       fm.matches_id,
       fm.order_index,
       fm.content_kind,
       fm.content_id,
       fm.updated_at AS flow_match_updated_at,

       -- Nest the joined match data so the client sees one row per step.
       CASE WHEN m.id IS NOT NULL THEN
         json_object(
           'id', m.id,
           'line', m.line,
           'file_path', m.file_path,
           'repo_relative_file_path', m.repo_relative_file_path,
           'file_name', m.file_name,
           'line_no', m.line_no,
           'grep_meta', m.grep_meta,
           'git_repo_root', m.git_repo_root,
           'git_commit_sha', m.git_commit_sha,
           'git_branch', m.git_branch
         )
       END AS match,

       CASE WHEN sc.id IS NOT NULL THEN
         json_object(
           'id', sc.id,
           'title', sc.title,
           'body', sc.body,
           'file_path', sc.file_path
         )
       END AS step_content

     FROM flow_matches fm
     LEFT JOIN matches m ON m.id = fm.matches_id
     LEFT JOIN step_contents sc ON sc.id = fm.content_id
     WHERE fm.flows_id = ? AND fm.archived = 0
     ORDER BY fm.order_index ASC`,
    [ctx.flowId],
  );
  return { ...ctx, rawMatches: rows };
}

/**
 * Final stage: assemble the FlowAggregate. Built entirely through JSON
 * pointers to demonstrate (and validate at runtime) the indirection layer
 * defined in src/pointers.ts. Functionally equivalent to direct property
 * assignment — the pointer detour is intentional, not accidental.
 */
async function assembleAggregate(ctx: AggCtx): Promise<AggCtx> {
  // Seed with an empty aggregate skeleton, then jp.set our way through it.
  const aggregate: FlowAggregate = { flow: { name: '' }, matches: [] };

  // Copy every key from the flow row through jp.set. Most fields are
  // scalars — a single set per key keeps the read/write path uniform and
  // means a new column shows up automatically without touching this code.
  for (const [k, v] of Object.entries(ctx.flow!)) {
    jp.set(aggregate, `/flow/${k}`, v);
  }

  // For each raw row: parse the nested JSON blobs, then jp.set the whole
  // flattened FlowMatchState at /matches/-. The "-" token appends, so we
  // build the array up incrementally in display order.
  for (const row of ctx.rawMatches ?? []) {
    const match = row.match ? JSON.parse(row.match) : undefined;
    const step_content = row.step_content ? JSON.parse(row.step_content) : undefined;
    const state: FlowMatchState = {
      flow_match_id: row.flow_match_id,
      flows_id: row.flows_id,
      matches_id: row.matches_id ?? undefined,
      order_index: row.order_index,
      content_kind: row.content_kind,
      content_id: row.content_id,
      updated_at: row.flow_match_updated_at,
      match,
      step_content,
    };
    jp.set(aggregate, P.appendMatch, state);
  }

  return { ...ctx, aggregate };
}

/** The complete aggregate-loading pipeline. */
export const buildFlowAggregate: Pipeline<AggCtx> = new Pipeline<AggCtx>()
  .pipe(loadFlowRow)
  .pipe(loadFlowMatchesOrdered)
  .pipe(assembleAggregate);

// ── REPL examples ────────────────────────────────────────────────────────
// import { buildFlowAggregate } from './pipelines/buildFlowAggregate.ts';
// import * as jp from '../vendor/jsonpointer.ts';
// import { P } from '../pointers.ts';
//
// // 1. Load
// const { aggregate } = await buildFlowAggregate.process({ flowId: 'f1' });
//
// // 2. Read a field through a pointer
// jp.get(aggregate, P.flowName);
//
// // 3. Inspect the third step's note body
// jp.get(aggregate, P.stepBody(2));

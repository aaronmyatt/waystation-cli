// ──────────────────────────────────────────────────────────────────────────
// Domain types for the waystation data model.
//
// These types are the source of truth for the in-memory shape that flows
// through pipeline contexts and gets serialised into markdown frontmatter.
// The shape mirrors the SQLite tables defined in `../schema.sql`.
//
// Ported from waystation-vscode/src/global-types.d.ts (which used `declare
// global`) into ordinary exported types so the package is usable from both
// Deno and Node without polluting the global type namespace.
// ──────────────────────────────────────────────────────────────────────────

/**
 * A single named waystation — a journey or task captured as an ordered list
 * of `FlowMatch` entries. Mirrors the `flows` table in schema.sql.
 */
export type Flow = {
  id?: string;
  name: string;
  description?: string;
  git_repo_root?: string;
  git_commit_sha?: string;
  git_branch?: string;
  parent_flow_id?: string;
  parent_flow_match_id?: string;
  created_at?: string;
  updated_at?: string;
  archived?: boolean;
  /** When true, this flow is never synced to the backend (workspace-local). */
  local_only?: boolean;
  synced_at?: string;
};

/**
 * A code location — a single line in a file at a specific commit. The
 * `(line, file_path, git_commit_sha)` triple is enforced unique by the
 * `idx_unique_match_location` index in schema.sql.
 */
export type Match = {
  id?: string;
  line: string;
  file_path: string;
  repo_relative_file_path?: string;
  file_name: string;
  line_no: number;
  /** JSON-stringified grep context (lines around the match). */
  grep_meta?: string;
  git_repo_root?: string;
  git_commit_sha?: string;
  git_branch?: string;
  created_at?: string;
  updated_at?: string;
  archived?: boolean;
};

/**
 * Join row linking a flow to one ordered piece of content — either a `Match`
 * (code reference) or a `StepContent` (note/image/html/link).
 *
 * `content_kind` discriminates which table `content_id` points at.
 */
export type FlowMatch = {
  id?: string;
  flows_id: string;
  matches_id?: string;
  content_kind: 'match' | 'note' | 'image' | 'html' | 'link';
  content_id: string;
  order_index: number;
  archived?: boolean;
  created_at?: string;
  updated_at?: string;
};

/**
 * Rich content attached to a flow step — freeform notes, screenshots, links,
 * or rendered HTML. Mirrors the `step_contents` table.
 */
export type StepContent = {
  id?: string;
  kind: 'match' | 'note' | 'image' | 'html' | 'link';
  title?: string;
  body?: string;
  file_path?: string;
  blob_data?: Uint8Array;
  mime_type?: string;
  original_name?: string;
  meta_json?: string;
  created_at?: string;
  updated_at?: string;
};

/**
 * Legacy match-note row. Kept for sync compatibility — schema.sql no longer
 * provisions a dedicated table; notes now live in `step_contents`.
 */
export type MatchNote = {
  id?: string;
  flow_match_id: string;
  name?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
};

/**
 * One step in a flow as returned by the aggregate loader — a `FlowMatch` row
 * augmented with the joined-in match/note/step_content payloads.
 *
 * The aggregate loader unpacks the SQL `json_object(...)` blobs into these
 * nested fields. See ../pipelines/buildFlowAggregate.ts and the canonical
 * query at waystation-vscode/src/state/flowMatchStateManager.ts:36-76.
 */
export interface FlowMatchState extends FlowMatch {
  flow_match_id?: string;
  match?: Match;
  note?: MatchNote;
  step_content?: StepContent;
}

/**
 * Full in-memory shape of a flow plus its ordered steps. This is the object
 * that pipelines read/write via JSON pointers and that ships into markdown
 * frontmatter as a JSON blob.
 */
export interface FlowAggregate {
  flow: Flow;
  matches: FlowMatchState[];
}

/** Flow + a denormalised `matchCount` for list views. */
export interface FlowListItem extends Flow {
  matchCount: number;
}

/** Result of inspecting the current git repo around a file. */
export type GitInfo = {
  repoRoot?: string;
  commitSha?: string;
  branch?: string;
  remoteUrl?: string;
  repoRelativePath?: string;
};

// ── REPL examples ────────────────────────────────────────────────────────
// import type { Flow, FlowAggregate } from './types.ts';
//
// // 1. Construct a minimal flow
// const flow: Flow = { name: 'My first waystation' };
//
// // 2. Empty aggregate (what buildFlowAggregate seeds before stages run)
// const agg: FlowAggregate = { flow: { name: '' }, matches: [] };
//
// // 3. A step with rich note content
// agg.matches.push({
//   flows_id: 'f1',
//   content_kind: 'note',
//   content_id: 'sc1',
//   order_index: 0,
//   step_content: { kind: 'note', title: 'Hello', body: 'World' },
// });

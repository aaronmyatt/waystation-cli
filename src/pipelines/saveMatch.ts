// ──────────────────────────────────────────────────────────────────────────
// Pipeline: persist a new `Match` to the DB and attach it to a flow.
//
// Ported from waystation-vscode/src/db/matchUtils.ts:
//   • generateMatchId  (line 56)  — sha256 of (line | file_path | commit).
//   • saveMatchToDatabase (61)    — enrich + insert + addToFlow.
//   • addToFlow (90)              — append a flow_match (auto-create the
//                                   parent flow if none was supplied).
//
// Split into discrete stages so callers can compose: e.g. a future
// "import-from-other-DB" pipeline can reuse `insertMatchRow` without the
// git-info enrichment.
// ──────────────────────────────────────────────────────────────────────────

import { dirname } from '@std/path';
import { encodeHex } from '@std/encoding/hex';
import { Pipeline } from '../vendor/pipeline.ts';
import type { Match } from '../types.ts';
import { getAsync, runAsync } from '../db/helpers.ts';
import { getGitInfo, parseGitHubRepo } from '../flows/git.ts';
import { insertFlow } from '../flows/crud.ts';

export type SaveMatchCtx = {
  /** The match to persist. Stages enrich this in-place. */
  match: Match;
  /** Optional target flow id. If omitted, a new flow is auto-created. */
  flowId?: string;
  /** Override the default local_only behaviour when auto-creating a flow. */
  defaultLocalOnly?: boolean;
  /** Optional short heading for this step (stored in step_contents). */
  stepTitle?: string;
  /** Optional description/body for this step (stored in step_contents). */
  stepDesc?: string;

  // ── populated by stages ──────────────────────────────────────────────
  resultMatchId?: string;
  flowMatchId?: string;
  /** Set when stepTitle/stepDesc are provided — points at the step_contents row. */
  stepContentId?: string;
};

/**
 * Stage: fill in git_repo_root / commit_sha / branch / repo_relative_file_path
 * from the on-disk git state surrounding `match.file_path`. Mirrors
 * matchUtils.ts:65-69.
 */
async function enrichWithGitInfo(ctx: SaveMatchCtx): Promise<SaveMatchCtx> {
  const gitInfo = await getGitInfo(dirname(ctx.match.file_path), ctx.match.file_path);
  ctx.match.git_repo_root = parseGitHubRepo(gitInfo.remoteUrl) || gitInfo.repoRoot;
  ctx.match.git_commit_sha = gitInfo.commitSha;
  ctx.match.git_branch = gitInfo.branch;
  // schema.sql declares matches.repo_relative_file_path as NOT NULL, so we
  // fall back to the bare file_path when the file isn't inside a git repo.
  // The semantic loss is acceptable — "relative path inside repo" degrades
  // to "the path as given" — and it keeps INSERT OR IGNORE from silently
  // swallowing constraint failures.
  ctx.match.repo_relative_file_path = gitInfo.repoRelativePath ?? ctx.match.file_path;
  return ctx;
}

/**
 * Stage: compute a stable, content-derived id for the match. The same
 * (line, file_path, commit) triple always produces the same id, which lets
 * `INSERT OR IGNORE` de-duplicate naturally on the unique index defined in
 * schema.sql (`idx_unique_match_location`).
 *
 * Algorithm: sha256(line|file_path|commit_sha), truncated to 32 hex chars.
 * (32 hex = 128 bits — overkill collision resistance for the domain, but
 * keeps ids the same length as random UUIDs minus dashes.)
 */
async function generateContentBasedId(ctx: SaveMatchCtx): Promise<SaveMatchCtx> {
  const content = `${ctx.match.line}|${ctx.match.file_path}|${
    ctx.match.git_commit_sha || 'unknown'
  }`;
  // Web Crypto digest — available in Deno and Node ≥19.
  // https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  ctx.match.id = encodeHex(new Uint8Array(buf)).slice(0, 32);
  return ctx;
}

/**
 * Stage: insert (or refresh) the match row.
 *
 * The match `id` is content-derived (sha256 of `line | file_path | sha`), so
 * the *same* captured triple always produces the same row. We want that:
 * cross-client collisions on the unique-location index in schema.sql:44 are
 * naturally a no-op.
 *
 * BUT — when the user re-runs `way add` against a line they captured
 * earlier (possibly before a fix that populates `grep_meta`), we still
 * want the *latest* metadata to win. INSERT OR IGNORE would silently
 * keep the stale row (and leave `grep_meta` NULL, so `way show` renders
 * the step heading with nothing under it).
 *
 * Solution: ON CONFLICT(id) DO UPDATE the mutable fields. We only refresh
 * fields that can legitimately change between captures of the same logical
 * location:
 *   • grep_meta              — capture context can shrink/grow
 *   • line_no                — the line could move within the file
 *   • repo_relative_file_path / file_name — git context might be richer
 *   • updated_at             — bump so sync sees the change
 *
 * Immutable across captures (and therefore not touched):
 *   • id, line, file_path, git_repo_root, git_commit_sha, git_branch
 */
async function insertMatchRow(ctx: SaveMatchCtx): Promise<SaveMatchCtx> {
  const m = ctx.match;
  await runAsync(
    `INSERT INTO matches
     (id, line, file_path, repo_relative_file_path, file_name, line_no,
      grep_meta, git_repo_root, git_commit_sha, git_branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       grep_meta = excluded.grep_meta,
       line_no = excluded.line_no,
       repo_relative_file_path = excluded.repo_relative_file_path,
       file_name = excluded.file_name,
       updated_at = CURRENT_TIMESTAMP`,
    [
      m.id,
      m.line,
      m.file_path,
      m.repo_relative_file_path ?? null,
      m.file_name,
      m.line_no,
      m.grep_meta ?? null,
      m.git_repo_root ?? null,
      m.git_commit_sha ?? null,
      m.git_branch ?? null,
    ],
  );
  ctx.resultMatchId = m.id;
  return ctx;
}

/**
 * Stage: when no `flowId` was provided, create a default "New Flow <ts>"
 * with whatever git context the match has. Mirrors matchUtils.ts:99-106
 * minus the workspace-configuration lookup.
 */
async function ensureContainingFlow(ctx: SaveMatchCtx): Promise<SaveMatchCtx> {
  if (ctx.flowId) return ctx;
  ctx.flowId = await insertFlow({
    name: `New Flow ${new Date().toISOString()}`,
    description: 'Auto-created flow for match',
    git_repo_root: ctx.match.git_repo_root,
    git_commit_sha: ctx.match.git_commit_sha,
    git_branch: ctx.match.git_branch,
    local_only: ctx.defaultLocalOnly ?? false,
  });
  return ctx;
}

/**
 * Stage: if stepTitle or stepDesc was provided, create a `step_contents`
 * row with those values. The aggregate loader (`buildFlowAggregate.ts`)
 * LEFT JOINs `step_contents` via `flow_matches.content_id`, so this row
 * is automatically picked up by `way show` / `way export`.
 *
 * When this stage populates `ctx.stepContentId`, the subsequent
 * `insertFlowMatchLink` stage uses it to wire `content_kind` and
 * `content_id` to the note content instead of the match — the match
 * is referenced separately via `matches_id`.
 */
async function insertStepContentRow(ctx: SaveMatchCtx): Promise<SaveMatchCtx> {
  if (!ctx.stepTitle && !ctx.stepDesc) return ctx;

  const id = crypto.randomUUID();
  await runAsync(
    `INSERT INTO step_contents (id, kind, title, body, created_at, updated_at)
     VALUES (?, 'note', ?, ?, datetime('now'), datetime('now'))`,
    [id, ctx.stepTitle ?? null, ctx.stepDesc ?? null],
  );
  ctx.stepContentId = id;
  return ctx;
}

/**
 * Stage: append the match to the end of its flow. The `order_index` becomes
 * the current count of non-archived flow_matches in that flow.
 *
 * When a `stepContentId` is set (because the caller provided title/desc),
 * we set `content_kind = 'note'` and `content_id = stepContentId` so the
 * aggregate query's LEFT JOIN on `step_contents` picks up the title/body.
 * The `matches_id` still points at the code match — both joins are
 * independent, so the rendered step shows both the code snippet AND the
 * descriptive heading.
 */
async function insertFlowMatchLink(ctx: SaveMatchCtx): Promise<SaveMatchCtx> {
  const row = await getAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM flow_matches WHERE flows_id = ? AND archived = 0',
    [ctx.flowId!],
  );
  const orderIndex = row?.count ?? 0;
  const flowMatchId = crypto.randomUUID();

  // When step content exists, the content_kind/content_id pair points at
  // the note (so the aggregate join finds the title/body), and matches_id
  // still points at the code match. Otherwise both columns reference the
  // match id (original behaviour preserved).
  const contentKind = ctx.stepContentId ? 'note' : 'match';
  const contentId = ctx.stepContentId ?? ctx.resultMatchId!;

  await runAsync(
    `INSERT INTO flow_matches
     (id, flows_id, matches_id, order_index, content_kind, content_id, archived)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [flowMatchId, ctx.flowId!, ctx.resultMatchId!, orderIndex, contentKind, contentId],
  );
  ctx.flowMatchId = flowMatchId;
  return ctx;
}

/** The fully assembled save-match pipeline. */
export const saveMatch: Pipeline<SaveMatchCtx> = new Pipeline<SaveMatchCtx>()
  .pipe(enrichWithGitInfo)
  .pipe(generateContentBasedId)
  .pipe(insertMatchRow)
  .pipe(insertStepContentRow)
  .pipe(ensureContainingFlow)
  .pipe(insertFlowMatchLink);

// ── REPL examples ────────────────────────────────────────────────────────
// import { initDatabase } from './pipelines/initDatabase.ts';
// import { saveMatch } from './pipelines/saveMatch.ts';
//
// await initDatabase.process({ dbPath: '/tmp/way-test.db' });
//
// // 1. Save a match into a fresh, auto-created flow
// const r1 = await saveMatch.process({
//   match: { line: 'console.log("hi")', file_path: '/path/to/index.ts',
//            file_name: 'index.ts', line_no: 12 },
// });
// // r1.flowId, r1.resultMatchId, r1.flowMatchId all populated.
//
// // 2. Append a second match to that same flow
// await saveMatch.process({
//   match: { line: 'const x = 1', file_path: '/path/to/index.ts',
//            file_name: 'index.ts', line_no: 5 },
//   flowId: r1.flowId,
// });
//
// // 3. Save a match while opting all auto-created flows into local-only mode
// await saveMatch.process({
//   match: { line: '...', file_path: '/x.ts', file_name: 'x.ts', line_no: 1 },
//   defaultLocalOnly: true,
// });

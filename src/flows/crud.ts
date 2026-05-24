// ──────────────────────────────────────────────────────────────────────────
// Plain CRUD over the `flows` table.
//
// Ported from waystation-vscode/src/db/matchUtils.ts: getFlow (line 23),
// getFlows (line 28), insertFlow (line 323), insertChildFlow (line 357),
// archiveFlow (line 318). Drops the workspace-configuration coupling — the
// caller now passes `localOnly` explicitly.
// ──────────────────────────────────────────────────────────────────────────

import type { Flow, FlowListItem } from '../types.ts';
import { getAsync, queryAsync, runAsync } from '../db/helpers.ts';

/** Random RFC-4122 v4 UUID. Web Crypto is available in Deno and Node ≥19. */
function uuid(): string {
  return crypto.randomUUID();
}

/** Fetch a single non-archived flow by id. */
export async function getFlow(id: string): Promise<Flow | undefined> {
  return await getAsync<Flow>(
    'SELECT * FROM flows WHERE id = ? AND archived = 0',
    [id],
  );
}

/** Fetch all non-archived flows, newest-updated first. */
export async function getFlows(): Promise<Flow[]> {
  return await queryAsync<Flow>(
    'SELECT * FROM flows WHERE archived = 0 ORDER BY updated_at DESC',
  );
}

/**
 * Fetch all non-archived flows with a `matchCount` denormalised in. Used by
 * `way list`. Mirrors the LEFT-JOIN query at
 * waystation-vscode/src/state/flowListStateManager.ts:55-65.
 */
export async function getFlowsWithCounts(): Promise<FlowListItem[]> {
  return await queryAsync<FlowListItem>(`
    SELECT f.*, COUNT(fm.id) AS matchCount
    FROM flows f
    LEFT JOIN flow_matches fm ON f.id = fm.flows_id AND fm.archived = 0
    WHERE f.archived = 0
    GROUP BY f.id
    ORDER BY f.updated_at DESC
  `);
}

/** Soft-archive a flow (sets archived = 1; keeps the row). */
export async function archiveFlow(id: string): Promise<void> {
  await runAsync('UPDATE flows SET archived = 1 WHERE id = ?', [id]);
}

/**
 * Rename a flow. Throws if the id doesn't exist or is archived.
 * Returns the updated_at timestamp so callers can display confirmation.
 */
export async function renameFlow(id: string, name: string): Promise<void> {
  // Verify the flow exists and is not archived.
  // We use a SELECT first so we can give a clear error message — the
  // UPDATE itself would silently affect zero rows and leave the user
  // wondering why nothing changed.
  const flow = await getAsync<Flow>(
    'SELECT id FROM flows WHERE id = ? AND archived = 0',
    [id],
  );
  if (!flow) throw new Error(`Flow not found: ${id}`);

  await runAsync(
    `UPDATE flows SET name = ?, updated_at = datetime('now') WHERE id = ?`,
    [name, id],
  );
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { renameFlow } from './flows/crud.ts';
//
// // 1. Rename an existing flow
// await renameFlow('some-uuid', 'A better title');

/**
 * Insert a new flow. Returns the generated UUID.
 *
 * @param name         Required display name.
 * @param description  Free text, may be empty.
 * @param gitContext   Optional git_repo_root / sha / branch to stamp.
 * @param localOnly    When true, never sync this flow to the backend.
 */
export async function insertFlow(opts: {
  name: string;
  description?: string;
  git_repo_root?: string;
  git_commit_sha?: string;
  git_branch?: string;
  local_only?: boolean;
}): Promise<string> {
  const id = uuid();
  await runAsync(
    `INSERT INTO flows (
      id, name, description,
      git_repo_root, git_commit_sha, git_branch,
      local_only, created_at, updated_at, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
    [
      id,
      opts.name,
      opts.description ?? '',
      opts.git_repo_root ?? null,
      opts.git_commit_sha ?? null,
      opts.git_branch ?? null,
      opts.local_only ? 1 : 0,
    ],
  );
  return id;
}

/**
 * Insert a child flow that records its parent — used when "forking" an
 * existing flow from a specific step (e.g. branching investigations).
 */
export async function insertChildFlow(opts: {
  name: string;
  description?: string;
  parentFlowId: string;
  parentFlowMatchId: string;
  git_repo_root?: string;
  git_commit_sha?: string;
  git_branch?: string;
  local_only?: boolean;
}): Promise<string> {
  const id = uuid();
  await runAsync(
    `INSERT INTO flows (
      id, name, description,
      git_repo_root, git_commit_sha, git_branch,
      local_only, created_at, updated_at, archived,
      parent_flow_id, parent_flow_match_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0, ?, ?)`,
    [
      id,
      opts.name,
      opts.description ?? '',
      opts.git_repo_root ?? null,
      opts.git_commit_sha ?? null,
      opts.git_branch ?? null,
      opts.local_only ? 1 : 0,
      opts.parentFlowId,
      opts.parentFlowMatchId,
    ],
  );
  return id;
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { initializeCli } from '../db/sqlite.ts';
// import { insertFlow, getFlow, getFlows, archiveFlow } from './flows/crud.ts';
//
// await initializeCli('/tmp/way-test.db');
//
// // 1. Create + read
// const id = await insertFlow({ name: 'My flow', description: 'Trying things' });
// await getFlow(id);
//
// // 2. List all
// await getFlows();
//
// // 3. Archive (soft delete)
// await archiveFlow(id);

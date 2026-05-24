// ──────────────────────────────────────────────────────────────────────────
// Thin CRUD helpers built on the sqlite3 shell driver.
//
// Ported from waystation-vscode/src/db/dbAsync.ts. The original carried a
// legacy `db: any` first parameter for compatibility with an older
// connection-handle API; the shell driver is stateless at the protocol
// level, so we drop that argument here.
// ──────────────────────────────────────────────────────────────────────────

import { executeGet, executeQuery, executeRun } from './sqlite.ts';

/**
 * Generic INSERT … ON CONFLICT(...) DO UPDATE … RETURNING id.
 *
 * @param table             Table name (caller-sanitised — do not interpolate
 *                          user input here).
 * @param data              Map of column → value to insert/update.
 * @param conflictColumns   Columns that form the conflict target index.
 * @returns The id of the inserted or updated row.
 *
 * @example
 *   await upsertAsync('flows',
 *     { id: 'abc', name: 'My Flow', description: '' },
 *     ['id']);
 */
export async function upsertAsync(
  table: string,
  data: Record<string, unknown>,
  conflictColumns: string[],
): Promise<string | number> {
  const columns = Object.keys(data);
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns
    .filter((col) => !conflictColumns.includes(col))
    .map((col) => `${col} = excluded.${col}`)
    .join(', ');

  const sql = `
    INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(${conflictColumns.join(', ')}) DO UPDATE SET
    ${updates}
    RETURNING id
  `;

  const params = columns.map((col) => data[col]);
  const result = await executeQuery<{ id: string | number }>(sql, params);
  if (result && result.length > 0 && result[0].id !== undefined) {
    return result[0].id;
  }
  throw new Error(`Upsert into ${table} did not return an id`);
}

/** Execute a query and return all rows. Caller asserts the row shape `T`. */
export async function queryAsync<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return await executeQuery<T>(sql, params);
}

/** Return the first row of a query, or `undefined`. */
export async function getAsync<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return await executeGet<T>(sql, params);
}

/** Run a non-returning statement (INSERT/UPDATE/DELETE/ALTER). */
export async function runAsync(sql: string, params: unknown[] = []): Promise<void> {
  await executeRun(sql, params);
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { initializeCli } from './db/sqlite.ts';
// import { runAsync, queryAsync, getAsync, upsertAsync } from './db/helpers.ts';
//
// await initializeCli('/tmp/way-test.db');
//
// // 1. Plain INSERT
// await runAsync(
//   `INSERT INTO flows (id, name) VALUES (?, ?)`,
//   ['f1', 'Test'],
// );
//
// // 2. Read back
// await getAsync<{ id: string; name: string }>(
//   'SELECT id, name FROM flows WHERE id = ?', ['f1'],
// );
//
// // 3. Upsert with conflict on id
// await upsertAsync('flows', { id: 'f1', name: 'Renamed' }, ['id']);

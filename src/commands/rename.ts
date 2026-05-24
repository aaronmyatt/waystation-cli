// ──────────────────────────────────────────────────────────────────────────
// `way rename <flowId> <newTitle>`
//
// Updates the display name of an existing flow. The flow must exist and
// must not be archived. This is the simplest CRUD operation in the system
// — a single UPDATE on the `flows` table — but it fills a critical UX gap:
// agents (and users) previously had no way to give a flow a meaningful
// title after creation.
//
// Usage:
//   way rename 0a2ce11b-... "Jira sync consumer: key moving pieces"
// ──────────────────────────────────────────────────────────────────────────

import { initializeCli } from '../db/sqlite.ts';
import { renameFlow } from '../flows/crud.ts';
import { defaultDbPath } from './_common.ts';

export async function renameCommand(
  flowId: string,
  newTitle: string,
  opts: { dbPath?: string },
): Promise<void> {
  if (!flowId) throw new Error('rename: missing <flowId> argument');
  if (!newTitle) throw new Error('rename: missing <newTitle> argument');

  await initializeCli(opts.dbPath ?? defaultDbPath());
  await renameFlow(flowId, newTitle);

  console.log(`Renamed flow ${flowId} → "${newTitle}"`);
}

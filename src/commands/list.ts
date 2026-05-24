// ──────────────────────────────────────────────────────────────────────────
// `way list` — print all non-archived flows.
// ──────────────────────────────────────────────────────────────────────────

import { initializeCli } from '../db/sqlite.ts';
import { getFlowsWithCounts } from '../flows/crud.ts';
import { defaultDbPath } from './_common.ts';

export async function listCommand(opts: { dbPath?: string }): Promise<void> {
  await initializeCli(opts.dbPath ?? defaultDbPath());
  const flows = await getFlowsWithCounts();
  if (flows.length === 0) {
    console.log('No flows yet. Try `way add <path>:<line>` to create one.');
    return;
  }

  // Compute column widths so the table aligns even with long flow names.
  const idWidth = Math.max(2, ...flows.map((f) => (f.id ?? '').length));
  const nameWidth = Math.max(4, ...flows.map((f) => f.name.length));
  const header = `${pad('ID', idWidth)}  ${pad('NAME', nameWidth)}  ${pad('STEPS', 5)}  UPDATED`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const f of flows) {
    console.log(
      `${pad(f.id ?? '', idWidth)}  ${pad(f.name, nameWidth)}  ` +
        `${pad(String(f.matchCount), 5)}  ${f.updated_at ?? ''}`,
    );
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

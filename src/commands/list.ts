// ──────────────────────────────────────────────────────────────────────────
// `way list` — print all non-archived flows.
//
// Supports three output modes:
//   default         Fixed-width table (human-readable).
//   --json          Compact JSON array of FlowListItem objects.
//   --plain         Tab-separated values (id\tname\tsteps\tupdated).
//
// When both --json and --plain are passed, --json wins — it's the more
// structured format and the explicit "machine-readable" path.
// ──────────────────────────────────────────────────────────────────────────

import { initializeCli } from '../db/sqlite.ts';
import { getFlowsWithCounts } from '../flows/crud.ts';
import { defaultDbPath } from './_common.ts';

export async function listCommand(opts: {
  dbPath?: string;
  json?: boolean;
  plain?: boolean;
}): Promise<void> {
  await initializeCli(opts.dbPath ?? defaultDbPath());
  const flows = await getFlowsWithCounts();

  // ── --json: emit a JSON array and exit. ──────────────────────────────
  // Matches `way show --json` convention: `JSON.stringify(x, null, 2)`.
  // Even an empty result set gets a valid `[]` — no special-casing needed,
  // because tooling that pipes into `jq` expects valid JSON, not a prose
  // message.
  if (opts.json) {
    console.log(JSON.stringify(flows, null, 2));
    return;
  }

  // ── --plain: emit tab-separated values without a header row. ──────────
  // No header means `cut -f2` and `awk` work on every line identically.
  // Empty flows → no output (not even a header), so `wc -l` reads 0.
  if (opts.plain) {
    for (const f of flows) {
      console.log(`${f.id ?? ''}\t${f.name}\t${f.matchCount}\t${f.updated_at ?? ''}`);
    }
    return;
  }

  // ── Default: fixed-width table ───────────────────────────────────────
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

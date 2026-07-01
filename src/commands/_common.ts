// ──────────────────────────────────────────────────────────────────────────
// Shared helpers for `way` subcommands. Resolves the default DB path so
// every command spells it the same way.
// ──────────────────────────────────────────────────────────────────────────

import { join } from '@std/path';

/** Mirrors the extension's storage location: $HOME/.waystation/way.db. */
export function defaultDbPath(): string {
  const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE');
  if (!home) {
    throw new Error('Cannot resolve default DB path: $HOME is unset. Pass --db <path>.');
  }
  return join(home, '.waystation', 'way.db');
}

// ── Timestamp normalization ──────────────────────────────────────────────
/**
 * Coerce any stored timestamp to canonical ISO 8601 (UTC, `Z`-suffixed).
 *
 * Two formats coexist in the DB and must be reconciled before display:
 *   • SQLite `datetime('now')` / `CURRENT_TIMESTAMP` → "2026-06-30 11:56:25"
 *     — space-separated, no timezone marker. SQLite stores these in UTC.
 *   • Extension-synced rows → "2026-04-07T13:33:26.423Z" — already ISO 8601.
 *
 * Mixing the two breaks both lexical sorting (space `' '` sorts before `'T'`)
 * and any consumer that does a naive string compare, so we funnel everything
 * through `Date.prototype.toISOString()` for one canonical form.
 *
 * Gotcha: `new Date("2026-06-30 11:56:25")` parses as *local* time in V8 —
 * per the spec, non-ISO date strings are implementation-defined — which would
 * silently shift SQLite's UTC value by the host's offset. We rewrite the space
 * form to explicit UTC ("…T…Z") before parsing so the instant is preserved.
 * Ref: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/Date#date_time_string_format
 *
 * @param ts A stored timestamp string, or null/undefined/empty.
 * @return   Canonical ISO 8601 string; '' for empty input; the original
 *           string unchanged if it can't be parsed (better than "Invalid Date").
 */
export function toIso8601(ts: string | null | undefined): string {
  if (!ts) return '';
  // A 'T' means it's already an ISO string (trust its own zone marker).
  // Otherwise it's the SQLite space form — treat as UTC by making the zone
  // explicit: "2026-06-30 11:56:25" → "2026-06-30T11:56:25Z".
  const candidate = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? ts : parsed.toISOString();
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { toIso8601 } from './commands/_common.ts';
//
// // 1. SQLite space form → ISO (UTC preserved, milliseconds zero-filled)
// toIso8601('2026-06-30 11:56:25');       // "2026-06-30T11:56:25.000Z"
//
// // 2. Already-ISO form round-trips unchanged
// toIso8601('2026-04-07T13:33:26.423Z');  // "2026-04-07T13:33:26.423Z"
//
// // 3. Empty / unparseable input degrades gracefully
// toIso8601(undefined);                    // ""
// toIso8601('not a date');                 // "not a date"

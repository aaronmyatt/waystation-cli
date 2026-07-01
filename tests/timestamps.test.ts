// Verifies `toIso8601` reconciles the two timestamp formats that coexist in
// the DB (SQLite space form vs. extension-synced ISO) into one canonical
// ISO 8601 output. Drives the pure helper directly — no DB or CLI needed.
// Backs TASK-4: `way list` must emit a single timestamp format everywhere.

import { assert, assertEquals } from '@std/assert';
import { toIso8601 } from '../src/commands/_common.ts';

Deno.test('toIso8601 — SQLite space form is treated as UTC (no offset drift)', () => {
  // The space form carries no zone marker; SQLite stores it in UTC. The helper
  // must NOT let V8 reinterpret it as local time, so the instant is preserved.
  assertEquals(toIso8601('2026-06-30 11:56:25'), '2026-06-30T11:56:25.000Z');
});

Deno.test('toIso8601 — already-ISO form round-trips unchanged', () => {
  assertEquals(toIso8601('2026-04-07T13:33:26.423Z'), '2026-04-07T13:33:26.423Z');
});

Deno.test('toIso8601 — both forms converge on the same canonical shape', () => {
  // The whole point of TASK-4: mixed inputs → one comparable format.
  const a = toIso8601('2026-06-30 11:56:25');
  const b = toIso8601('2026-06-30T11:56:25.000Z');
  assertEquals(a, b);
  // And the canonical form always ends in 'Z' (UTC) with a 'T' separator.
  assert(a.endsWith('Z') && a.includes('T'));
});

Deno.test('toIso8601 — empty / nullish input degrades to empty string', () => {
  assertEquals(toIso8601(''), '');
  assertEquals(toIso8601(undefined), '');
  assertEquals(toIso8601(null), '');
});

Deno.test('toIso8601 — unparseable input is returned unchanged, not "Invalid Date"', () => {
  assertEquals(toIso8601('not a date'), 'not a date');
});

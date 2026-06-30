// Verifies `way add` builds a Match with the correct grep_meta blob, both
// for the `path:N` single-line form (±3 lines context) and the `path:S:E`
// range form (exact slice). End-to-end with the DB pipeline is exercised
// in save_match.test.ts; here we just test the capture/shape logic so the
// boundary cases are pinpointed when something changes.

import { assert, assertEquals, assertThrows } from '@std/assert';
import { buildMatchFromCapture, parseAddSpec } from '../src/commands/add.ts';

const SAMPLE_TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

Deno.test('parseAddSpec — single-line form', () => {
  const r = parseAddSpec('/tmp/file.ts:5');
  assertEquals(r.lineNo, 5);
  assertEquals(r.endLine, undefined);
  assert(r.filePath.endsWith('/tmp/file.ts'));
});

Deno.test('parseAddSpec — range form', () => {
  const r = parseAddSpec('/tmp/file.ts:2:8');
  assertEquals(r.lineNo, 2);
  assertEquals(r.endLine, 8);
});

Deno.test('parseAddSpec — rejects malformed input', () => {
  assertThrows(() => parseAddSpec(''));
  assertThrows(() => parseAddSpec('nopath'));
  assertThrows(() => parseAddSpec('/tmp/f.ts:abc'));
  // end-line before start
  assertThrows(() => parseAddSpec('/tmp/f.ts:5:2'));
});

Deno.test('single-line form captures ±3 lines of context (grep -C 3)', () => {
  const m = buildMatchFromCapture('/tmp/sample.ts', SAMPLE_TEN_LINES, 5);
  assert(m.grep_meta);
  const meta = JSON.parse(m.grep_meta);
  assertEquals(meta.context_lines.length, 7); // 5-3..5+3
  assertEquals(meta.context_start_line, 2);
  assertEquals(meta.matched_index_in_context, 3); // 5 - 2
  assertEquals(meta.language, 'typescript');
  assertEquals(meta.context_lines[meta.matched_index_in_context], 'line 5');
  // The single-line form stores only the target line in `.line` —
  // matches the content-id hash key used by saveMatch.
  assertEquals(m.line, 'line 5');
});

Deno.test('single-line form clamps the context window at file boundaries', () => {
  // Target line 1: there are no lines before, so the window starts at 1.
  const m = buildMatchFromCapture('/tmp/sample.ts', SAMPLE_TEN_LINES, 1);
  const meta = JSON.parse(m.grep_meta!);
  assertEquals(meta.context_start_line, 1);
  assertEquals(meta.matched_index_in_context, 0);
  // 1..4 → 4 lines
  assertEquals(meta.context_lines.length, 4);
  assertEquals(meta.context_lines[0], 'line 1');
});

Deno.test('single-line form clamps at end of file', () => {
  // Target line 10 (last line): 7..10 → 4 lines.
  const m = buildMatchFromCapture('/tmp/sample.ts', SAMPLE_TEN_LINES, 10);
  const meta = JSON.parse(m.grep_meta!);
  assertEquals(meta.context_start_line, 7);
  // matched is the last in the window
  assertEquals(meta.matched_index_in_context, 3);
  assertEquals(meta.context_lines.length, 4);
});

Deno.test('range form captures exactly the requested slice', () => {
  const m = buildMatchFromCapture('/tmp/sample.ts', SAMPLE_TEN_LINES, 2, 5);
  const meta = JSON.parse(m.grep_meta!);
  assertEquals(meta.context_lines.length, 4); // 2..5 inclusive
  assertEquals(meta.context_start_line, 2);
  assertEquals(meta.matched_index_in_context, 0); // range start is the target
  assertEquals(meta.context_lines, ['line 2', 'line 3', 'line 4', 'line 5']);
  // Range form joins the captured lines into `.line`.
  assertEquals(m.line, 'line 2\nline 3\nline 4\nline 5');
});

Deno.test('throws when target line is past EOF', () => {
  assertThrows(() => buildMatchFromCapture('/tmp/sample.ts', SAMPLE_TEN_LINES, 999));
});

Deno.test('throws when range end is past EOF', () => {
  assertThrows(() => buildMatchFromCapture('/tmp/sample.ts', SAMPLE_TEN_LINES, 5, 999));
});

Deno.test('detectLanguage via file extension', () => {
  // Tested implicitly above (sample.ts → typescript); spot-check a couple more.
  const md = buildMatchFromCapture('/tmp/r.md', 'a\nb\nc\nd\ne\nf\ng', 4);
  assertEquals(JSON.parse(md.grep_meta!).language, 'markdown');

  const py = buildMatchFromCapture('/tmp/r.py', 'a\nb\nc', 2);
  assertEquals(JSON.parse(py.grep_meta!).language, 'python');

  const unknown = buildMatchFromCapture('/tmp/r.xyz', 'a\nb\nc', 2);
  assertEquals(JSON.parse(unknown.grep_meta!).language, 'text');
});

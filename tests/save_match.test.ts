// Exercises the saveMatch pipeline against a real (temp) DB:
//   • passing no flowId auto-creates a flow,
//   • the match row exists with the content-based id,
//   • a second saveMatch onto the same flow gets order_index 1.

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { initDatabase } from '../src/pipelines/initDatabase.ts';
import { saveMatch } from '../src/pipelines/saveMatch.ts';
import { getAsync, queryAsync } from '../src/db/helpers.ts';

async function withTempDb(fn: (dbPath: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'way-save-match-' });
  try {
    const dbPath = join(dir, 'way.db');
    await initDatabase.process({ storageDir: dir, dbPath });
    await fn(dbPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('saveMatch creates a flow + inserts a match', async () => {
  await withTempDb(async () => {
    const result = await saveMatch.process({
      match: {
        line: 'const x = 1;',
        file_path: '/tmp/file.ts',
        file_name: 'file.ts',
        line_no: 5,
      },
    });
    assert(result.flowId, 'flowId should be auto-created');
    assert(result.resultMatchId, 'match id should be set');
    assert(result.flowMatchId, 'flow_match id should be set');

    // Match row visible
    const match = await getAsync<{ id: string; line: string }>(
      'SELECT id, line FROM matches WHERE id = ?',
      [result.resultMatchId],
    );
    assertEquals(match?.line, 'const x = 1;');

    // flow_match row visible with order_index 0
    const fm = await getAsync<{ order_index: number; content_kind: string }>(
      'SELECT order_index, content_kind FROM flow_matches WHERE id = ?',
      [result.flowMatchId],
    );
    assertEquals(fm?.order_index, 0);
    assertEquals(fm?.content_kind, 'match');
  });
});

Deno.test('saveMatch refreshes grep_meta on a re-capture of the same line', async () => {
  // Regression test: the match id is content-derived, so re-adding the
  // same (line, file_path, sha) triple hits a primary-key conflict.
  // Previously we used INSERT OR IGNORE, which silently kept the old row
  // and left grep_meta NULL when the first capture didn't set it — so
  // `way show` rendered the heading with no code block below.
  await withTempDb(async () => {
    // First capture: no grep_meta (simulates a pre-fix `way add`).
    const r1 = await saveMatch.process({
      match: {
        line: 'const x = 1;',
        file_path: '/tmp/file.ts',
        file_name: 'file.ts',
        line_no: 5,
      },
    });
    let row = await getAsync<{ grep_meta: string | null; line_no: number }>(
      'SELECT grep_meta, line_no FROM matches WHERE id = ?',
      [r1.resultMatchId!],
    );
    assertEquals(row?.grep_meta, null);
    assertEquals(row?.line_no, 5);

    // Second capture: same content, now WITH grep_meta + a different
    // line_no (the line moved within the file).
    const r2 = await saveMatch.process({
      match: {
        line: 'const x = 1;',
        file_path: '/tmp/file.ts',
        file_name: 'file.ts',
        line_no: 9,
        grep_meta: JSON.stringify({
          context_lines: ['a', 'const x = 1;', 'b'],
          context_start_line: 8,
          matched_index_in_context: 1,
          language: 'typescript',
        }),
      },
    });
    // Same content → same id (content-based hash).
    assertEquals(r2.resultMatchId, r1.resultMatchId);

    row = await getAsync<{ grep_meta: string | null; line_no: number }>(
      'SELECT grep_meta, line_no FROM matches WHERE id = ?',
      [r1.resultMatchId!],
    );
    assert(row?.grep_meta, 'grep_meta should be populated after the second capture');
    const meta = JSON.parse(row!.grep_meta!);
    assertEquals(meta.context_lines.length, 3);
    assertEquals(row?.line_no, 9);  // line_no refreshed too
  });
});

Deno.test('saveMatch appends to an existing flow with incremented order_index', async () => {
  await withTempDb(async () => {
    const r1 = await saveMatch.process({
      match: {
        line: 'first',
        file_path: '/tmp/a.ts',
        file_name: 'a.ts',
        line_no: 1,
      },
    });
    const r2 = await saveMatch.process({
      match: {
        line: 'second',
        file_path: '/tmp/a.ts',
        file_name: 'a.ts',
        line_no: 2,
      },
      flowId: r1.flowId,
    });
    assertEquals(r2.flowId, r1.flowId);

    const rows = await queryAsync<{ order_index: number }>(
      'SELECT order_index FROM flow_matches WHERE flows_id = ? ORDER BY order_index',
      [r1.flowId!],
    );
    assertEquals(rows.map((r) => r.order_index), [0, 1]);
  });
});

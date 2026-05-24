// Round-trips a flow with mixed match + note rows through saveMatch +
// direct SQL inserts, then loads it via buildFlowAggregate and verifies the
// canonical JSON shape via pointer reads.

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { initDatabase } from '../src/pipelines/initDatabase.ts';
import { saveMatch } from '../src/pipelines/saveMatch.ts';
import { buildFlowAggregate } from '../src/pipelines/buildFlowAggregate.ts';
import { runAsync } from '../src/db/helpers.ts';
import * as jp from '../src/vendor/jsonpointer.ts';
import { P } from '../src/pointers.ts';

Deno.test('buildFlowAggregate loads matches and notes in order', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'way-agg-test-' });
  try {
    const dbPath = join(dir, 'way.db');
    await initDatabase.process({ storageDir: dir, dbPath });

    // Step 0: a code match (auto-created flow).
    const r1 = await saveMatch.process({
      match: {
        line: 'console.log(1)',
        file_path: '/tmp/x.ts',
        file_name: 'x.ts',
        line_no: 7,
      },
    });
    const flowId = r1.flowId!;

    // Step 1: a manual note in the same flow. Insert a step_content + a
    // flow_match pointing at it — same shape the extension produces.
    const noteId = crypto.randomUUID();
    const fmId = crypto.randomUUID();
    await runAsync(
      `INSERT INTO step_contents (id, kind, title, body)
       VALUES (?, 'note', ?, ?)`,
      [noteId, 'A title', 'A body'],
    );
    await runAsync(
      `INSERT INTO flow_matches
       (id, flows_id, matches_id, order_index, content_kind, content_id, archived)
       VALUES (?, ?, NULL, 1, 'note', ?, 0)`,
      [fmId, flowId, noteId],
    );

    const { aggregate } = await buildFlowAggregate.process({ flowId });
    assert(aggregate, 'aggregate should be defined');

    // Two steps in declared order
    assertEquals((aggregate!.matches ?? []).length, 2);
    assertEquals(jp.get(aggregate, P.matchKind(0)), 'match');
    assertEquals(jp.get(aggregate, P.matchKind(1)), 'note');

    // Step 0: match payload joined in
    assertEquals(jp.get(aggregate, P.matchLineNo(0)), 7);
    assertEquals(jp.get(aggregate, P.matchFilePath(0)), '/tmp/x.ts');

    // Step 1: step_content payload joined in
    assertEquals(jp.get(aggregate, P.stepTitle(1)), 'A title');
    assertEquals(jp.get(aggregate, P.stepBody(1)), 'A body');

    // Flow scalars
    assert(jp.get(aggregate, P.flowName));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

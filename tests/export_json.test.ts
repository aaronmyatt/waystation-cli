// Drives the render-ready JSON export at its three layers:
//
//   1. toFlowView      pure: a typed FlowAggregate in, the flat view out
//   2. exportJson      pipeline: a flow id in, `view` + `json` out, via a real DB
//   3. exportCommand   `way export <flow> --json [--out FILE]` and its refusals
//
// The view's finer points (every stored shape of grep_meta, the note parser)
// are covered in render_scripts.test.ts, which reaches toFlowView through
// scripts/render/_shared.ts. Here the question is whether the CLI hands out
// that same view for a flow that went through the database.

import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { buildMatchFromCapture } from '../src/commands/add.ts';
import { exportCommand } from '../src/commands/export.ts';
import { runAsync } from '../src/db/helpers.ts';
import { toFlowView } from '../src/flows/view.ts';
import { exportJson } from '../src/pipelines/exportJson.ts';
import { initDatabase } from '../src/pipelines/initDatabase.ts';
import { saveMatch } from '../src/pipelines/saveMatch.ts';
import type { FlowAggregate } from '../src/types.ts';

const TEN_LINES = Array.from({ length: 10 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');

/**
 * A temp database holding one flow of three steps: a single-line capture, a
 * range capture, and a note. Removed after `fn`.
 */
async function withFlow(fn: (flowId: string, dir: string, dbPath: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'way-export-json-' });
  try {
    const dbPath = join(dir, 'way.db');
    await initDatabase.process({ storageDir: dir, dbPath });

    const single = await saveMatch.process({
      match: buildMatchFromCapture('/tmp/sample.ts', TEN_LINES, 5),
      stepTitle: 'One line',
      stepDesc: 'Why **this** line.\n\n- first\n- second',
    });
    const flowId = single.flowId!;
    await saveMatch.process({
      match: buildMatchFromCapture('/tmp/sample.ts', TEN_LINES, 2, 4),
      flowId,
      stepTitle: 'A range',
    });
    // A manual note: a step_content plus the flow_match pointing at it.
    const noteId = crypto.randomUUID();
    await runAsync(`INSERT INTO step_contents (id, kind, title, body) VALUES (?, 'note', ?, ?)`, [
      noteId,
      'Just a note',
      'No code here.',
    ]);
    await runAsync(
      `INSERT INTO flow_matches
       (id, flows_id, matches_id, order_index, content_kind, content_id, archived)
       VALUES (?, ?, NULL, 2, 'note', ?, 0)`,
      [crypto.randomUUID(), flowId, noteId],
    );
    await fn(flowId, dir, dbPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Run `fn` with console.log captured; returns what it printed, line by line. */
async function printed(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

Deno.test('toFlowView flattens a FlowAggregate: refs, permalink, parsed note', () => {
  const aggregate: FlowAggregate = {
    flow: {
      id: 'f-test',
      name: 'Hello Flow',
      description: 'A `walk`',
      created_at: '2026-05-13 09:00:00',
      updated_at: '2026-05-13 09:05:00',
    },
    matches: [
      {
        flows_id: 'f-test',
        content_kind: 'note',
        content_id: 'sc1',
        order_index: 0,
        step_content: { kind: 'note', title: 'Intro', body: 'Hello **world**.' },
      },
      {
        flows_id: 'f-test',
        matches_id: 'm1',
        content_kind: 'match',
        content_id: 'm1',
        order_index: 1,
        match: {
          id: 'm1',
          line: 'const x = 1',
          file_path: '/repo/src/x.ts',
          file_name: 'x.ts',
          line_no: 42,
          git_repo_root: 'owner/repo',
          git_branch: 'main',
          git_commit_sha: 'abc',
          repo_relative_file_path: 'src/x.ts',
        },
      },
    ],
  };
  const view = toFlowView(aggregate);
  assertEquals([view.name, view.updatedAt, view.files], [
    'Hello Flow',
    '2026-05-13 09:05:00',
    ['src/x.ts'],
  ]);
  assertEquals(view.descriptionSpans, [{ t: 'text', v: 'A ' }, { t: 'code', v: 'walk' }]);

  const [note, code] = view.steps;
  assertEquals([note.n, note.title, note.ref, note.lines, note.hitIndex], [
    1,
    'Intro',
    null,
    [],
    -1,
  ]);
  assertEquals(note.blocks, [{
    t: 'p',
    spans: [{ t: 'text', v: 'Hello ' }, { t: 'strong', v: 'world' }, { t: 'text', v: '.' }],
  }]);
  // No title stored: it falls back to file:line. The permalink pins the SHA.
  assertEquals([code.title, code.ref, code.lines, code.hitIndex], [
    'x.ts:42',
    'src/x.ts:42',
    ['const x = 1'],
    0,
  ]);
  assertEquals(code.url, 'https://github.com/owner/repo/blob/abc/src/x.ts#L42');
});

Deno.test('exportJson: a flow id in, the view and its JSON out', () =>
  withFlow(async (flowId) => {
    const { view, json, aggregate } = await exportJson.process({ flowId });
    assert(view && json && aggregate);

    assertEquals(view.steps.map((s) => [s.n, s.title]), [
      [1, 'One line'],
      [2, 'A range'],
      [3, 'Just a note'],
    ]);
    const [single, range, note] = view.steps;

    // Single-line capture: ±3 lines of context, and the focal row is line 5.
    assertEquals([single.line, single.endLine, single.startLine, single.lines.length], [
      5,
      null,
      2,
      7,
    ]);
    assertEquals(single.lines[single.hitIndex], 'const line5 = 5;');
    assertEquals(single.lang, 'typescript');
    assertEquals(single.blocks.map((b) => b.t), ['p', 'ul']);

    // Range capture: the exact slice, an end line, and no single focal row.
    assertEquals([range.line, range.endLine, range.hitIndex], [2, 4, -1]);
    assertEquals(range.lines, ['const line2 = 2;', 'const line3 = 3;', 'const line4 = 4;']);
    assert(range.ref?.endsWith(':2-4'), String(range.ref));

    assertEquals([note.file, note.ref, note.lines, note.body], [null, null, [], 'No code here.']);

    // `json` is `view`, and the view is exactly what toFlowView makes of the aggregate.
    assertEquals(JSON.parse(json), view);
    assertEquals(view, toFlowView(aggregate));
    // Every step carries every key, so a template never meets a missing one.
    const keys = Object.keys(view.steps[0]);
    for (const step of view.steps) assertEquals(Object.keys(step), keys);
  }));

Deno.test('way export --json prints the view, or writes it with --out', () =>
  withFlow(async (flowId, dir, dbPath) => {
    const { json } = await exportJson.process({ flowId });

    // By id, to stdout.
    assertEquals(await printed(() => exportCommand(flowId, { dbPath, json: true })), [json]);
    // By part of the name, like every other command that takes a flow.
    const { view } = await exportJson.process({ flowId });
    const lines = await printed(() =>
      exportCommand(view!.name.slice(0, 6), { dbPath, json: true })
    );
    assertEquals(lines, [json]);

    // --out writes the file (with a final newline) and says so.
    const out = join(dir, 'flow.json');
    assertEquals(await printed(() => exportCommand(flowId, { dbPath, json: true, out })), [
      `Wrote ${out}`,
    ]);
    assertEquals(await Deno.readTextFile(out), `${json}\n`);

    // Without --json nothing changed: still Markdown.
    const markdown = await printed(() => exportCommand(flowId, { dbPath }));
    assert(markdown.join('\n').includes('## One line'));
  }));

Deno.test('way export --json refuses the Markdown-only flags', async () => {
  // Refused before the database is opened, so no database is needed.
  for (const flags of [{ pretty: true }, { frontmatter: true }, { exportLinks: false }]) {
    await assertRejects(
      () => exportCommand('any', { json: true, ...flags }),
      Error,
      '--json cannot be combined',
    );
  }
});

// Renders a hand-built FlowAggregate through generateFlowMarkdown +
// addFrontmatter and asserts the key structural pieces are present. Avoids a
// full golden-file comparison so the test is robust to whitespace tweaks in
// the renderer.

import { assertEquals, assertStringIncludes } from '@std/assert';
import { addFrontmatter, generateFlowMarkdown } from '../src/flows/markdown.ts';
import type { FlowAggregate } from '../src/types.ts';

function buildSample(): FlowAggregate {
  return {
    flow: {
      id: 'f-test',
      name: 'Hello Flow',
      description: 'Walkthrough',
      created_at: '2026-05-13 09:00:00',
      updated_at: '2026-05-13 09:05:00',
    },
    matches: [
      {
        flows_id: 'f-test',
        content_kind: 'note',
        content_id: 'sc1',
        order_index: 0,
        step_content: { kind: 'note', title: 'Intro', body: 'Hello world.' },
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
}

Deno.test('generateFlowMarkdown emits H1 + step headings + body text', () => {
  const md = generateFlowMarkdown(buildSample(), { export: false });
  assertStringIncludes(md, '# Hello Flow');
  assertStringIncludes(md, '> Walkthrough');
  assertStringIncludes(md, '## Intro');
  assertStringIncludes(md, 'Hello world.');
});

Deno.test('export-mode rendering includes a GitHub permalink', () => {
  const md = generateFlowMarkdown(buildSample(), { export: true });
  // Permalink form: github.com/<repo>/blob/<branch>/<rel>#L<line>
  assertStringIncludes(md, 'https://github.com/owner/repo/blob/main/src/x.ts#L42');
});

Deno.test('addFrontmatter prepends a parseable JSON-blob frontmatter', () => {
  const agg = buildSample();
  const fm = addFrontmatter(agg);
  assertStringIncludes(fm, '---');
  assertStringIncludes(fm, '"Hello Flow"');
  // The serialised aggregate should round-trip through JSON.parse.
  const match = fm.match(/^flow: (\{.*\})$/m);
  if (!match) throw new Error('frontmatter missing JSON aggregate line');
  const parsed = JSON.parse(match[1]);
  assertEquals(parsed.flow.name, 'Hello Flow');
  assertEquals(parsed.matches.length, 2);
});

Deno.test('no matches → renders an empty-state hint', () => {
  const md = generateFlowMarkdown({ flow: { name: 'Empty' }, matches: [] });
  assertStringIncludes(md, '# Empty');
  assertStringIncludes(md, '_No matches found for this flow._');
});

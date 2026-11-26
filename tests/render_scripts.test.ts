// ──────────────────────────────────────────────────────────────────────────
// Structure checks for scripts/render/*. Non-visual by design: each test
// asserts on the shape of the output text (counts, escaping, anchors), not
// on how it looks. Looks are a human sign-off: open the files in dist/render.
//
// The fixture is a real aggregate captured from this repo with `way add` +
// `way show --json`, plus one hand-written note-only step.
//
// References:
//   • Deno.test:          https://docs.deno.com/api/deno/~/Deno.test
//   • JSON import attrs:  https://docs.deno.com/runtime/fundamentals/modules/#import-attributes
// ──────────────────────────────────────────────────────────────────────────

import { assert, assertEquals } from '@std/assert';
import fixture from '../scripts/render/fixtures/flow.json' with { type: 'json' };
import { normalize, parseBlocks, parseInput } from '../scripts/render/_shared.ts';
import type { FlowInput, StepInput } from '../scripts/render/_shared.ts';
import { buildCodeTour } from '../scripts/render/codetour.ts';
import { cssString, highlightLines, renderHtml } from '../scripts/render/html.ts';
import { codeBudget, fenceFor, noHtml, renderMarp } from '../scripts/render/marp.ts';
import { renderMermaid } from '../scripts/render/mermaid.ts';
import { renderTypstData, TYPST_TEMPLATES } from '../scripts/render/typst.ts';

const flow = fixture as FlowInput;
const STEPS = fixture.matches.length; // 9: eight code steps + one note

/** Count non-overlapping occurrences of `needle`. */
const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** A flow whose every text field tries to break out of its container. */
const hostile: FlowInput = {
  flow: { name: '<script>alert(1)</script> "q"' },
  matches: [{
    step_content: { title: 'say "hi" <b> # & `x`', body: '[bad](javascript:alert(1)) <img src=x>' },
    match: {
      file_path: '/w/a.ts',
      repo_relative_file_path: 'a.ts',
      line_no: 1,
      line: 'const a = "</code><script>";',
    },
  }],
};

// ── normalize ────────────────────────────────────────────────────────────

Deno.test('normalize: flattens every step and tells ranges from single lines', () => {
  const n = normalize(flow);
  assertEquals(n.steps.length, STEPS);
  assertEquals(n.files.length, 6);

  // Step 1 was captured as a range (116:124): no single focal line.
  assertEquals([n.steps[0].line, n.steps[0].endLine, n.steps[0].hitIndex], [116, 124, -1]);
  assertEquals(n.steps[0].ref, 'src/cli.ts:116-124');

  // Step 2 was a single line (39) with a ±3 window: focal line is index 3.
  assertEquals([n.steps[1].line, n.steps[1].endLine, n.steps[1].hitIndex], [39, null, 3]);
  assertEquals(n.steps[1].lines[3].trim().startsWith('const { markdown }'), true);

  // Permalinks pin the commit SHA, not the branch.
  assert(
    n.steps[1].url?.includes(`/blob/${fixture.flow.git_commit_sha}/src/commands/export.ts#L39`),
  );

  // The note-only step has no file behind it.
  const note = n.steps[STEPS - 1];
  assertEquals([note.file, note.ref, note.url, note.lines.length], [null, null, null, 0]);
});

Deno.test('parseInput: accepts JSON and `way export --frontmatter` markdown alike', () => {
  const json = JSON.stringify(flow);
  const md = `---\nid: "x"\nflow: ${json}\n---\n# body`;
  assertEquals(parseInput(md), parseInput(json));
});

Deno.test('parseBlocks: paragraphs, lists, fences; snake_case stays literal', () => {
  const blocks = parseBlocks(
    'Uses `order_index` and my_var_name.\n\n- a\n- **b**\n\n```ts\nx\n```',
  );
  assertEquals(blocks.map((b) => b.t), ['p', 'ul', 'code']);
  assertEquals(blocks[0].t === 'p' && blocks[0].spans.map((s) => s.t), ['text', 'code', 'text']);
});

// ── html ─────────────────────────────────────────────────────────────────

Deno.test('html: one anchored section and one rail link per step, self-contained', () => {
  const html = renderHtml(flow);
  for (let n = 1; n <= STEPS; n++) {
    assert(html.includes(`id="step-${n}"`), `missing section ${n}`);
    assert(html.includes(`href="#step-${n}"`), `missing rail link ${n}`);
  }
  assertEquals(count(html, '<details class="code'), STEPS - 1); // note step has no code
  assertEquals(count(html, 'class="ln hit"'), 4); // the four single-line captures
  // Self-contained: no scripts, no stylesheets or images fetched.
  assertEquals(count(html, '<script'), 0);
  assertEquals(count(html, '<link'), 0);
  assertEquals(count(html, '<img'), 0);
});

Deno.test('html: hostile text is escaped, unsafe links are dropped', () => {
  const html = renderHtml(hostile);
  assertEquals(count(html, '<script'), 0);
  assertEquals(count(html, '<img'), 0);
  assertEquals(count(html, '<b>'), 0);
  assertEquals(count(html, 'href="javascript:'), 0);
  assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

Deno.test('highlightLines: classes tokens, leaves unknown languages plain', () => {
  assertEquals(
    highlightLines(['const a = "b"; // c'], 'typescript')[0],
    '<span class="k">const</span> a = <span class="s">&quot;b&quot;</span>; <span class="c">// c</span>',
  );
  assertEquals(highlightLines(['a < b'], 'text')[0], 'a &lt; b');
});

Deno.test('html print: paper layout is built in, not left to the browser', () => {
  const html = renderHtml(flow);
  // Fills (badges, code panels) are asked to print even with backgrounds off.
  assert(html.includes('print-color-adjust:exact'));
  // Dark palette is screen-only, so a dark-mode browser still prints dark-on-white.
  assert(html.includes('@media screen and (prefers-color-scheme:dark)'));
  assertEquals(count(html, '@media (prefers-color-scheme:dark)'), 0);
  // Paper size + running footer with page counters.
  assert(html.includes('@page{size:A4;'));
  assert(html.includes('counter(page) " / " counter(pages)'));
  assert(renderHtml(flow, { paper: 'Letter' }).includes('@page{size:Letter;'));
  // Every fixture block is short enough to be kept whole on a page...
  assertEquals(count(html, 'class="code keep"'), STEPS - 1);
  // ...but a long one must be allowed to split, or it strands a blank page.
  const long = renderHtml({
    matches: [{
      match: {
        file_path: '/w/a.ts',
        repo_relative_file_path: 'a.ts',
        line_no: 1,
        line: 'x',
        grep_meta: { context_lines: Array.from({ length: 31 }, (_, i) => `l${i}`) },
      },
    }],
  });
  assertEquals(count(long, 'class="code keep"'), 0);
  assertEquals(count(long, '<details class="code" open>'), 1);
});

Deno.test('html print: a flow name cannot break out of the @page footer string', () => {
  assertEquals(cssString('a "q" \\ </style>\nb'), 'a \\"q\\" \\\\ \\3c /style> b');
  const html = renderHtml(hostile);
  assertEquals(count(html, '</style>'), 1);
});

// ── mermaid ──────────────────────────────────────────────────────────────

Deno.test('mermaid: a node per step, an edge per hop, a box per file', () => {
  const mmd = renderMermaid(flow);
  assertEquals(count(mmd, ' --> '), STEPS - 1);
  assertEquals(count(mmd, 'subgraph '), 6);
  assertEquals(count(mmd, 'click s'), STEPS - 1); // note step has no link
  for (let n = 1; n <= STEPS; n++) assert(new RegExp(`^\\s+s${n}[\\[(]`, 'm').test(mmd));
});

Deno.test('mermaid: quotes in titles cannot close the label early', () => {
  const node = renderMermaid(hostile).split('\n').find((l) => l.trim().startsWith('s1['))!;
  // Exactly the two delimiting quotes survive; the rest became entity codes.
  assertEquals(count(node, '"'), 2);
  assert(node.includes('#quot;hi#quot; #lt;b#gt; #35; #amp;'));
});

// ── marp ─────────────────────────────────────────────────────────────────

/** A deck's slides, in order, without the front matter. */
const slidesOf = (deck: string): string[] => deck.split('\n---\n').slice(1);

/** The per-slide style that feeds a code panel: its line numbers and focal row. */
function panelOf(slide: string): { numbers: number[]; hit: number } | null {
  const m = slide.match(
    /<style scoped>section > pre:last-of-type \{ --gutter: 4\.8em; --ln: "([^"]*)"; --hit: (-?\d+); \}<\/style>/,
  );
  return m ? { numbers: m[1].split('\\A ').map(Number), hit: Number(m[2]) } : null;
}

/** A step with `total` lines of code starting at `start`; `hit` is the focal index. */
function codeStep(
  title: string,
  body: string,
  total: number,
  start: number,
  hit: number,
  width = 30,
): StepInput {
  const lines = Array.from({ length: total }, (_, i) => `const v${i} = ${'x'.repeat(width)};`);
  return {
    step_content: { title, body },
    match: {
      file_path: '/w/src/a.ts',
      repo_relative_file_path: 'src/a.ts',
      line_no: start + Math.max(0, hit),
      // A range capture stores the whole slice as its `line`.
      line: hit < 0 ? lines.join('\n') : lines[hit],
      grep_meta: JSON.stringify({
        context_lines: lines,
        context_start_line: start,
        matched_index_in_context: Math.max(0, hit),
        language: 'typescript',
      }),
    },
  };
}

Deno.test('marp: title, route, then one slide per step; fences outgrow their content', () => {
  const deck = renderMarp(flow);
  assert(deck.startsWith('---\nmarp: true\n'));
  const slides = slidesOf(deck);
  assertEquals(slides.length, 1 + 1 + STEPS);
  // The title and route slides are left out of the page count, so the page
  // number Marp puts on a slide (drawn as the badge) is the step number.
  assert(deck.includes('\npaginate: true\n'));
  assertEquals(slides.map((s) => s.includes('<!-- _paginate: skip -->')).indexOf(false), 2);
  // No slide transition: slides cut straight from one to the next.
  assert(!deck.includes('\ntransition:'));
  // Step 7's code contains ``` so its fence must be four backticks.
  assert(deck.includes('````typescript\n'));
  assertEquals(fenceFor('plain'), '```');
});

Deno.test('marp: the route links every step to its own slide', () => {
  const slides = slidesOf(renderMarp(flow));
  const steps = normalize(flow).steps;
  steps.forEach((step, i) => {
    // Slide ids are 1-based positions: title is 1, route is 2, step 1 is 3.
    const link = slides[1].match(new RegExp(`^${step.n}\\. \\[.*\\]\\(#(\\d+)\\)`, 'm'));
    assertEquals(Number(link?.[1]), 3 + i, `route entry ${step.n}`);
    assert(slides[3 + i - 1].includes(`## ${step.title}`), `slide ${3 + i} is step ${step.n}`);
  });
  // A one-step flow needs no route.
  const one = slidesOf(
    renderMarp({ flow: { name: 'One' }, matches: (flow.matches ?? []).slice(0, 1) }),
  );
  assertEquals(one.length, 2);
});

Deno.test('marp: each code panel carries its line numbers and its focal row', () => {
  const slides = slidesOf(renderMarp(flow));
  const steps = normalize(flow).steps;
  steps.forEach((step, i) => {
    const panel = panelOf(slides[2 + i]);
    if (!step.lines.length) return assertEquals(panel, null, `step ${step.n} has no code`);
    assert(panel, `step ${step.n} has a panel style`);
    // One number per code line shown, counting up by one.
    const fence = slides[2 + i].match(/\n(`{3,})\w*\n([\s\S]*?)\n\1(?:\n|$)/);
    assertEquals(panel.numbers.length, fence?.[2].split('\n').length, `step ${step.n} numbers`);
    panel.numbers.forEach((n, k) => assertEquals(n, panel.numbers[0] + k));
    if (step.hitIndex >= 0) {
      // The highlighted row is the line the step points at.
      assertEquals(panel.numbers[panel.hit], step.line, `step ${step.n} focal line`);
    } else {
      // A range has no single focal line: no band.
      assertEquals([panel.hit, panel.numbers[0]], [-1, step.line], `step ${step.n} range`);
    }
  });
  // Step 5 is a 16-line range: trimmed to 14, and the breadcrumb says so.
  assert(slides[2 + 4].includes('showing 14 of 16 lines'));
});

Deno.test('marp: a long listing is trimmed around the focal line', () => {
  const deck = renderMarp({
    flow: { name: 'Trim' },
    matches: [codeStep('T', 'Note.', 40, 100, 30)],
  });
  const panel = panelOf(slidesOf(deck)[1]);
  assertEquals(panel?.numbers.length, 14);
  assertEquals(panel?.numbers[panel.hit], 130);
  assert(deck.includes('showing 14 of 40 lines'));
  assertEquals(
    panelOf(
      slidesOf(renderMarp(
        { flow: { name: 'Trim' }, matches: [codeStep('T', '', 40, 100, 30)] },
        { maxLines: 6 },
      ))[1],
    )?.numbers.length,
    6,
  );
});

Deno.test('marp: a note too long to share a slide gets its code on a second slide', () => {
  // A long note leaves fewer code lines; a very long one leaves none.
  assertEquals(codeBudget({ title: 'T', body: '' } as never, 14), 14);
  assertEquals(codeBudget({ title: 'T', body: 'x'.repeat(84 * 8) } as never, 14), 10);
  assert(codeBudget({ title: 'T', body: 'x'.repeat(84 * 16) } as never, 14) < 4);

  const longNote = Array.from({ length: 16 }, (_, i) => `Line ${i} ${'word '.repeat(14)}`).join(
    '\n\n',
  );
  const slides = slidesOf(renderMarp({
    flow: { name: 'Split' },
    matches: [codeStep('First', longNote, 10, 1, 4), codeStep('Second', 'Short.', 5, 50, 2)],
  }));
  // title, route, step 1 note, step 1 code, step 2
  assertEquals(slides.length, 5);
  assertEquals([panelOf(slides[2]), panelOf(slides[3])?.hit], [null, 4]);
  // `hold` repeats the page number, so both slides show badge 1.
  assertEquals(slides.map((s) => s.includes('<!-- _paginate: hold -->')), [
    false,
    false,
    false,
    true,
    false,
  ]);
  assert(slides[2].includes('## First') && slides[3].includes('## First'));
  // Step 2 moved along one slide, and the route follows it.
  assert(slides[1].includes('[First](#3)') && slides[1].includes('[Second](#5)'));
});

Deno.test('marp: flow text cannot become HTML or deck directives', () => {
  assertEquals(noHtml('a <b> `Map<K, V>` <i>'), 'a &lt;b> `Map<K, V>` &lt;i>');
  assertEquals(
    noHtml('<!-- _class: x -->\n```html\n<p>\n```\n<style>'),
    [
      '&lt;!-- _class: x -->',
      '```html',
      '<p>',
      '```',
      '&lt;style>',
    ].join('\n'),
  );

  const slides = slidesOf(renderMarp(hostile));
  for (const slide of slides) {
    // Code keeps its angle brackets; everything else must have none that
    // open a tag. Marp's own comments and <style scoped> are ours.
    const prose = slide.replace(/\n(`{3,})\w*\n[\s\S]*?\n\1(?=\n|$)/g, '')
      .replace(/<!-- _\w+: .*? -->|<style scoped>.*?<\/style>/g, '');
    assert(!/<[a-zA-Z!\/]/.test(prose), prose);
  }
  assert(slides[1].includes('## say "hi" &lt;b> # & `x`'));
});

// ── codetour ─────────────────────────────────────────────────────────────

Deno.test('codetour: code steps carry file+line, ranges a selection, notes neither', () => {
  const tour = buildCodeTour(flow);
  assertEquals(tour.steps.length, STEPS);
  assertEquals(tour.ref, fixture.flow.git_commit_sha);
  assertEquals(tour.steps[0].selection?.start, { line: 116, character: 1 });
  assertEquals([tour.steps[0].file, tour.steps[0].line], ['src/cli.ts', 124]);
  assertEquals([tour.steps[1].line, tour.steps[1].selection], [39, undefined]);
  assertEquals(Object.keys(tour.steps[STEPS - 1]), ['title', 'description']);
  assertEquals(buildCodeTour(flow, { pinRef: false }).ref, undefined);
});

// ── typst ────────────────────────────────────────────────────────────────

Deno.test('typst data: every step has every key (null, never missing)', () => {
  const data = JSON.parse(renderTypstData(flow));
  const keys = Object.keys(data.steps[0]).sort();
  for (const step of data.steps) assertEquals(Object.keys(step).sort(), keys);
  assertEquals(data.steps[STEPS - 1].ref, null);
});

// ── typst templates (compile + route-map geometry) ───────────────────────
//
// These run the real `typst` binary, so they are skipped where it is not
// installed. The route map publishes its computed geometry as metadata
// (`<layout>` in templates/map.typ); the tests read it back and assert the
// two promises the layout makes: cards never overlap, and no arrow runs
// through a card. That is a non-visual stand-in for "the diagram is tidy".
//
// References:
//   • Deno.Command:   https://docs.deno.com/api/deno/~/Deno.Command
//   • Test `ignore`:  https://docs.deno.com/runtime/fundamentals/testing/#ignoring%2Fskipping-tests
//   • typst eval / query: run `typst eval --help`

/** Geometry emitted by templates/map.typ, all lengths in pt. */
type MapLayout = {
  width: number;
  height: number;
  'card-width': number;
  cols: number;
  cards: { x: number; y: number; h: number; visit: number; row: number }[];
  boxes: { x: number; y: number; w: number; h: number; file: string | null }[];
  wires: [number, number][][];
};

type Rect = { x0: number; y0: number; x1: number; y1: number };

const TEMPLATES = new URL('../scripts/render/templates/', import.meta.url);

/** True when a usable `typst` is on PATH (and we are allowed to run it). */
function hasTypst(): boolean {
  try {
    return new Deno.Command('typst', { args: ['--version'], stdout: 'null', stderr: 'null' })
      .outputSync().success;
  } catch {
    return false;
  }
}

async function typst(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; out: string; err: string }> {
  const res = await new Deno.Command('typst', { args, cwd, stdout: 'piped', stderr: 'piped' })
    .output();
  const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  return { ok: res.success, out: text(res.stdout), err: text(res.stderr) };
}

/** Temp folder holding flow.json + every template; removed after `fn`. */
async function withTypstDir(input: FlowInput, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'way-render-' });
  try {
    await Deno.writeTextFile(`${dir}/flow.json`, renderTypstData(input));
    for (const name of TYPST_TEMPLATES) {
      await Deno.copyFile(new URL(name, TEMPLATES), `${dir}/${name}`);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Read the map's `<layout>` metadata. `typst eval` is the current command;
 *  older Typst only has `typst query`, so fall back to it. */
async function mapLayout(dir: string, inputs: string[] = []): Promise<MapLayout> {
  const flags = ['flow=flow.json', ...inputs].flatMap((kv) => ['--input', kv]);
  let res = await typst(dir, [
    'eval',
    'query(<layout>).first().value',
    '--in',
    'map.typ',
    ...flags,
  ]);
  if (!res.ok) {
    res = await typst(dir, ['query', 'map.typ', '<layout>', '--field', 'value', '--one', ...flags]);
  }
  assert(res.ok, res.err);
  return JSON.parse(res.out) as MapLayout;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Does the axis-aligned segment p→q pass through the inside of `r`?
 *  Touching an edge (where arrows start and end) does not count. */
function cutsThrough(p: [number, number], q: [number, number], r: Rect, eps = 0.5): boolean {
  const seg: Rect = {
    x0: Math.min(p[0], q[0]),
    x1: Math.max(p[0], q[0]),
    y0: Math.min(p[1], q[1]),
    y1: Math.max(p[1], q[1]),
  };
  return seg.x0 < r.x1 - eps && seg.x1 > r.x0 + eps && seg.y0 < r.y1 - eps && seg.y1 > r.y0 + eps;
}

/** The promises templates/map.typ makes about any flow, at any `cols`. */
function assertTidyMap(layout: MapLayout, steps: number, label: string): void {
  const w = layout['card-width'];
  const rects: Rect[] = layout.cards.map((c) => ({ x0: c.x, y0: c.y, x1: c.x + w, y1: c.y + c.h }));
  assertEquals(rects.length, steps, `${label}: one card per step`);
  assertEquals(layout.wires.length, Math.max(0, steps - 1), `${label}: one arrow per hop`);

  rects.forEach((r, i) => {
    assert(
      r.x0 >= 0 && r.y0 >= 0 && r.x1 <= layout.width + 0.01 && r.y1 <= layout.height + 0.01,
      `${label}: card ${i + 1} inside the canvas`,
    );
    for (let j = i + 1; j < rects.length; j++) {
      assert(!overlaps(r, rects[j]), `${label}: cards ${i + 1} and ${j + 1} overlap`);
    }
  });

  layout.wires.forEach((wire, hop) => {
    const [from, to] = [rects[hop], rects[hop + 1]];
    const [sx, sy] = wire[0];
    const [ex, ey] = wire[wire.length - 1];
    // Leaves the previous card from its bottom or right edge...
    assert(
      Math.abs(sy - from.y1) < 0.01 || Math.abs(sx - from.x1) < 0.01,
      `${label}: arrow ${hop + 1} start`,
    );
    // ...and lands on the next card's top or left edge, or (top-to-bottom
    // shape) on the top edge of the box that holds the next card.
    const box = layout.boxes[layout.cards[hop + 1].visit];
    assert(
      Math.abs(ey - to.y0) < 0.01 || Math.abs(ex - to.x0) < 0.01 || Math.abs(ey - box.y) < 0.01,
      `${label}: arrow ${hop + 1} end`,
    );
    for (let k = 1; k < wire.length; k++) {
      const [p, q] = [wire[k - 1], wire[k]];
      assert(p[0] === q[0] || p[1] === q[1], `${label}: arrow ${hop + 1} has a diagonal segment`);
      rects.forEach((r, i) =>
        assert(!cutsThrough(p, q, r), `${label}: arrow ${hop + 1} runs through card ${i + 1}`)
      );
    }
  });

  // The route only moves forward: rows never go back up.
  layout.cards.forEach((c, i) =>
    assert(i === 0 || c.row >= layout.cards[i - 1].row, `${label}: row order`)
  );
}

/** `count` single-line code steps cycling through `files`. */
function syntheticFlow(files: string[], count: number): FlowInput {
  return {
    flow: { name: 'Synthetic' },
    matches: Array.from({ length: count }, (_, i) => ({
      match: {
        file_path: `/w/${files[i % files.length]}`,
        repo_relative_file_path: files[i % files.length],
        line_no: i + 1,
        line: `const step${i} = ${i};`,
      },
      step_content: { title: `Step ${i + 1}`, body: i % 2 ? 'A note.' : '' },
    })),
  };
}

// Guard the guards: the geometry checks must be able to fail.
Deno.test('map geometry helpers: detect an overlap and an arrow through a card', () => {
  const card: Rect = { x0: 10, y0: 10, x1: 110, y1: 60 };
  assert(overlaps(card, { x0: 100, y0: 50, x1: 200, y1: 120 }));
  assert(!overlaps(card, { x0: 110, y0: 10, x1: 210, y1: 60 })); // side by side
  assert(cutsThrough([0, 30], [200, 30], card)); // straight through the middle
  assert(cutsThrough([50, 0], [50, 100], card));
  assert(!cutsThrough([0, 30], [10, 30], card)); // stops at the left edge
  assert(!cutsThrough([0, 70], [200, 70], card)); // passes underneath
});

Deno.test({
  name: 'typst: every template compiles cleanly against the fixture',
  ignore: !hasTypst(),
  fn: () =>
    withTypstDir(flow, async (dir) => {
      const builds: [string, string][] = [
        ['flow.typ', 'flow.pdf'],
        ['cards.typ', 'card-{0p}.svg'],
        ['map.typ', 'map.svg'],
      ];
      for (const [template, out] of builds) {
        const res = await typst(dir, ['compile', '--input', 'flow=flow.json', template, out]);
        assert(res.ok, `${template}: ${res.err}`);
        // Typst reports warnings on stderr even when it succeeds.
        assertEquals(res.err.trim(), '', `${template} compiled with warnings`);
      }
      assert((await Deno.stat(`${dir}/map.svg`)).size > 0);
    }),
});

Deno.test({
  name: 'typst map: fixture layout is tidy at every column count and detail level',
  ignore: !hasTypst(),
  fn: () =>
    withTypstDir(flow, async (dir) => {
      // Rows shape, asked for explicitly (the full map defaults to 1 column).
      const base = await mapLayout(dir, ['cols=3']);
      assertEquals(base.cols, 3);
      // Seven visits: six files, with the two revisited-in-a-row files sharing
      // a box each (steps 4+5 and 6+7), plus the trailing note.
      assertEquals(base.boxes.length, 7);
      assertEquals([base.cards[3].visit, base.cards[4].visit], [3, 3]);
      assertEquals(base.boxes[6].file, null);
      assertTidyMap(base, STEPS, 'cols=3');

      for (
        const inputs of [['cols=1'], ['cols=2'], ['cols=5'], ['detail=titles'], [
          'detail=notes',
          'cols=2',
        ]]
      ) {
        assertTidyMap(await mapLayout(dir, inputs), STEPS, inputs.join(' '));
      }
    }),
});

Deno.test({
  name: 'typst map: the full map reads top to bottom by default',
  ignore: !hasTypst(),
  fn: () =>
    withTypstDir(flow, async (dir) => {
      const layout = await mapLayout(dir);
      assertEquals(layout.cols, 1);
      assertTidyMap(layout, STEPS, 'default');

      // One column: every card shares the same left edge...
      assertEquals(new Set(layout.cards.map((c) => c.x)).size, 1);
      // ...each one starts below the end of the one before it...
      layout.cards.forEach((c, i) => {
        const prev = layout.cards[i - 1];
        assert(i === 0 || c.y > prev.y + prev.h, `card ${i + 1} is not below card ${i}`);
      });
      // ...and every arrow is one straight segment pointing down.
      for (const wire of layout.wires) {
        assertEquals(wire.length, 2);
        assertEquals(wire[0][0], wire[1][0]);
        assert(wire[1][1] > wire[0][1]);
      }
      // Taller than wide, as a top-to-bottom strip should be.
      assert(layout.height > layout.width);

      // The lighter detail levels still wrap into rows unless told otherwise.
      assertEquals((await mapLayout(dir, ['detail=titles'])).cols, 4);
      assertEquals((await mapLayout(dir, ['detail=notes'])).cols, 3);
      assertEquals((await mapLayout(dir, ['detail=titles', 'cols=1'])).cols, 1);
    }),
});

Deno.test({
  name: 'typst map: a file the route returns to gets a second box, never a backward arrow',
  ignore: !hasTypst(),
  fn: () =>
    withTypstDir(syntheticFlow(['a.ts', 'b.ts'], 7), async (dir) => {
      const layout = await mapLayout(dir, ['cols=3']);
      // a, b, a, b, a, b, a → seven visits, alternating files.
      assertEquals(layout.boxes.map((b) => b.file), [
        'a.ts',
        'b.ts',
        'a.ts',
        'b.ts',
        'a.ts',
        'b.ts',
        'a.ts',
      ]);
      assertTidyMap(layout, 7, 'revisits');
    }),
});

Deno.test({
  name: 'typst map: empty and single-step flows still compile',
  ignore: !hasTypst(),
  fn: async () => {
    await withTypstDir({ flow: { name: 'Empty' }, matches: [] }, async (dir) => {
      const res = await typst(dir, ['compile', '--input', 'flow=flow.json', 'map.typ', 'map.svg']);
      assert(res.ok, res.err);
    });
    await withTypstDir(syntheticFlow(['a.ts'], 1), async (dir) => {
      assertTidyMap(await mapLayout(dir), 1, 'single');
    });
  },
});

// ── marp deck layout, measured in a real browser (opt-in) ────────────────
//
// The deck's CSS leans on Marp internals: the renamed `pre` element, the
// wrapper that shrinks wide code, the page-number attribute behind the
// badge. The tests above cannot see whether those still line up. This one
// can: it builds a worst-case deck with Marp CLI, loads it in headless
// Chrome, and reads positions back as numbers (see render_deck_measure.js).
// No screenshots, no window.
//
// It starts a browser, so it only runs when asked:
//
//   WAY_DECK_LAYOUT=1 deno task test --filter 'marp layout'
//
// References:
//   • Marp CLI `--template bare` (every slide laid out at once):
//     https://github.com/marp-team/marp-cli#template
//   • Headless Chrome `--dump-dom`: https://developer.chrome.com/docs/chromium/headless

/** One slide's measurements, in slide px. Mirrors render_deck_measure.js. */
type SlideMeasure = {
  page: number;
  pag: string | null;
  total: string | null;
  background: string;
  titleY: number | null;
  badge: { content: string; left: string; top: string; width: string; height: string } | null;
  pager: string;
  bottom: number;
  right: number;
  strays: string[];
  plain: { numbers: string; pad: string }[];
  panel: {
    x: number;
    width: number;
    shrink: number;
    hit: number;
    lines: number;
    lineHeight: number;
    numbers: string;
    numbersLineHeight: string;
    centres: Record<string, number>;
    band: string;
    background: string;
  } | null;
};

/** A Chromium-family browser: `CHROME_PATH`, else the usual macOS installs. */
function findChrome(): string | null {
  const candidates = [
    Deno.env.get('CHROME_PATH') ?? '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const path of candidates) {
    try {
      if (path && Deno.statSync(path).isFile) return path;
    } catch {
      // Not installed here; try the next one.
    }
  }
  return null;
}

/** True only when asked for, and when both Marp CLI and a browser exist. */
function deckLayoutEnabled(): boolean {
  try {
    if (Deno.env.get('WAY_DECK_LAYOUT') !== '1' || findChrome() === null) return false;
    return new Deno.Command('marp', {
      args: ['--version'],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
    }).outputSync().success;
  } catch {
    return false;
  }
}

/** Build `deck` with Marp CLI and measure every slide in headless Chrome. */
async function measureDeck(deck: string): Promise<SlideMeasure[]> {
  const dir = await Deno.makeTempDir({ prefix: 'way-deck-' });
  const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  try {
    await Deno.writeTextFile(`${dir}/deck.md`, deck);
    // stdin is closed on purpose: Marp CLI waits on an open, non-terminal stdin.
    const marp = await new Deno.Command('marp', {
      args: ['deck.md', '--template', 'bare', '-o', 'deck.html'],
      cwd: dir,
      stdin: 'null',
      stdout: 'null',
      stderr: 'piped',
    }).output();
    assert(marp.success, text(marp.stderr));

    const probe = await Deno.readTextFile(new URL('./render_deck_measure.js', import.meta.url));
    const html = await Deno.readTextFile(`${dir}/deck.html`);
    assert(html.includes('</body>'));
    // A function replacer, so `$` in the script is not read as a pattern.
    await Deno.writeTextFile(
      `${dir}/probe.html`,
      html.replace('</body>', () => `<script>${probe}</script></body>`),
    );

    const chrome = await new Deno.Command(findChrome()!, {
      args: [
        '--headless=new',
        // A throwaway profile, so this never touches a Chrome that is open.
        `--user-data-dir=${dir}/profile`,
        '--window-size=1280,800',
        // Let the page's timers run before the DOM is printed.
        '--virtual-time-budget=5000',
        '--dump-dom',
        new URL(`file://${dir}/probe.html`).href,
      ],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
    }).output();
    const dom = text(chrome.stdout);
    const at = dom.lastIndexOf('<pre id="measure">');
    assert(at >= 0, 'the probe wrote no measurements');
    const json = dom.slice(at + '<pre id="measure">'.length, dom.indexOf('</pre>', at));
    // Text nodes are serialised with these three entities; `&` goes last.
    return JSON.parse(
      json.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Every layout promise the deck's CSS makes, checked on one measured slide. */
function assertTidySlide(m: SlideMeasure): void {
  const at = `slide ${m.page}`;
  // Slide px. These mirror the geometry constants at the top of marp.ts:
  // content area 64..1216 wide, 62..668 tall; badge 44 × 44; code line 24.
  assert(m.bottom <= 668.5, `${at}: content runs to y=${m.bottom}, past 668`);
  assert(m.right <= 1216.5, `${at}: content runs to x=${m.right}, past 1216`);
  assertEquals(m.strays, [], `${at}: flow text became an element`);
  for (const block of m.plain) {
    assert(['""', 'none'].includes(block.numbers), `${at}: note code shows ${block.numbers}`);
    assertEquals(block.pad, '20px', `${at}: note code has a gutter`);
  }
  if (m.pag === null) {
    assertEquals(m.badge, null, `${at}: badge on an unnumbered slide`);
  } else {
    assertEquals(m.badge, {
      content: `"${m.pag}"`,
      left: '64px',
      top: '62px',
      width: '44px',
      height: '44px',
    }, `${at}: badge`);
    // The title's first line starts level with the badge.
    assertEquals(m.titleY, 62, `${at}: title`);
    assertEquals(m.pager, `"${m.pag} / ${m.total}"`, `${at}: pager`);
  }
  const p = m.panel;
  if (!p) return;
  assertEquals(p.numbers.slice(1, -1).split('\\a ').length, p.lines, `${at}: one number per line`);
  assertEquals([p.lineHeight, p.numbersLineHeight], [24, '24px'], `${at}: line heights`);
  for (const [line, centre] of Object.entries(p.centres)) {
    // Text row i sits in band i, even when Marp shrank the code.
    assert(Math.abs(centre - (Number(line) + 0.5)) < 0.1, `${at}: line ${line} at ${centre}`);
  }
  assertEquals(p.band.split(', ')[0], `0px ${p.hit * 24}px`, `${at}: highlight band`);
  assert(p.hit >= -1 && p.hit < p.lines, `${at}: highlight on row ${p.hit} of ${p.lines}`);
  // The code fills the panel, edge to edge inside its 1px border.
  assert(Math.abs(p.width - 1150) < 1 && p.x === 65, `${at}: code box x=${p.x} w=${p.width}`);
  assertEquals(p.background, 'rgb(243, 241, 235)', `${at}: panel colour`);
}

Deno.test({
  name: 'marp layout: every slide of a worst-case deck is tidy in a real browser',
  ignore: !deckLayoutEnabled(),
  fn: async () => {
    const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const matches = [
      // Lines far too wide for a slide: Marp shrinks this panel.
      codeStep('Wide lines', 'Short note.', 10, 9990, 4, 170),
      // Note and code that cannot share a slide.
      codeStep(
        'Long note',
        [words(60), '', words(60), '', `- ${words(20)}`].join('\n'),
        40,
        100,
        30,
      ),
      codeStep(`A long title ${words(14)}`, words(30), 30, 1, 0),
      codeStep('Range', '', 25, 500, -1),
      codeStep(
        'Markup <b> [x] *y*',
        'A `code` span, **bold**, <i> and <!-- not a comment -->.',
        33,
        70,
        32,
      ),
      codeStep('Note with code', 'Before.\n\n```sh\necho one\necho two\n```\n\nAfter.', 20, 10, 10),
      { step_content: { title: 'Note only', body: 'No code here.\n\n```sh\necho three\n```' } },
      // Enough steps for three route slides.
      ...Array.from(
        { length: 23 },
        (_, i) => codeStep(`Filler step ${i + 8} ${words(4)}`, 'Note.', 3, 1, 1),
      ),
    ];
    const deck = renderMarp({
      flow: { name: 'Stress "deck" <b>', description: words(20) },
      matches,
    });
    const slides = await measureDeck(deck);

    // title + 3 route + 30 steps, one of them split in two.
    assertEquals(slides.length, 1 + 3 + 30 + 1);
    assertEquals(slides.slice(0, 4).map((m) => m.pag), [null, null, null, null]);
    // The split step shows page 2 twice; the count still ends at 30.
    assertEquals(slides.slice(4, 8).map((m) => m.pag), ['1', '2', '2', '3']);
    assertEquals([slides.at(-1)?.pag, slides.at(-1)?.total], ['30', '30']);
    assertEquals(slides[0].background, 'rgb(250, 249, 246)');
    // The probe really saw the hard cases, so the checks below are not empty.
    assert(slides[4].panel && slides[4].panel.shrink < 0.9, 'wide code was shrunk');
    assertEquals(slides.filter((m) => m.plain.length > 0).length, 2);
    assertEquals(slides.filter((m) => m.panel).length, 29);

    slides.forEach(assertTidySlide);
  },
});

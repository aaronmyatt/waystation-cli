// ──────────────────────────────────────────────────────────────────────────
// Render a flow as a CodeTour `.tour` file.
//
// CodeTour is a VS Code extension that replays a guided walkthrough inside
// the editor: each step opens a file at a line and shows a comment. Dropping
// the output into a repo's `.tours/` folder makes the flow replayable for
// anyone with the extension, no Waystation install needed.
//
// Mapping:
//   • code step, single line → { file, line }
//   • code step, range       → { file, line: <end>, selection: start..end }
//   • note-only step         → "content step" (title + description, no file)
//   • flow commit            → tour-level `ref`, which pins the tour to the
//                              commit the line numbers were captured at
//
// References:
//   • Tour schema: https://aka.ms/codetour-schema
//   • Tour files and step types:
//     https://github.com/microsoft/codetour#tour-files
// ──────────────────────────────────────────────────────────────────────────

import { normalize } from './_shared.ts';
import type { FlowInput } from './_shared.ts';

/** Options for {@linkcode renderCodeTour}. */
export type CodeTourOptions = {
  /** Pin the tour to the flow's commit via `ref`. Default true. Turn off to
   *  let the tour follow whatever is checked out (lines may drift). */
  pinRef?: boolean;
};

/** One step in a `.tour` file (the subset this renderer emits). */
export type TourStep = {
  title: string;
  description: string;
  file?: string;
  line?: number;
  selection?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
};

/** A `.tour` document. */
export type Tour = {
  $schema: string;
  title: string;
  description?: string;
  ref?: string;
  steps: TourStep[];
};

/** Build the tour object. Split from stringifying so tests can assert on it. */
export function buildCodeTour(input: FlowInput, opts: CodeTourOptions = {}): Tour {
  const flow = normalize(input);
  const steps: TourStep[] = flow.steps.map((s) => {
    // CodeTour shows the description as markdown; an empty one renders as a
    // blank comment box, so fall back to the title.
    const step: TourStep = { title: s.title, description: s.body || s.title };
    if (!s.file || s.line === null) return step;
    step.file = s.file;
    if (s.endLine === null) {
      step.line = s.line;
      return step;
    }
    // Range capture: select the whole range and anchor the comment under its
    // last line. Positions are 1-based; `end.character` sits just past the
    // last character of the final line.
    const lastLine = s.lines[s.lines.length - 1] ?? '';
    step.line = s.endLine;
    step.selection = {
      start: { line: s.line, character: 1 },
      end: { line: s.endLine, character: lastLine.length + 1 },
    };
    return step;
  });

  // Spread conditionally so the keys come out in reading order
  // (title, description, ref, steps) and absent ones are omitted entirely.
  return {
    $schema: 'https://aka.ms/codetour-schema',
    title: flow.name,
    ...(flow.description ? { description: flow.description } : {}),
    ...((opts.pinRef ?? true) && flow.commit ? { ref: flow.commit } : {}),
    steps,
  };
}

/** Render an aggregate as `.tour` JSON text. */
export function renderCodeTour(input: FlowInput, opts: CodeTourOptions = {}): string {
  return JSON.stringify(buildCodeTour(input, opts), null, 2) + '\n';
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { buildCodeTour, renderCodeTour } from './scripts/render/codetour.ts';
//
// // 1. Note-only step → content step (no `file`)
// buildCodeTour({ flow: { name: 'Demo' }, matches: [
//   { step_content: { title: 'Intro', body: 'Hello' } },
// ] }).steps[0]; // → { title: 'Intro', description: 'Hello' }
//
// // 2. Code step → file + line
// buildCodeTour({ matches: [{ match: {
//   file_path: '/w/a.ts', repo_relative_file_path: 'a.ts', line_no: 7, line: 'x',
// } }] }).steps[0]; // → { title: 'a.ts:7', description: 'a.ts:7', file: 'a.ts', line: 7 }
//
// // 3. Save where the extension looks for tours
// // deno run --allow-read scripts/render/render.ts codetour flow.json > .tours/my-flow.tour

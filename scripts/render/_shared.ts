// ──────────────────────────────────────────────────────────────────────────
// Shared helpers for the render scripts: input parsing + small text helpers.
//
// The reshaping of a flow (unpacking `grep_meta`, telling ranges from single
// lines, building permalinks, parsing note markdown) is NOT here. It lives
// once, in src/flows/view.ts, which is also what `way export --json` prints.
// This file re-exports it under the names the renderers have always used:
//
//   normalize  = toFlowView        NormFlow = FlowView      Step  = StepView
//   FlowInput  = FlowViewInput     Block    = NoteBlock     Span  = NoteSpan
//
// Still runtime-agnostic: src/flows/view.ts is pure and import-free, so this
// runs unchanged on Deno, Node (native type stripping) and Bun.
//
// References:
//   • Node type stripping (why imports use `.ts` + `import type`):
//     https://nodejs.org/api/typescript.html#type-stripping
//   • Re-exporting under another name:
//     https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/export#re-exporting_aggregating
// ──────────────────────────────────────────────────────────────────────────

import type { FlowViewInput } from '../../src/flows/view.ts';

export { parseBlocks, parseInline, toFlowView as normalize } from '../../src/flows/view.ts';
export type {
  FlowView as NormFlow,
  FlowViewInput as FlowInput,
  MatchViewInput as MatchInput,
  NoteBlock as Block,
  NoteSpan as Span,
  StepView as Step,
  StepViewInput as StepInput,
} from '../../src/flows/view.ts';

// ── Input parsing ────────────────────────────────────────────────────────

/**
 * Accept either aggregate JSON (`way show <flow> --json`) or the markdown
 * emitted by `way export <flow> --frontmatter`, whose frontmatter carries the
 * whole aggregate on a single `flow: {...}` line (see addFrontmatter in
 * src/flows/markdown.ts).
 */
export function parseInput(text: string): FlowViewInput {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('---')) return JSON.parse(trimmed) as FlowViewInput;
  for (const line of trimmed.split(/\r?\n/).slice(1)) {
    if (line.startsWith('---')) break;
    if (line.startsWith('flow: ')) return JSON.parse(line.slice('flow: '.length)) as FlowViewInput;
  }
  throw new Error('parseInput: frontmatter has no `flow:` line (use `way export --frontmatter`)');
}

// ── Small helpers shared by renderers ────────────────────────────────────

/** Escape text for HTML element content and double-quoted attributes.
 *  Ref: https://html.spec.whatwg.org/multipage/syntax.html#escapingString */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** File-name-safe slug: `How way export…` → `how-way-export`. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) ||
    'flow';
}

/** `3 steps` / `1 step`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { normalize, parseInput, slugify } from './scripts/render/_shared.ts';
//
// // 1. `normalize` is src/flows/view.ts's toFlowView
// normalize({ flow: { name: 'Demo' }, matches: [{ step_content: { title: 'Hi', body: 'A `b`' } }] });
//
// // 2. Frontmatter input
// parseInput('---\nflow: {"flow":{"name":"X"},"matches":[]}\n---\n# X');
//
// // 3. File-name slug
// slugify('How way export renders a flow'); // → 'how-way-export-renders-a-flow'

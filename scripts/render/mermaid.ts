// ──────────────────────────────────────────────────────────────────────────
// Render a flow as a Mermaid flowchart: the route as a map.
//
// Each step is a node, numbered in visit order. Steps are boxed by file, so
// a file visited twice shows both stops in one box with the route threading
// in and out. Note-only steps sit outside the boxes as rounded nodes.
//
// GitHub renders ```mermaid fences natively, so the output drops straight
// into a README, issue, or PR body.
//
// References:
//   • Flowchart syntax (subgraphs, shapes, click): https://mermaid.js.org/syntax/flowchart.html
//   • Entity codes for escaping label text:
//     https://mermaid.js.org/syntax/flowchart.html#entity-codes-to-escape-characters
//   • GitHub rendering: https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams
// ──────────────────────────────────────────────────────────────────────────

import { normalize } from './_shared.ts';
import type { FlowInput, Step } from './_shared.ts';

/** Options for {@linkcode renderMermaid}. */
export type MermaidOptions = {
  /** `TD` top-down (default) or `LR` left-to-right. */
  direction?: 'TD' | 'LR';
  /** Emit `click` lines linking nodes to GitHub. Default true. GitHub's own
   *  renderer ignores them (strict security level); other viewers honour them. */
  links?: boolean;
  /** Wrap the diagram in a ```mermaid fence for pasting into markdown. */
  fenced?: boolean;
};

/**
 * Escape text for use inside a quoted Mermaid label. Mermaid has no
 * backslash escapes; it uses `#name;` / `#NN;` entity codes instead. `#`
 * itself goes first so later replacements aren't double-escaped.
 */
export function escapeLabel(text: string): string {
  return text
    .replace(/#/g, '#35;')
    .replace(/&/g, '#amp;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;');
}

function nodeLine(step: Step): string {
  const title = `${step.n} · ${escapeLabel(step.title)}`;
  if (!step.file) return `s${step.n}(["${title}"])`;
  const lines = step.endLine ? `L${step.line}-${step.endLine}` : `L${step.line}`;
  return `s${step.n}["${title}<br/>${lines}"]`;
}

/** Render an aggregate as Mermaid flowchart source. */
export function renderMermaid(input: FlowInput, opts: MermaidOptions = {}): string {
  const flow = normalize(input);
  const out: string[] = [
    // `%%` starts a comment line. Keep the title on one line.
    `%% Waystation flow: ${flow.name.replace(/\s+/g, ' ')}`,
    `flowchart ${opts.direction ?? 'TD'}`,
  ];

  // One subgraph per file, in first-visit order.
  flow.files.forEach((file, i) => {
    out.push(`  subgraph f${i + 1}["${escapeLabel(file)}"]`);
    for (const s of flow.steps) if (s.file === file) out.push(`    ${nodeLine(s)}`);
    out.push('  end');
  });
  for (const s of flow.steps) if (!s.file) out.push(`  ${nodeLine(s)}`);

  // The route itself: consecutive steps, in order.
  for (let i = 1; i < flow.steps.length; i++) out.push(`  s${i} --> s${i + 1}`);

  if (opts.links ?? true) {
    for (const s of flow.steps) if (s.url) out.push(`  click s${s.n} href "${s.url}" _blank`);
  }

  const diagram = out.join('\n') + '\n';
  return opts.fenced ? '```mermaid\n' + diagram + '```\n' : diagram;
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { escapeLabel, renderMermaid } from './scripts/render/mermaid.ts';
//
// // 1. Two steps in one file → one subgraph, one edge
// const step = (line_no: number, title: string) => ({
//   match: { file_path: '/w/a.ts', repo_relative_file_path: 'a.ts', line_no, line: 'x' },
//   step_content: { title },
// });
// console.log(renderMermaid({ flow: { name: 'Demo' }, matches: [step(3, 'Start'), step(9, 'End')] }));
// // flowchart TD
// //   subgraph f1["a.ts"]
// //     s1["1 · Start<br/>L3"]
// //     s2["2 · End<br/>L9"]
// //   end
// //   s1 --> s2
//
// // 2. Quotes and angle brackets can't break out of a label
// escapeLabel('say "hi" <b>'); // → 'say #quot;hi#quot; #lt;b#gt;'
//
// // 3. Ready to paste into a GitHub comment
// renderMermaid({ flow: { name: 'Demo' }, matches: [] }, { fenced: true });
//
// // 4. Render to SVG with the Mermaid CLI (https://github.com/mermaid-js/mermaid-cli)
// // mmdc -i flow.mmd -o flow.svg -b transparent

// ──────────────────────────────────────────────────────────────────────────
// Pipeline: build a flow aggregate and render it as Markdown (with
// optional frontmatter).
//
// Composition pattern: pipelines are themselves usable as stages, because
// `Pipeline.process` matches the `Stage` signature `(input) => Promise<input>`.
// We therefore inline `buildFlowAggregate.process` as the first stage and
// then render on top of it.
// ──────────────────────────────────────────────────────────────────────────

import { Pipeline } from '../vendor/pipeline.ts';
import type { FlowAggregate } from '../types.ts';
import {
  buildFlowAggregate,
  type AggCtx,
} from './buildFlowAggregate.ts';
import { addFrontmatter, generateFlowMarkdown, type RenderOptions } from '../flows/markdown.ts';

export type ExportCtx = AggCtx & {
  /** Render options forwarded to the markdown generator. */
  render?: RenderOptions;
  /** Prepend a frontmatter block to the markdown body. */
  frontmatter?: boolean;
  /** Output markdown — populated by the last stage. */
  markdown?: string;
};

/** Stage: delegate to the aggregate builder. */
async function loadAggregate(ctx: ExportCtx): Promise<ExportCtx> {
  // Re-running .process gives us back the same shape; spread into ctx so
  // downstream stages see both the export inputs and the aggregate fields.
  const aggCtx = await buildFlowAggregate.process({ flowId: ctx.flowId });
  return { ...ctx, ...aggCtx };
}

/** Stage: produce the markdown body. */
async function renderMarkdownBody(ctx: ExportCtx): Promise<ExportCtx> {
  const body = generateFlowMarkdown(ctx.aggregate as FlowAggregate, ctx.render ?? {});
  return { ...ctx, markdown: body };
}

/** Stage: optionally prepend a frontmatter block. */
async function maybeApplyFrontmatter(ctx: ExportCtx): Promise<ExportCtx> {
  if (!ctx.frontmatter) return ctx;
  const fm = addFrontmatter(ctx.aggregate as FlowAggregate);
  return { ...ctx, markdown: `${fm}\n${ctx.markdown ?? ''}` };
}

export const exportMarkdown: Pipeline<ExportCtx> = new Pipeline<ExportCtx>()
  .pipe(loadAggregate)
  .pipe(renderMarkdownBody)
  .pipe(maybeApplyFrontmatter);

// ── REPL examples ────────────────────────────────────────────────────────
// import { exportMarkdown } from './pipelines/exportMarkdown.ts';
//
// // 1. Plain body
// const { markdown } = await exportMarkdown.process({ flowId: 'f1' });
//
// // 2. With frontmatter, export-style links
// await exportMarkdown.process({
//   flowId: 'f1', frontmatter: true, render: { export: true },
// });
//
// // 3. With a workspace root for relative file paths
// await exportMarkdown.process({
//   flowId: 'f1', render: { workspaceRoot: Deno.cwd() },
// });

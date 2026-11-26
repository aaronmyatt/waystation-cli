// ──────────────────────────────────────────────────────────────────────────
// Pipeline: build a flow aggregate and export it as render-ready JSON.
//
//   { flowId }  →  loadAggregate  →  buildView  →  serializeView  →  { json }
//
// The aggregate is the stored rows; the view is those rows flattened into
// what a renderer needs (see flows/view.ts). `way export <flow> --json`
// prints `json`, so an HTML page, a slide deck or a PDF can be built from a
// flow by a script that knows nothing about the database.
//
// Same composition pattern as exportMarkdown: `buildFlowAggregate.process`
// is inlined as the first stage and the rest builds on top of it.
// ──────────────────────────────────────────────────────────────────────────

import { Pipeline } from '../vendor/pipeline.ts';
import { type AggCtx, buildFlowAggregate } from './buildFlowAggregate.ts';
import { type FlowView, toFlowView } from '../flows/view.ts';

export type ExportJsonCtx = AggCtx & {
  /** The flow, flattened for rendering — populated by `buildView`. */
  view?: FlowView;
  /** `view` as indented JSON, no trailing newline — populated by the last stage. */
  json?: string;
};

/** Stage: delegate to the aggregate builder. */
async function loadAggregate(ctx: ExportJsonCtx): Promise<ExportJsonCtx> {
  const aggCtx = await buildFlowAggregate.process({ flowId: ctx.flowId });
  return { ...ctx, ...aggCtx };
}

/** Stage: flatten the aggregate into the view. All the reshaping is here. */
async function buildView(ctx: ExportJsonCtx): Promise<ExportJsonCtx> {
  if (!ctx.aggregate) throw new Error(`exportJson: no aggregate for flow ${ctx.flowId}`);
  return { ...ctx, view: toFlowView(ctx.aggregate) };
}

/** Stage: serialise the view. Two-space indent, like `way show --json`. */
async function serializeView(ctx: ExportJsonCtx): Promise<ExportJsonCtx> {
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#space
  return { ...ctx, json: JSON.stringify(ctx.view, null, 2) };
}

export const exportJson: Pipeline<ExportJsonCtx> = new Pipeline<ExportJsonCtx>()
  .pipe(loadAggregate)
  .pipe(buildView)
  .pipe(serializeView);

// ── REPL examples ────────────────────────────────────────────────────────
// import { exportJson } from './pipelines/exportJson.ts';
//
// // 1. The view as an object
// const { view } = await exportJson.process({ flowId: 'f1' });
// view?.steps.map((s) => s.ref); // → ['src/cli.ts:116-124', …]
//
// // 2. The same thing as text, ready to print or save
// const { json } = await exportJson.process({ flowId: 'f1' });
// JSON.parse(json!).name;
//
// // 3. From the CLI
// // way export "my flow" --json | jq '.steps[] | {n, title, ref, hitIndex}'

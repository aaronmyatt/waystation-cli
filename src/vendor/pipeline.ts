// ──────────────────────────────────────────────────────────────────────────
// Vendored sequential async pipeline executor.
//
// Source: https://github.com/aaronmyatt/pdPipe/blob/main/pipeline.ts (MIT)
// Dropped in verbatim, with one cosmetic change: the upstream file imports
// `Stage` and `Input` from a sibling `pipedown.d.ts`; here we inline minimal
// equivalents so the file is self-contained (no Pipedown runtime required).
//
// Why vendored:
//   • Keeps `@waystation/core` zero-runtime-dep.
//   • Lets us specialise the Stage signature for the way the waystation core
//     uses it (single-arg, returns its updated context).
//
// The library's two primitives — `Pipeline.pipe(stage)` to append, and
// `Pipeline.process(input)` to execute — are the *orchestration medium* for
// every multi-step DB workflow in this package (init, save-match, build-
// aggregate, export-markdown). See ../pipelines/ for usage.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Minimal Input constraint — pipeline contexts must be plain objects so
 * `Object.assign(defaults, input)` is well-defined. Caller refines `I` to a
 * specific context type.
 */
export type Input = Record<string, unknown> & object;

/**
 * A single pipeline stage: receives the running context and returns it
 * (optionally async). Stages mutate or return a fresh context — both forms
 * compose via `.then(stage)` in the reducer below.
 *
 * The upstream pdPipe `Stage` signature includes a second `opts: Pipe`
 * parameter for cross-stage utilities; that channel is unused by the
 * pipeline driver itself (see `process()` below — stages are invoked with a
 * single arg via `.then(stage)`), and waystation-core doesn't need it, so we
 * elide it here for simplicity.
 */
export type Stage<T> = (input: T) => Promise<T> | T;

/**
 * Sequential async pipeline executor.
 *
 * Chains stages via promise resolution, passing each stage's output as the
 * next stage's input. Stages are executed in order and can be appended
 * dynamically with {@linkcode Pipeline.pipe}.
 *
 * @typeParam I - The context type flowing through the pipeline.
 *
 * @example
 *   type Ctx = { n: number };
 *   const pl = new Pipeline<Ctx>()
 *     .pipe(async (c) => ({ ...c, n: c.n + 1 }))
 *     .pipe(async (c) => ({ ...c, n: c.n * 2 }));
 *   await pl.process({ n: 3 });   // → { n: 8 }
 */
export class Pipeline<I extends Input> {
  /** The ordered list of stages to execute. */
  stages: Stage<I>[] = [];
  /** Default values merged into the input at `process` time (input wins). */
  defaultArgs: Partial<I> = {};

  /**
   * @param presetStages - Initial stages to seed the pipeline with.
   * @param defaultArgs - Defaults merged into the input at `process` time.
   *                      Input keys override defaults.
   */
  constructor(presetStages: Stage<I>[] = [], defaultArgs: Partial<I> = {}) {
    this.defaultArgs = defaultArgs;
    this.stages = presetStages || [];
  }

  /**
   * Append a stage to the pipeline.
   * @returns `this` for chaining.
   */
  pipe(stage: Stage<I>): Pipeline<I> {
    this.stages.push(stage);
    return this;
  }

  /**
   * Execute all stages sequentially, threading the input through each.
   *
   * @param args - The initial context object.
   * @returns The context object after all stages have applied.
   */
  process(args: I): Promise<I> {
    // Merge defaults first, then input — input wins on key collisions. The
    // upstream signature uses `Object.assign({}, defaults, args)` exactly so
    // callers can supply partial inputs and rely on configured defaults.
    args = Object.assign({}, this.defaultArgs, args) as I;

    if (this.stages.length === 0) {
      return Promise.resolve(args);
    }

    // Fold stages into a single promise chain:
    //   Promise.resolve(args).then(stage1).then(stage2)...then(stageN)
    // Each .then handles both sync-returning and async-returning stages.
    return this.stages.reduce(
      (chain, stage) => chain.then(stage),
      Promise.resolve(args) as Promise<I>,
    );
  }
}

export default Pipeline;

// ── REPL examples ────────────────────────────────────────────────────────
// import { Pipeline } from './vendor/pipeline.ts';
//
// // 1. Trivial sync stages
// type N = { n: number };
// await new Pipeline<N>()
//   .pipe((c) => ({ ...c, n: c.n + 1 }))
//   .pipe((c) => ({ ...c, n: c.n * 10 }))
//   .process({ n: 4 });                         // → { n: 50 }
//
// // 2. Async stage with side-effects (mutation pattern)
// type Ctx = { db: string; rows?: number };
// await new Pipeline<Ctx>()
//   .pipe(async (c) => { c.rows = 0; return c; })
//   .pipe(async (c) => { c.rows!++; return c; })
//   .process({ db: ':memory:' });               // → { db: ':memory:', rows: 1 }
//
// // 3. defaultArgs merge
// const pl = new Pipeline<{ verbose?: boolean; n: number }>([], { verbose: false });
// await pl.pipe((c) => c).process({ n: 1 });   // → { verbose: false, n: 1 }

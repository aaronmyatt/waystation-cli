// Smoke tests for the vendored Pipeline: ordering, async stages, default
// args merge, and the empty-pipeline identity.

import { assertEquals } from '@std/assert';
import { Pipeline } from '../src/vendor/pipeline.ts';

Deno.test('Pipeline runs stages in order, threading the context', async () => {
  type Ctx = { n: number };
  const pl = new Pipeline<Ctx>()
    .pipe((c) => ({ ...c, n: c.n + 1 }))
    .pipe(async (c) => ({ ...c, n: c.n * 10 }))
    .pipe((c) => ({ ...c, n: c.n - 3 }));
  const out = await pl.process({ n: 4 });
  // (4+1)*10 - 3 = 47
  assertEquals(out.n, 47);
});

Deno.test('Pipeline.process merges defaultArgs (input wins on collisions)', async () => {
  type Ctx = { verbose?: boolean; n: number };
  const pl = new Pipeline<Ctx>([], { verbose: false });
  pl.pipe((c) => c);
  const out = await pl.process({ n: 1 });
  assertEquals(out, { verbose: false, n: 1 });

  const out2 = await pl.process({ n: 2, verbose: true });
  assertEquals(out2.verbose, true);
});

Deno.test('Empty Pipeline returns its input unchanged', async () => {
  type Ctx = { a: number };
  const out = await new Pipeline<Ctx>().process({ a: 5 });
  assertEquals(out, { a: 5 });
});

Deno.test("Pipelines compose: one pipeline used as another's stage", async () => {
  type Ctx = { n: number };
  const inner = new Pipeline<Ctx>()
    .pipe((c) => ({ ...c, n: c.n + 1 }))
    .pipe((c) => ({ ...c, n: c.n + 1 }));
  const outer = new Pipeline<Ctx>()
    .pipe((c) => inner.process(c))
    .pipe((c) => ({ ...c, n: c.n * 2 }));
  const out = await outer.process({ n: 3 });
  // 3 + 1 + 1 → 5; 5 * 2 → 10
  assertEquals(out.n, 10);
});

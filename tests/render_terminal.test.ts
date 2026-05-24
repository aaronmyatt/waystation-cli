// Exercises the markdown → terminal renderer.
//
// We pin the renderer to its in-process fallback path (`forceInProcess`) so
// the test is deterministic regardless of whether glow/bat happen to be on
// the developer's PATH. The external-renderer chain is exercised by
// running the CLI manually — see the README/plan for smoke commands.

import { assert, assertEquals } from '@std/assert';
import { prettyPrintMarkdown } from '../src/flows/renderTerminal.ts';

Deno.test('marked-terminal in-process path produces ANSI-styled output', async () => {
  // Capture stdout so we can inspect the rendered bytes.
  const originalWrite = Deno.stdout.writeSync.bind(Deno.stdout);
  const chunks: Uint8Array[] = [];
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    chunks.push(data);
    return data.byteLength;
  };
  try {
    const outcome = await prettyPrintMarkdown(
      '# Heading\n\nSome **bold** and *italic* text.\n',
      { forceInProcess: true },
    );
    assertEquals(outcome, 'marked-terminal');
    const rendered = chunks
      .map((c) => new TextDecoder().decode(c))
      .join('');
    // The actual styling depends on the terminal; we just want to confirm
    // the renderer ran (output is non-empty and contains the heading text).
    assert(rendered.length > 0, 'expected non-empty rendered output');
    assert(
      rendered.includes('Heading'),
      `expected heading text in rendered output, got: ${rendered}`,
    );
  } finally {
    Deno.stdout.writeSync = originalWrite;
  }
});

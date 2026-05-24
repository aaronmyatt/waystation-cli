// ──────────────────────────────────────────────────────────────────────────
// `way export <flowId> [--out file.md] [--frontmatter] [--no-export-links]
//                       [--pretty]`
//
// Defaults to raw markdown (suitable for piping or saving). `--pretty`
// renders through the glow/bat/marked-terminal fallback chain — mutually
// exclusive with `--out` (ANSI escape codes don't belong in a `.md` file).
// ──────────────────────────────────────────────────────────────────────────

import { initializeCli } from '../db/sqlite.ts';
import { exportMarkdown } from '../pipelines/exportMarkdown.ts';
import { prettyPrintMarkdown } from '../flows/renderTerminal.ts';
import { defaultDbPath } from './_common.ts';

export async function exportCommand(
  flowId: string,
  opts: {
    dbPath?: string;
    out?: string;
    frontmatter?: boolean;
    exportLinks?: boolean;
    pretty?: boolean;
  },
): Promise<void> {
  if (!flowId) throw new Error('export: missing <flowId> argument');
  if (opts.pretty && opts.out) {
    throw new Error(
      'export: --pretty cannot be combined with --out (ANSI escapes are not portable).',
    );
  }
  await initializeCli(opts.dbPath ?? defaultDbPath());

  const { markdown } = await exportMarkdown.process({
    flowId,
    frontmatter: opts.frontmatter ?? false,
    render: {
      // Default to export-style GitHub permalinks; `--no-export-links` flips it.
      export: opts.exportLinks ?? true,
      // When piping to a terminal renderer, drop inline link URLs so glow
      // doesn't have to wrap them. The path is preserved in the grep_meta
      // line below each heading. For file/stdout output we keep them —
      // GitHub & file viewers benefit from the links.
      noInlineLinks: opts.pretty ?? false,
    },
  });

  if (opts.out) {
    await Deno.writeTextFile(opts.out, markdown ?? '');
    console.log(`Wrote ${opts.out}`);
    return;
  }

  if (opts.pretty) {
    await prettyPrintMarkdown(markdown ?? '');
    return;
  }

  console.log(markdown ?? '');
}

// ──────────────────────────────────────────────────────────────────────────
// `way export <flowId> [--out file.md] [--frontmatter] [--no-export-links]
//                       [--pretty]`
// `way export <flowId> --json [--out file.json]`
//
// Defaults to raw markdown (suitable for piping or saving). `--pretty`
// renders through the glow/bat/marked-terminal fallback chain — mutually
// exclusive with `--out` (ANSI escape codes don't belong in a `.md` file).
//
// `--json` prints the flow as render-ready JSON instead: the flattened view
// from flows/view.ts, for scripts that turn a flow into HTML, slides or a
// PDF. It is a different output, not a variant of the Markdown one, so the
// Markdown-only flags are refused alongside it rather than silently ignored.
// ──────────────────────────────────────────────────────────────────────────

import { initializeCli } from '../db/sqlite.ts';
import { resolveFlowId } from '../flows/crud.ts';
import { exportJson } from '../pipelines/exportJson.ts';
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
    json?: boolean;
  },
): Promise<void> {
  if (!flowId) throw new Error('export: missing <flowId> argument');
  if (opts.json && (opts.pretty || opts.frontmatter || opts.exportLinks === false)) {
    throw new Error(
      'export: --json cannot be combined with --pretty, --frontmatter or --no-export-links ' +
        '(those shape the Markdown output).',
    );
  }
  if (opts.pretty && opts.out) {
    throw new Error(
      'export: --pretty cannot be combined with --out (ANSI escapes are not portable).',
    );
  }
  await initializeCli(opts.dbPath ?? defaultDbPath());

  // Resolve the user-supplied argument to a concrete flow id.
  // Handles both raw UUIDs and partial name substrings — same resolver
  // that `way show` uses, so `way export "TASK-161"` works identically.
  flowId = await resolveFlowId(flowId);

  if (opts.json) {
    const { json } = await exportJson.process({ flowId });
    if (opts.out) {
      await Deno.writeTextFile(opts.out, `${json ?? ''}\n`);
      console.log(`Wrote ${opts.out}`);
      return;
    }
    console.log(json ?? '');
    return;
  }

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

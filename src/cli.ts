#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
// ──────────────────────────────────────────────────────────────────────────
// `way` CLI entry point.
//
// Uses `@std/cli`'s `parseArgs` to dispatch to one of:
//   way init                                Bootstrap the local SQLite DB.
//   way list                                Print all non-archived flows.
//   way show   <flowId>                     Pretty-print a flow aggregate.
//   way export <flowId> [--out FILE] [--frontmatter] [--no-export-links]
//                                           Render a flow as Markdown.
//   way add    <path>:<line>[:<endLine>]    Capture a code line into a flow.
//              [--flow ID] [--local-only]
//   way sync                                (stub)
//
// Top-level flags (apply to every subcommand):
//   --db <path>      Override $HOME/.waystation/way.db.
//   --verbose, -v    Echo logger lines.
//   --version, -V    Print version from deno.json and exit.
//   --help, -h       Print usage and exit.
//
// Reference: https://jsr.io/@std/cli/doc/parse-args
// ──────────────────────────────────────────────────────────────────────────

import { parseArgs } from '@std/cli/parse-args';
import { initCommand } from './commands/init.ts';
import { listCommand } from './commands/list.ts';
import { showCommand } from './commands/show.ts';
import { exportCommand } from './commands/export.ts';
import { addCommand } from './commands/add.ts';
import { syncCommand } from './commands/sync.ts';
import { renameCommand } from './commands/rename.ts';

const USAGE = `way — waystation CLI

USAGE
  way <command> [options]

COMMANDS
  init                                Initialise the local SQLite database.
  list                                Print all flows.
  show   <flowId>                     Render the flow via glow/bat/marked-terminal.
         [--raw] [--json]               --raw: structured fields; --json: aggregate JSON.
  export <flowId> [--out FILE]        Render a flow as Markdown to stdout/file.
         [--frontmatter]                Include YAML+JSON frontmatter block.
         [--no-export-links]            Suppress GitHub permalinks.
         [--pretty]                     Pipe through glow/bat/marked-terminal (no --out).
  add    <path>:<line>[:<endLine>]    Capture a line as a new step.
         [--flow ID] [--local-only]
         [--title STR] [--desc STR]     Attach a heading & description.
  rename <flowId> <newTitle>          Give a flow a meaningful name.
  sync                                (not yet implemented)

GLOBAL OPTIONS
  --db   <path>     Use a non-default database file.
  -v, --verbose     Echo internal log lines.
  -V, --version     Print version and exit.
  -h, --help        Show this help.
`;

async function main(): Promise<void> {
  // `negatable` enables the `--no-<flag>` form. We use that for export-links
  // so a default-on flag can still be flipped off without flag-name gymnastics.
  // See: https://jsr.io/@std/cli/doc/parse-args
  const args = parseArgs(Deno.args, {
    boolean: [
      'help',
      'verbose',
      'frontmatter',
      'export-links',
      'json',
      'raw',
      'pretty',
      'local-only',
      'version',
    ],
    string: ['db', 'out', 'flow', 'title', 'desc'],
    alias: { h: 'help', v: 'verbose', V: 'version' },
    negatable: ['export-links'],
    default: { 'export-links': true },
  });

  // --version / -V: print version from deno.json and exit cleanly.
  // Tooling (installers, CI scripts, the next-ticket skill) needs a zero-exit
  // probe to confirm the binary is the right version without parsing --help.
  if (args.version) {
    // Read the version from the project manifest. Using JSON.parse is safe
    // because deno.json is standard JSON (Deno reserves .jsonc for comments).
    const configText = await Deno.readTextFile(
      new URL('../deno.json', import.meta.url),
    );
    const config = JSON.parse(configText);
    console.log(config.version ?? 'unknown');
    Deno.exit(0);
  }

  if (args.help || args._.length === 0) {
    console.log(USAGE);
    Deno.exit(args.help ? 0 : 1);
  }

  const [cmd, ...rest] = args._ as string[];
  const common = { dbPath: args.db, verbose: args.verbose };

  try {
    switch (cmd) {
      case 'init':
        await initCommand(common);
        break;
      case 'list':
        await listCommand(common);
        break;
      case 'show':
        await showCommand(rest[0], { ...common, json: args.json, raw: args.raw });
        break;
      case 'export':
        await exportCommand(rest[0], {
          ...common,
          out: args.out,
          frontmatter: args.frontmatter,
          exportLinks: args['export-links'],
          pretty: args.pretty,
        });
        break;
      case 'add':
        await addCommand(rest[0], {
          ...common,
          flow: args.flow,
          localOnly: args['local-only'],
          title: args.title,
          desc: args.desc,
        });
        break;
      case 'rename':
        await renameCommand(rest[0], rest.slice(1).join(' '), common);
        break;
      case 'sync':
        syncCommand();
        break;
      default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(USAGE);
        Deno.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    if (args.verbose && err instanceof Error && err.stack) console.error(err.stack);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}

# waystation-cli (`@waystation/core`)

> Capture the route you took through a codebase, replay it later.

`waystation-cli` is a small Deno/TypeScript toolkit for building **flows** —
ordered collections of code references, notes, screenshots, and links that
trace a journey through a codebase. It ships as two things in one package:

1. A `way` command-line tool (`src/cli.ts`) backed by a local SQLite database.
2. A library (`@waystation/core`, `src/mod.ts`) that the
   [waystation VS Code extension](https://github.com/) and a future
   agentic-session runner consume to build, read, and render the same flows.

The data model and pipeline primitives are deliberately tiny so they can be
embedded anywhere a Deno or Node runtime can reach.

---

## Why it exists

When you're tracing a bug, learning an unfamiliar codebase, or preparing to
hand off work, the *path* you walked through the code is often more valuable
than any single file you ended on. A waystation is the saved form of that
path: a sequence of `file:line` captures, interleaved with your own notes,
that can later be rendered to Markdown (for a PR, a doc, or an LLM prompt) or
re-opened inside the VS Code extension.

---

## Status

Pre-1.0 (`v0.0.1`). The schema, CLI surface, and library exports are still
moving. The `way sync` command is currently a stub.

---

## Requirements

- [Deno](https://deno.com) v1.45+ (uses [JSR](https://jsr.io) imports).
- A `sqlite3` binary on `$PATH`. The DB driver shells out to it rather than
  linking native SQLite, which keeps the package zero-native-dep on every
  platform Deno supports. Verify with `sqlite3 --version`.
- A POSIX-ish environment for `git` discovery (Linux, macOS, WSL).

Optional, for `way show --pretty` / `way export --pretty`:

- [`glow`](https://github.com/charmbracelet/glow), [`bat`](https://github.com/sharkdp/bat),
  or fall through to the bundled `marked-terminal` renderer.

---

## Install

### As a CLI (`way`)

```sh
# from the repo root
deno task install     # installs `way` globally via `deno install`
```

That runs:

```sh
deno install --global --force --config deno.json -n way \
  --allow-read --allow-write --allow-env --allow-run \
  src/cli.ts
```

Then:

```sh
way --help
```

### As a library

Once published to JSR:

```ts
import {
  initDatabase,
  insertFlow,
  buildFlowAggregate,
  exportMarkdown,
} from 'jsr:@waystation/core';
```

Locally, import from `src/mod.ts` directly.

---

## CLI usage

The database lives at `$HOME/.waystation/way.db` by default. Override with
`--db <path>` on any subcommand.

```text
way <command> [options]

COMMANDS
  init                                Initialise the local SQLite database.
  list                                Print all flows.
  show   <flowId>                     Render the flow via glow/bat/marked-terminal.
         [--raw] [--json]               --raw: structured fields; --json: aggregate JSON.
  export <flowId> [--out FILE]        Render a flow as Markdown to stdout/file.
         [--frontmatter]                Include YAML+JSON frontmatter block.
         [--no-export-links]            Suppress GitHub permalinks.
         [--pretty]                     Pipe through glow/bat/marked-terminal.
  add    <path>:<line>[:<endLine>]    Capture a line as a new step.
         [--flow ID] [--local-only]
         [--title STR] [--desc STR]     Attach a heading & description.
  rename <flowId> <newTitle>          Give a flow a meaningful name.
  sync                                (not yet implemented)

GLOBAL OPTIONS
  --db   <path>     Use a non-default database file.
  -v, --verbose     Echo internal log lines.
  -h, --help        Show this help.
```

### A typical session

```sh
way init                                      # one-time bootstrap
way add src/server.ts:42 --flow my-bug        # capture a line
way add src/server.ts:88:104 --flow my-bug    # capture a range
way list                                      # see all flows + counts
way show my-bug                               # pretty-printed view
way export my-bug --frontmatter --out flow.md # render to Markdown
```

`way add` auto-creates the flow if `--flow` is omitted, enriches the capture
with git context (commit SHA, branch, repo-relative path, GitHub remote), and
stores it under a stable hashed id. `--local-only` marks a flow as never to
be synced to a remote backend.

---

## Library usage

Everything below is exported from `@waystation/core` (see `src/mod.ts`).

### Bootstrapping

```ts
import { initDatabase, schemaSqlPath } from '@waystation/core';

await initDatabase.process({ dbPath: '/tmp/way.db' });
// schemaSqlPath also exposed if you're managing the lifecycle yourself.
```

### Creating flows and adding captures

```ts
import { insertFlow, saveMatch } from '@waystation/core';

const flowId = await insertFlow({ name: 'investigating-cache-bug' });

await saveMatch.process({
  flowId,
  match: {
    line: 'cache.get(key)',
    file_path: '/abs/path/src/cache.ts',
    file_name: 'cache.ts',
    line_no: 42,
  },
});
```

`saveMatch` is a pipeline (see below) that fills in git metadata, computes a
deterministic id, inserts the row, and attaches it to the target flow.

### Reading the aggregate

```ts
import { buildFlowAggregate, jp, P } from '@waystation/core';

const { aggregate } = await buildFlowAggregate.process({ flowId });

jp.get(aggregate, P.flowName);        // 'investigating-cache-bug'
jp.get(aggregate, P.matchLine(0));    // 'cache.get(key)'
```

All navigation goes through JSON pointers (`src/pointers.ts`,
[RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901)) so consumers in
other languages / runtimes can read the same paths.

### Rendering Markdown

```ts
import { exportMarkdown } from '@waystation/core';

const { markdown } = await exportMarkdown.process({
  flowId,
  options: { frontmatter: true, exportLinks: true },
});
```

---

## Architecture

```
src/
├── cli.ts                 # `way` entry point, argv → command dispatch
├── mod.ts                 # public library surface (re-exports)
├── pointers.ts            # JSON pointers into FlowAggregate (RFC 6901)
├── types.ts               # Flow / Match / FlowMatch / FlowAggregate
├── commands/              # one file per `way <cmd>` subcommand
├── pipelines/             # composed multi-stage workflows
│   ├── initDatabase.ts
│   ├── saveMatch.ts
│   ├── buildFlowAggregate.ts
│   ├── exportMarkdown.ts
│   └── sync.ts
├── flows/                 # flow CRUD, git discovery, markdown rendering
├── db/                    # sqlite3 driver wrapper + async helpers
└── vendor/                # zero-dep building blocks (see below)
    ├── pipeline.ts        # sequential async pipeline (.pipe / .process)
    └── jsonpointer.ts     # tiny RFC 6901 get/set
tests/                     # `deno task test`
schema.sql                 # canonical DB schema, applied by `initDatabase`
```

### Two load-bearing primitives

The library is built on two intentionally small vendored utilities:

1. **`Pipeline<Ctx>`** (`src/vendor/pipeline.ts`) — a `.pipe(stage).pipe(stage)`
   chain executed by `.process(ctx)`. Every multi-step DB workflow is a
   pipeline, which keeps stages individually testable and trivially composable.
   Source: [aaronmyatt/pdPipe](https://github.com/aaronmyatt/pdPipe).

2. **`jp` + `P`** (`src/vendor/jsonpointer.ts` + `src/pointers.ts`) — RFC 6901
   JSON pointers and a typed factory bundle that names every field path in
   `FlowAggregate`. Stages read/write through pointers, so schema renames are
   one-file edits and external tools can navigate the same blob without
   reimplementing accessors.

### Data model

Four core SQLite tables (see [`schema.sql`](./schema.sql) for the full DDL):

| Table           | Role                                                                  |
| --------------- | --------------------------------------------------------------------- |
| `flows`         | A named journey. Carries git context and `local_only` / `synced_at`.  |
| `matches`       | A single `(line, file_path, git_commit_sha)`-unique code location.    |
| `flow_matches`  | Ordered join between a flow and its content; `content_kind` discriminates whether `content_id` points at `matches` or `step_contents`. |
| `step_contents` | Rich step payloads — notes, images (blob or on-disk), HTML, links.    |

Plus `tags`, `flow_tags`, `flow_history`, and `user_favourite_tags` for
features still being wired up.

The in-memory shape that flows through pipelines is `FlowAggregate`
(`src/types.ts`): a `flow` object plus an ordered `matches: FlowMatchState[]`.

---

## Development

```sh
deno task test            # run all tests (read/write/env/run perms)
deno task lint            # deno lint
deno task fmt             # deno fmt (100 col, 2-space, single-quote, semi)
deno task fmt:check       # CI variant
deno task cli -- <args>   # run the CLI from source
```

Tests live in `tests/` and exercise each pipeline (`initDatabase`,
`saveMatch`, `buildFlowAggregate`, `exportMarkdown`) plus the vendored
primitives. They create scratch DBs under `Deno.makeTempDir()` — no global
state is touched.

### Project conventions

- **FCIS-ish.** Pipeline stages are pure where possible; SQL/IO is isolated in
  `db/` and `flows/crud.ts`.
- **Vendored over imported** for tiny primitives (pipeline, jsonpointer) to
  keep the dependency surface near-zero.
- **Comments explain *why*.** Every file opens with a header explaining its
  role; non-obvious decisions link to the relevant doc, RFC, or upstream
  source.
- **REPL examples at the bottom of source files.** Each module ends with a
  commented `// ── REPL examples ──` block — paste into a Deno REPL to learn
  the API.

---

## Documentation references

- Deno standard library — <https://jsr.io/@std>
- `@std/cli` `parseArgs` — <https://jsr.io/@std/cli/doc/parse-args>
- RFC 6901 (JSON pointers) — <https://datatracker.ietf.org/doc/html/rfc6901>
- `sqlite3` CLI — <https://sqlite.org/cli.html>
- `marked` (Markdown parser) — <https://marked.js.org>
- `marked-terminal` — <https://github.com/mikaelbr/marked-terminal>

---

## License

MIT (pending `LICENSE` file). Vendored `pipeline.ts` and `jsonpointer.ts` are
MIT-licensed in their upstream repositories.

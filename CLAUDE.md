# Project: waystation-cli

Overarching implementation philosophy: https://wiki.c2.com/?MakeItWorkMakeItRightMakeItFast

A Deno/TypeScript CLI + library for capturing and replaying codebase navigation flows.
SQLite-backed, zero-runtime-dependencies. Published on JSR as `@atm/waystation-cli`.

---

## Stack & project layout

| Layer                  | Where                                   | Notes                                                                                         |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| CLI entry              | `src/cli.ts`                            | `parseArgs` dispatch to `src/commands/`                                                       |
| Public library surface | `src/mod.ts`                            | Everything re-exported here is stable; everything else is internal                            |
| Domain types           | `src/types.ts`                          | Mirrors `schema.sql` — the canonical data-model source of truth                               |
| SQLite driver          | `src/db/sqlite.ts`, `src/db/helpers.ts` | Thin wrappers around Deno's `--allow-ffi` sqlite3 bindings; no ORM                            |
| Pipelines              | `src/pipelines/*.ts`                    | Composable async stages via the vendored `Pipeline` class                                     |
| Flow logic             | `src/flows/*.ts`                        | CRUD, git inspection, markdown render                                                         |
| Schema                 | `schema.sql` (+ `src/schema.ts`)        | The DDL. `src/schema.ts` bundles it as a string so JSR consumers don't need filesystem access |
| Vendored primitives    | `src/vendor/*.ts`                       | `Pipeline` (from pdPipe) and `jsonpointer` — kept self-contained for zero-dep                 |
| Tests                  | `tests/*.test.ts`                       | Plain Deno.test, no test framework. Run with `deno task test`                                 |
| Backlog                | `backlog/`                              | Task-driven workflow (see §Backlog below)                                                     |

---

## Backlog & implementation workflow

Every non-trivial change moves through `backlog/tasks/` entries. The cadence is **plan → implement →
`Testing` → user verifies → `Done`**, with explicit pause-points.

- **Pause for verification at every AC boundary.** Don't chain dependent tasks without the user's
  go-ahead, even when the next task looks tempting.
- **Always include testable snippets in the task notes** that the user can paste to drive each AC
  themselves: CLI one-liners, Deno REPL imports, or `fetch` calls against a running server. The goal
  is copy-paste verification.
- **Reshape dependent tasks immediately** when a design decision in one task invalidates assumptions
  in another. Don't leave it for later.
- **Capture deferred ideas as `Draft` tickets** in `backlog/drafts/`, never as TODO comments or chat
  scrollback.
- **Bug fixes during testing get appended as a "Fix during testing" note** to the existing task —
  don't rewrite plan/notes. Preserves the trail of what went wrong and why.

---

## Build it drivable — Pipeline-first architecture

This project already embodies the
[App Actions](https://www.cypress.io/blog/stop-using-page-objects-and-start-using-app-actions)
pattern: every multi-step workflow is a `Pipeline` of composable stages, and every stage is a
pure-ish async function (context in, context out). Don't verify by clicking a CLI — drive the
pipeline directly from a test or REPL.

Drivable surfaces, in order of preference:

| Layer        | The "app action" surface                                       | Drive it from                                                                     |
| ------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Pipelines    | `saveMatch.process({ match, flowId })` — object in, object out | A `Deno.test` importing the pipeline directly, or a Deno REPL with `--import-map` |
| DB helpers   | `getAsync`, `queryAsync`, `runAsync` — typed SQLite access     | Tests that set up a temp DB via `Deno.makeTempDir` + `initDatabase.process()`     |
| CLI commands | `initCommand`, `listCommand`, etc. — same callable signature   | Tests that pass synthetic args objects, or `deno task cli -- <args>`              |
| Types        | Pure data shapes (`Flow`, `FlowAggregate`, `Match`)            | TypeScript structural typing — construct them inline in tests                     |

The rules:

- **New multi-step logic goes in a `src/pipelines/<name>.ts` file**, not inline in a command
  handler. A pipeline is invocable from a test and from a CLI command; inline logic is trapped
  behind the CLI dispatch.
- **Every pipeline exports its context type.** Callers pass it in, stages enrich it in place. The
  context type is the contract.
- **Thin commands, fat pipelines.** Commands parse/validate args and delegate; pipelines hold the
  domain logic.
- **Tests drive the pipeline directly.** `Deno.test` files import the pipeline, call `.process()`,
  assert on the returned context and on DB state via `getAsync`/`queryAsync`. No CLI subprocess
  spawning needed.
- **Every source file includes REPL-evaluable examples** in a comment block at the bottom (see
  `src/mod.ts` and `src/pipelines/saveMatch.ts` for the pattern). These are checked-in, pasteable
  snippets that exercise the API.
- **Keep the `DENO_DEPLOYMENT` guard if it exists** — nothing that runs `Deno.makeTempDir` or opens
  a live sqlite3 connection should ship to Deno Deploy without a guard. Library consumers on Deploy
  use the types and helpers, not the DB pipelines.

---

## Ticket shaping — never land a breakage that "the next ticket fixes"

Every ticket should be **shippable on its own** without breaking the running CLI. If the only thing
keeping the tool working after this ticket lands is a future ticket whose code isn't written yet,
the boundary is in the wrong place.

The principle:

- **A new DB column or constraint is a contract with two sides.** A ticket that adds one must also
  include — or be paired with — the writes that satisfy it. If they can't fit in one ticket, the
  schema ticket should land the column as nullable and the follow-up ticket should add the
  constraint after the writes are in place.
- **"It'll be fixed by the next ticket" is not a defence.** Mid-branch breakage blocks every other
  parallel workstream that needs to verify against a running tool.
- **Look for the same shape in:** new required CLI args, new exported types that callers must now
  provide, new pipeline stages that previous stages don't populate.

---

## Decompose to small, deployable steps that accrete to the public interface

When a feature is large, **split it into the smallest steps that each ship green** and order them so
capability _accretes_ toward the public interface. More small tickets beat fewer big ones.

Principles:

- **Step 1 is a pure refactor — behaviour-identical.** Extract a primitive, route existing callers
  through it with zero behaviour change. Now every later step has one place to add capability.
- **One primitive, many accreting steps.** New features add to the _same_ pipeline, never forked. An
  explicit AC forbids a second copy.
- **The interface flip is the LAST functional change, and it's dependency-gated.** Turning on the
  user-visible behaviour happens after its safety prerequisites close.
- **Find the steps with no dependencies — they're "ready now" roots.** A good decomposition has more
  than one entry point.
- **Transitional states are a feature, not a smell.** A nullable column that becomes required later,
  or a no-op pipeline stage that gets wired in later — land the permissive version first, tighten
  once its dependencies are in place.

When _not_ to over-split: a genuinely atomic change (one function, one test) doesn't need a chain.

---

## Scope discipline — Make It Work first

- **Don't pull future-phase concerns into the current phase.** Hardcoded constants are fine _when
  there's a known follow-up phase to make them configurable_.
- **Verify the current AC before reaching for the next task.**
- **Trust the phase plan to constrain you.** If you're tempted to refactor something the current
  task doesn't name, capture it as a Draft and move on.

---

## Deno conventions for this project

### Formatting & linting

```sh
deno task fmt        # auto-format (lineWidth: 100, indentWidth: 2, singleQuote)
deno task fmt:check  # CI check
deno task lint       # exclude: no-explicit-any, require-await
```

### Testing

```sh
deno task test       # deno test --allow-read --allow-write --allow-env --allow-run
```

- Tests are plain `Deno.test()` blocks — no test framework.
- Tests that need a DB use `Deno.makeTempDir` + `initDatabase.process()` + `Deno.remove` in a
  try/finally (see `tests/save_match.test.ts` for the pattern).
- Import assertions: `@std/assert` (`assertEquals`, `assert`, `assertThrows`).

### TypeScript style

- Prefer explicit types on function parameters and return values, even where inference would work —
  the types serve as documentation.
- Every exported type gets a JSDoc comment.
- `// ── Section headers ──` with Unicode box-drawing characters break files into scannable blocks
  (consistent across the codebase).

### Schema migrations

- `schema.sql` is the canonical DDL. When you add tables/columns/indexes, add them here.
- `src/schema.ts` bundles the full `schema.sql` text as a `SCHEMA_SQL` export string so the library
  works in JSR/Deno Deploy without filesystem access. **Keep this in sync** — every schema change
  touches both files.
- `src/pipelines/initDatabase.ts` runs the schema via `applySchemaFile`. It uses `IF NOT EXISTS`
  guards so it's safe to call repeatedly.

### SQLite patterns

- No ORM. Raw SQL with positional `?` parameters.
- Use `getAsync<T>(sql, params)` for single-row queries, `queryAsync<T>(sql, params)` for multi-row,
  `runAsync(sql, params)` for writes.
- `INSERT OR IGNORE` / `ON CONFLICT DO UPDATE` for idempotent upserts.
- Content-derived primary keys (sha256 hashes) for deduplication — see `generateContentBasedId` in
  `saveMatch.ts`.

### Vendor directory

- `src/vendor/` contains self-contained, unmodified (or minimally modified) copies of external
  libraries.
- Purpose: keep `@atm/waystation-cli` zero-runtime-dependency.
- Modification note: `pipeline.ts` inlines the `Stage` type (originally from pdPipe's
  `pipedown.d.ts`) to avoid importing a full runtime.

### JSR publishing

- `deno.json` `publish.include` controls what ships to JSR.
- Library entry: `src/mod.ts` (everything re-exported here is the public API).
- Sub-export: `@atm/waystation-cli/schema` → `src/schema.ts`.

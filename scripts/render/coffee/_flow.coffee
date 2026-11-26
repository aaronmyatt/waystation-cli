# ──────────────────────────────────────────────────────────────────────────
# Shared plumbing for the CoffeeScript render scripts (html, marp, typst).
#
# Each script takes a flow id. This file is the part they share, and it is
# only plumbing:
#
#   1. Fetch the flow    `way export <flowId> --json` (or `-` for stdin)
#   2. Command line      read the arguments, write the result
#   3. Three text helpers the renderers use
#
# There is no data reshaping here. `way export --json` prints the flow
# already flattened for rendering: code lines unpacked, the focal line
# found, permalinks built, notes parsed into blocks. That work lives once, in
# src/flows/view.ts.
#
# Runs on Node with CoffeeScript 2:
#   brew install coffeescript        (or: npm install -g coffeescript)
#
# References:
#   • CoffeeScript 2:           https://coffeescript.org/
#   • child_process.spawnSync:  https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options
#   • util.parseArgs:           https://nodejs.org/api/util.html#utilparseargsconfig
# ──────────────────────────────────────────────────────────────────────────

{ spawnSync } = require 'node:child_process'
fs = require 'node:fs'
path = require 'node:path'
{ parseArgs } = require 'node:util'

# ── Text helpers ─────────────────────────────────────────────────────────

# Escape text for HTML element content and double-quoted attributes.
# Ref: https://html.spec.whatwg.org/multipage/syntax.html#escapingString
escapeHtml = (text) ->
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

# File-name-safe slug: `How way export…` → `how-way-export`.
slugify = (name) ->
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) or 'flow'

# `3 steps` / `1 step`.
plural = (count, noun) -> "#{count} #{noun}#{if count is 1 then '' else 's'}"

# ── Command line ─────────────────────────────────────────────────────────

# Print one clean line to stderr and stop. The script's own name leads, so
# the message still makes sense at the end of a pipeline.
fail = (message) ->
  console.error "#{path.basename process.argv[1]}: #{message}"
  process.exit 1

# Options every script takes.
BASE_OPTIONS =
  out: { type: 'string', short: 'o' }
  db: { type: 'string' }
  help: { type: 'boolean', short: 'h' }

# Read a script's command line: exactly one <flowId>, the shared options, and
# whatever `extra` options the script adds. Prints `usage` and stops on
# --help or on a call it cannot read.
readArgs = (usage, extra = {}) ->
  try
    { values, positionals } = parseArgs
      args: process.argv[2..]
      options: { BASE_OPTIONS..., extra... }
      allowPositionals: true
  catch err
    fail "#{err.message}\n\n#{usage}"
  if values.help
    console.log usage
    process.exit 0
  fail "expected exactly one <flowId>\n\n#{usage}" unless positionals.length is 1
  { flowId: positionals[0], values }

# Fetch a flow, ready to render.
#
#   • `flowId` is handed to `way export <flowId> --json`, which accepts a
#     flow's id or any part of its name (src/flows/crud.ts, resolveFlowId).
#   • `-` reads that same JSON from stdin instead, so the scripts also sit at
#     the end of a pipe: `way export my-flow --json | html.coffee -`.
#   • $WAY_BIN names the `way` program when it is not on PATH.
#
# Returns the view described in src/flows/view.ts:
#   { name, description, descriptionSpans, repo, branch, commit, updatedAt,
#     files, steps: [{ n, title, body, blocks, file, line, endLine, ref, url,
#                      lang, lines, startLine, hitIndex }] }
loadFlow = (flowId, opts = {}) ->
  if flowId is '-'
    # File descriptor 0 is stdin: https://nodejs.org/api/fs.html#fsreadfilesyncpath-options
    text = fs.readFileSync 0, 'utf8'
  else
    args = ['export', flowId, '--json']
    args.push '--db', opts.db if opts.db
    bin = process.env.WAY_BIN or 'way'
    res = spawnSync bin, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
    if res.error
      missing = res.error.code is 'ENOENT'
      fail if missing then "cannot find `#{bin}` (install waystation, or set WAY_BIN)" else res.error.message
    # `way` explains itself on stderr, e.g. `Error: No flow found matching "x"`.
    fail (res.stderr or res.stdout).trim() unless res.status is 0
    text = res.stdout
  try
    flow = JSON.parse text
  catch
    fail 'the flow is not valid JSON'
  # `way show --json` prints the stored rows (`matches`), not this view.
  fail 'expected render-ready JSON: use `way export <flow> --json`' unless Array.isArray flow?.steps
  flow

# Write the result to `out`, or to stdout when there is none.
emit = (text, out) ->
  if out then fs.writeFileSync out, text else process.stdout.write text
  return

# Run a script's main function; an error becomes one line, not a stack trace.
run = (main) ->
  try
    main()
  catch err
    fail err.message

module.exports = { escapeHtml, slugify, plural, fail, readArgs, loadFlow, emit, run }

# ── REPL examples ────────────────────────────────────────────────────────
# Start a REPL in this folder with `coffee`, then paste:
#
# { escapeHtml, loadFlow, plural, slugify } = require './_flow'
#
# # 1. Text helpers
# escapeHtml '<a href="x">'                 # → '&lt;a href=&quot;x&quot;&gt;'
# slugify 'How way export renders a flow'   # → 'how-way-export-renders-a-flow'
# plural 1, 'step'                          # → '1 step'
#
# # 2. A flow from your database, by id or by part of its name
# flow = loadFlow 'export'
# [flow.name, flow.steps.length]
# (s.ref for s in flow.steps)               # → [ 'src/cli.ts:116-124', … ]

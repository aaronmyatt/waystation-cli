#!/usr/bin/env coffee
# ──────────────────────────────────────────────────────────────────────────
# typst.coffee <flowId> — a waystation flow as a PDF, set by Typst.
#
# This script writes no Typst source. The templates in ../templates/ are
# static; they load the flow with Typst's own `json()`. So the job here is:
#
#   1. Fetch the flow, ready to render: `way export <flowId> --json`  (_flow.coffee)
#   2. Write it as flow.json in a temp folder, beside copies of the templates
#   3. Run `typst compile` there
#
# Text reaches Typst as strings, never as markup, so nothing in a flow can
# inject Typst code.
#
# References:
#   • Typst CLI:           run `typst compile --help`
#   • json():              https://typst.app/docs/reference/data-loading/json/
#   • sys.inputs:          https://typst.app/docs/reference/foundations/sys/
#   • fs.mkdtempSync:      https://nodejs.org/api/fs.html#fsmkdtempsyncprefix-options
# ──────────────────────────────────────────────────────────────────────────

{ spawnSync } = require 'node:child_process'
fs = require 'node:fs'
os = require 'node:os'
path = require 'node:path'
{ slugify, fail, readArgs, loadFlow, run } = require './_flow'

USAGE = '''
  typst.coffee — a waystation flow as a PDF, set by Typst

  USAGE
    typst.coffee <flowId> [-o FILE] [--db PATH] [--accent COLOUR] [--font NAME]

    <flowId>         A flow's id, or any part of its name. `-` reads
                     `way export <flow> --json` from stdin instead.
    -o, --out FILE   Where to write. Default: <flow-name>.pdf in this folder.
    --db PATH        Use a non-default waystation database.
    --accent COLOUR  Accent colour, e.g. '#7c3aed'.
    --font NAME      Body font, e.g. 'Helvetica Neue'.

  EXAMPLES
    typst.coffee "export flow"
    typst.coffee 3f2a9c1e -o review.pdf --accent '#7c3aed'
'''

# The document template and the helpers it imports.
TEMPLATES = ['lib.typ', 'flow.typ']
TEMPLATE_DIR = path.join __dirname, '..', 'templates'

# Compile `data` — the flow as JSON text — to a PDF at `out` (an absolute path).
# Every step key is always present (null when unknown), which Typst reads as `none`.
# opts: { accent, font } restyle the document without editing the template.
compilePdf = (data, out, opts = {}) ->
  # Typst only reads files under its project root, so the data and the
  # templates are gathered in one throwaway folder and compiled from there.
  dir = fs.mkdtempSync path.join(os.tmpdir(), 'way-typst-')
  try
    fs.writeFileSync path.join(dir, 'flow.json'), data
    for name in TEMPLATES
      fs.copyFileSync path.join(TEMPLATE_DIR, name), path.join(dir, name)
    args = ['compile', '--input', 'flow=flow.json']
    args.push '--input', "accent=#{opts.accent}" if opts.accent
    args.push '--input', "font=#{opts.font}" if opts.font
    args.push 'flow.typ', out
    res = spawnSync 'typst', args, { cwd: dir, encoding: 'utf8' }
    if res.error
      missing = res.error.code is 'ENOENT'
      fail if missing then 'cannot find `typst` (https://typst.app/open-source/#download)' else res.error.message
    fail res.stderr.trim() unless res.status is 0
    # Typst warns on stderr even when it succeeds; pass that on.
    console.error res.stderr.trim() if res.stderr.trim()
  finally
    fs.rmSync dir, { recursive: true, force: true }
  return

main = ->
  { flowId, values } = readArgs USAGE,
    accent: { type: 'string' }
    font: { type: 'string' }
  flow = loadFlow flowId, values
  out = path.resolve(values.out ? "#{slugify flow.name}.pdf")
  compilePdf JSON.stringify(flow), out, values
  # A PDF on a terminal helps no one: say where it went instead.
  console.log out

module.exports = { compilePdf }

# Only when run as a script, not when another file requires this one.
# https://nodejs.org/api/modules.html#accessing-the-main-module
run main if require.main is module

# ── REPL examples ────────────────────────────────────────────────────────
# Start a REPL in this folder with `coffee`, then paste:
#
# { compilePdf } = require './typst'
# { loadFlow } = require './_flow'
#
# # 1. A flow from your database as a PDF in the system temp folder
# compilePdf JSON.stringify(loadFlow 'export'), '/tmp/demo.pdf'
#
# # 2. Restyled, without touching the template
# compilePdf JSON.stringify(loadFlow 'export'), '/tmp/demo.pdf', { accent: '#7c3aed' }
#
# From a shell:
#   scripts/render/coffee/typst.coffee "export flow"                        # → prints the PDF's path
#   way export "export flow" --json | scripts/render/coffee/typst.coffee -  # same, from a pipe

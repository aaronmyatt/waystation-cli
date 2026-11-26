#!/usr/bin/env coffee
# ──────────────────────────────────────────────────────────────────────────
# marp.coffee <flowId> — a waystation flow as a Marp slide deck.
#
# One step per slide, styled to match the HTML page (html.coffee): same
# colours, number badge, code panel with line numbers, and the same highlight
# on the focal line.
#
# Marp decks are plain markdown. Slides are split by `---` rulers and the
# front matter turns the file into a deck. With `-o deck.html` (or .pdf,
# .pptx) this script hands the deck to Marp CLI to build that file.
#
# Everything here works with Marp's defaults: no `--html` flag, no theme
# file. The look comes from three Marp features:
#
#   1. `style:` in the front matter — CSS layered over the built-in theme.
#   2. `<style scoped>` on a slide — CSS for that slide only. Each code slide
#      uses it to hand its code panel three values: room for a number gutter
#      (`--gutter`), the line numbers (`--ln`), and which line to highlight
#      (`--hit`). Marpit reads `<style>` itself, so this is not "raw HTML".
#   3. `paginate` — Marp puts the page number on each slide as an attribute.
#      The theme draws it twice: as the round step badge, and as "3 / 9".
#      The title and route slides use `_paginate: skip`, so page numbers
#      equal step numbers.
#
# Slides have a fixed height, so each step's code window is trimmed to fit,
# centred on the focal line (see `codeBudget`). A step whose note leaves no
# room for code gets two slides: the note, then the code.
#
# Flow text is markdown, but never HTML: Marp lets a list of "safe" tags
# through, so every `<` outside code is written as an entity (see `noHtml`).
#
# The flow arrives ready to render, from `way export <flowId> --json`
# (see _flow.coffee). Nothing here reshapes data: this file is the template.
#
# A port of ../marp.ts. tests/render_coffee.test.ts checks that both produce
# the same bytes, so a change to one needs the same change in the other.
#
# References:
#   • Marpit markdown (slide rulers):        https://marpit.marp.app/markdown
#   • Directives (`paginate`, `_class`, `header`, `footer`, the `_` prefix):
#     https://marpit.marp.app/directives
#   • `style:` and `<style scoped>`:         https://marpit.marp.app/theme-css?id=tweak-style-through-markdown
#   • Marp's code auto-shrink (why the highlight lives on `code`, not `pre`):
#     https://github.com/marp-team/marp-core#auto-scaling-features
#   • Marp CLI (render to HTML/PDF/PPTX):    https://github.com/marp-team/marp-cli
#   • Fenced code rules (why the fence length varies):
#     https://spec.commonmark.org/0.31.2/#fenced-code-blocks
# ──────────────────────────────────────────────────────────────────────────

{ spawnSync } = require 'node:child_process'
fs = require 'node:fs'
os = require 'node:os'
path = require 'node:path'
{ plural, fail, readArgs, loadFlow, emit, run } = require './_flow'

USAGE = '''
  marp.coffee — a waystation flow as a Marp slide deck

  USAGE
    marp.coffee <flowId> [-o FILE] [--db PATH] [--max-lines N] [--theme NAME]

    <flowId>         A flow's id, or any part of its name. `-` reads
                     `way export <flow> --json` from stdin instead.
    -o, --out FILE   Write here instead of stdout. A name ending in .html,
                     .pdf or .pptx is built with Marp CLI; anything else
                     gets the deck's markdown.
    --db PATH        Use a non-default waystation database.
    --max-lines N    Most code lines on one slide. Default 14.
    --theme NAME     Built-in Marp theme under the deck's own CSS. Default: default.

  EXAMPLES
    marp.coffee "export flow" -o export.slides.html
    marp.coffee 3f2a9c1e > deck.md
'''

# ── Slide geometry ───────────────────────────────────────────────────────
#
# A Marp slide is 1280 × 720 CSS px (the 16:9 default). These numbers are
# used twice: in the theme CSS, and to work out how many code lines fit.

SLIDE_W = 1280
SLIDE_H = 720
PAD_X = 64
PAD_TOP = 62
PAD_BOTTOM = 52
# Title line height in px. Also the badge's diameter.
TITLE_LINE = 44
# Note text: 22px × 1.45.
NOTE_LINE = 32
# Code text: 16px × 1.5. A whole number, so the highlight band is crisp.
CODE_LINE = 24
# Space a code panel takes besides its lines: margin 16 + padding 28 + border 2.
PANEL_CHROME = 46
# Fewest code lines worth showing. Below this the code gets its own slide.
MIN_CODE_LINES = 4
# Rough characters per line, used only to guess how tall text will be.
NOTE_COLS = 84
TITLE_COLS = 54
# Steps listed on one route slide (two columns of seven).
ROUTE_PER_SLIDE = 14
# The panel's inner width: the content width less its left and right borders.
CODE_W = SLIDE_W - 2 * PAD_X - 2

# ── Theme ────────────────────────────────────────────────────────────────
#
# CSS for the front matter's `style:` key. The palette is the HTML page's;
# highlight.js token classes are mapped onto the same six token colours.
#
# Code blocks: Marp wraps the content of every `pre` in a component that
# shrinks it when a line is too wide. So the line numbers and the highlight
# band are drawn on the inner `code` element — they shrink with the text and
# stay lined up. `min-width` makes `code` fill the block when lines are short.
#
# A code block inside a note is a plain block. The step's own code panel is
# the last `pre` on the slide; the slide's scoped style gives it `--gutter`,
# `--ln` and `--hit`, which turn on the number gutter and the highlight.
#
#   • Line numbers: `code::before` shows the string in `--ln`.
#     https://developer.mozilla.org/en-US/docs/Web/CSS/content
#   • Highlight: two one-line-tall background layers moved down `--hit` lines.
#     https://developer.mozilla.org/en-US/docs/Web/CSS/background-position
#   • Badge and "3 / 9": `attr()` reads the page number Marp sets.
#     https://developer.mozilla.org/en-US/docs/Web/CSS/attr
#   • Slides read top-down: Marp's default theme is a block container
#     centred with `align-content`, so that is the property to override.
#     https://developer.mozilla.org/en-US/docs/Web/CSS/align-content
#
# A `"""` block interpolates: each `#{NAME}` below is one of the numbers above.
THEME_CSS = """
section {
  --bg: #faf9f6; --ink: #1c1b19; --muted: #6b675f; --line: #e2ded5;
  --accent: #0f766e; --accent-soft: rgba(15,118,110,.11); --code-bg: #f3f1eb;
  --c: #8a857a; --s: #a1420f; --n: #955a00; --k: #6b3fd4; --f: #1f55c9; --t: #0f766e;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  width: #{SLIDE_W}px; height: #{SLIDE_H}px;
  padding: #{PAD_TOP}px #{PAD_X}px #{PAD_BOTTOM}px;
  align-content: start;
  background: var(--bg); color: var(--ink);
  font: 22px/1.45 var(--sans);
}
section a { color: var(--accent); }
section h1, section h2 { margin: 0; padding: 0; border: 0; color: var(--ink); }
section h2 { font-size: 34px; line-height: #{TITLE_LINE}px; letter-spacing: -.005em; }
section > p, section > ul, section > ol { margin: 14px 0 0; max-width: 1000px; }
section li { margin: .2em 0; }
section :not(pre) > code {
  padding: .12em .38em; border-radius: 4px;
  background: var(--code-bg); color: inherit; font: .86em var(--mono);
}

/* Step number badge + "3 / 9", both from Marp's page number. */
section[data-marpit-pagination] h2 { padding-left: 60px; }
section[data-marpit-pagination]::after {
  content: attr(data-marpit-pagination);
  position: absolute; left: #{PAD_X}px; top: #{PAD_TOP}px; right: auto; bottom: auto;
  width: #{TITLE_LINE}px; height: #{TITLE_LINE}px; padding: 0; border-radius: 50%;
  background: var(--accent); color: #fff;
  font: 650 20px/#{TITLE_LINE}px var(--sans); text-align: center;
  font-variant-numeric: tabular-nums;
}
section[data-marpit-pagination]::before {
  content: attr(data-marpit-pagination) " / " attr(data-marpit-pagination-total);
  position: absolute; right: #{PAD_X}px; bottom: 20px;
  font: 14px/1.4 var(--sans); color: var(--muted); font-variant-numeric: tabular-nums;
}

/* Breadcrumb (file:line) above the title; flow name below the content. */
section header, section footer {
  left: #{PAD_X}px; right: auto; margin: 0; color: var(--muted);
}
section header { top: 26px; font: 15px/1.4 var(--mono); }
section footer { bottom: 20px; font: 14px/1.4 var(--sans); }
section header a { color: inherit; text-decoration: none; }
section header code { padding: 0; background: none; font: inherit; }

/* Code blocks. The per-slide style sets --gutter, --ln and --hit on the step's panel. */
section pre {
  margin: 16px 0 0; padding: 14px 0; overflow: hidden;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--code-bg); font: 16px/#{CODE_LINE}px var(--mono); tab-size: 2;
}
section > pre > code { min-width: #{CODE_W}px; }
section pre > code {
  display: block; position: relative; box-sizing: border-box;
  padding: 0 20px 0 var(--gutter, 20px); color: var(--ink); font: inherit;
  background-color: transparent;
  background-image:
    linear-gradient(var(--accent), var(--accent)),
    linear-gradient(var(--accent-soft), var(--accent-soft));
  background-repeat: no-repeat;
  background-size: 3px #{CODE_LINE}px, 100% #{CODE_LINE}px;
  background-position: 0 calc(var(--hit, -1) * #{CODE_LINE}px);
}
section pre > code::before {
  content: var(--ln, "");
  position: absolute; left: 0; top: 0; width: 3.6em;
  text-align: right; white-space: pre; color: var(--muted); opacity: .65;
}
section pre code [class^="hljs-"] { color: inherit; font-style: normal; font-weight: inherit; }
section pre code .hljs-comment, section pre code .hljs-quote { color: var(--c); font-style: italic; }
section pre code .hljs-string, section pre code .hljs-regexp { color: var(--s); }
section pre code .hljs-number, section pre code .hljs-literal { color: var(--n); }
section pre code .hljs-keyword, section pre code .hljs-doctag { color: var(--k); }
section pre code .hljs-title, section pre code .hljs-section { color: var(--f); }
section pre code .hljs-type, section pre code .hljs-built_in { color: var(--t); }

/* Title slide. */
section.lead { align-content: center; }
section.lead > p:first-of-type {
  margin: 0 0 14px; color: var(--accent);
  font-size: 15px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase;
}
section.lead h1 { font-size: 58px; line-height: 1.12; letter-spacing: -.015em; }
section.lead h1 + p { margin-top: 20px; max-width: 900px; color: var(--muted); font-size: 26px; }
section.lead > p:last-of-type { margin-top: 30px; color: var(--muted); font-size: 16px; }
section.lead > p:last-of-type code {
  padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px;
  background: none; font: 14.5px var(--mono);
}

/* Route slide: the step list, in two columns. */
section.route ol {
  columns: 2; column-gap: 56px; max-width: none;
  margin: 22px 0 0; padding-left: 1.7em; font-size: 21px; line-height: 1.35;
}
section.route li { margin: 0 0 14px; padding-left: 4px; break-inside: avoid; }
section.route li::marker { color: var(--accent); font-weight: 650; font-variant-numeric: tabular-nums; }
section.route li a { color: var(--ink); font-weight: 600; text-decoration: none; }
section.route li code {
  display: block; margin-top: 2px; padding: 0;
  background: none; color: var(--muted); font: 14px/1.4 var(--mono);
}
"""

# ── Code windows ─────────────────────────────────────────────────────────

# Pick the fence for a code block. CommonMark closes a fence only on a run
# of backticks at least as long as the opener, so code that itself contains
# ``` needs a longer fence.
fenceFor = (code) ->
  runs = (m[0].length for m from code.matchAll(/`+/g))
  '`'.repeat Math.max(3, Math.max(0, runs...) + 1)

# Trim a step's context to `max` lines, keeping the focal line in view.
# Returns { lines, cut, start }: the lines shown, whether any were left out,
# and the index of the first one within the step's lines.
windowLines = (step, max) ->
  return { lines: step.lines, cut: false, start: 0 } if step.lines.length <= max
  centre = if step.hitIndex >= 0 then step.hitIndex else 0
  start = Math.max 0, Math.min(centre - Math.floor(max / 2), step.lines.length - max)
  { lines: step.lines.slice(start, start + max), cut: true, start }

# How many code lines fit on this step's slide, never more than `max`. Zero
# or less means the note leaves no room for code at all.
#
# An estimate, not a measurement: the slide's free height, minus the title
# and a guess at the note's height, divided by the height of a code line.
# A long note gets a shorter code window instead of pushing the code off the
# bottom of the slide.
codeBudget = (step, max) ->
  titleLines = Math.max 1, Math.ceil(step.title.length / TITLE_COLS)
  # Each source line wraps to one or more slide lines; a blank line is a
  # paragraph gap, a bit under half a line.
  noteLines = 0
  for line in step.body.split('\n')
    noteLines += if line.trim() then Math.ceil(line.length / NOTE_COLS) else 0.45
  note = if step.body.trim() then 14 + noteLines * NOTE_LINE else 0
  free = SLIDE_H - PAD_TOP - PAD_BOTTOM - titleLines * TITLE_LINE - note - PANEL_CHROME
  Math.min max, Math.floor(free / CODE_LINE)

# ── Slides ───────────────────────────────────────────────────────────────

# Keep flow text from being read as HTML. Marp passes a list of "safe" tags
# through even without `--html`, so a stray `<b>` in a title would swallow
# the rest of its slide, and `<!--` or `<style>` in a note would be read as
# deck directives. Every `<` outside inline code and fenced blocks becomes
# `&lt;`, which markdown shows as a plain `<`.
# Ref: https://github.com/marp-team/marp-core#html-boolean--object
noHtml = (text) ->
  fenced = false
  lines = for line in text.split('\n')
    if /^\s*(`{3,}|~{3,})/.test(line)
      fenced = not fenced
      line
    else if fenced
      line
    else
      # The first alternative swallows whole code spans so they pass through.
      line.replace(/`[^`]*`|</g, (m) -> if m is '<' then '&lt;' else m)
  lines.join '\n'

# A lone `---` in a note would split the slide; soften it to `***`.
slideSafe = (body) -> body.replace(/^\s*---+\s*$/gm, '***')

# A directive comment. JSON.stringify yields a valid double-quoted YAML
# scalar; `-->` inside the value would end the comment early, so its `>` is
# written as a YAML unicode escape.
directive = (key, value) ->
  "<!-- #{key}: #{JSON.stringify(value).replaceAll('-->', '--\\u003e')} -->"

# Text safe to use as a markdown link label.
linkLabel = (text) -> text.replace(/[\[\]\\]/g, '\\$&')

titleSlide = (flow) ->
  meta = [flow.repo, flow.branch, flow.commit?.slice(0, 7)].filter(Boolean).map (v) -> "`#{v}`"
  meta.push plural(flow.steps.length, 'step'), plural(flow.files.length, 'file')
  [
    # The `_` prefix scopes a directive to this slide only. `skip` leaves the
    # slide out of the page count, so step 1 is page 1.
    '<!-- _class: lead -->'
    '<!-- _paginate: skip -->'
    '<!-- _footer: "" -->'
    'Waystation flow'
    "# #{noHtml flow.name}"
    noHtml(flow.description)
    meta.join(' · ')
  ].filter(Boolean).join '\n\n'

# Number of route slides a flow needs. A one-step flow needs no map.
routeCount = (steps) -> if steps < 2 then 0 else Math.ceil(steps / ROUTE_PER_SLIDE)

# The step list: the deck's version of the HTML page's side rail. Each entry
# links to its slide — Marp gives every slide its position as an id, so
# `#4` jumps to the fourth slide. `positions[i]` is the slide of step `i`.
routeSlides = (flow, positions) ->
  count = routeCount flow.steps.length
  slides = []
  return slides unless count > 0
  for i in [0...flow.steps.length] by ROUTE_PER_SLIDE
    # A markdown list that starts at `15.` keeps counting from 15.
    items = for s, k in flow.steps.slice(i, i + ROUTE_PER_SLIDE)
      "#{s.n}. [#{linkLabel noHtml(s.title)}](##{positions[i + k]})" + (if s.ref then " `#{s.ref}`" else '')
    heading = if count > 1 then "## Route (#{slides.length + 1} of #{count})" else '## Route'
    slides.push ['<!-- _class: route -->', '<!-- _paginate: skip -->', heading, items.join('\n')].join('\n\n')
  slides

# `file:line`, linked when the flow knows its repo, plus a note when the code is trimmed.
breadcrumb = (step, win) ->
  parts = []
  if step.ref
    ref = "`#{step.ref}`"
    parts.push if step.url then "[#{ref}](#{step.url})" else ref
  parts.push "showing #{win.lines.length} of #{step.lines.length} lines" if win?.cut
  parts.join ' · '

# The step's code panel: its per-slide style, then the fenced block.
codePanel = (step, win) ->
  first = (step.startLine ? 1) + win.start
  # `\A ` is a newline inside a CSS string: one number per code line.
  # https://developer.mozilla.org/en-US/docs/Web/CSS/string#escape_sequences
  numbers = (first + i for _, i in win.lines).join '\\A '
  # A range capture has no single focal line (hitIndex -1): no band.
  hit = if step.hitIndex >= 0 then step.hitIndex - win.start else -1
  code = win.lines.join '\n'
  fence = fenceFor code
  [
    # The panel is the last `pre` on the slide; any `pre` before it is a code
    # block from the note and stays plain.
    """<style scoped>section > pre:last-of-type { --gutter: 4.8em; --ln: "#{numbers}"; --hit: #{hit}; }</style>"""
    "#{fence}#{step.lang}\n#{code}\n#{fence}"
  ].join '\n\n'

# One step's slides: usually one; two when the note leaves no room for code.
stepSlides = (step, max) ->
  # No number in the heading: the badge shows it.
  title = "## #{noHtml step.title}"
  body = if step.body then slideSafe(noHtml(step.body)) else ''
  join = (parts...) -> parts.filter(Boolean).join '\n\n'
  head = (win) ->
    crumb = breadcrumb step, win
    if crumb then directive('_header', crumb) else ''
  return [join(head(null), title, body)] unless step.lines.length

  budget = codeBudget step, max
  if budget >= MIN_CODE_LINES
    shown = windowLines step, budget
    return [join(head(shown), title, body, codePanel(step, shown))]
  # Note first, then the code on a slide of its own. `hold` repeats the page
  # number instead of counting on, so both slides carry this step's badge.
  alone = Math.max MIN_CODE_LINES, codeBudget({ step..., body: '' }, max)
  shown = windowLines step, alone
  [
    join(head(null), title, body)
    join('<!-- _paginate: hold -->', head(shown), title, codePanel(step, shown))
  ]

# Render a flow as Marp-flavoured markdown.
# `flow` is the view `way export --json` prints. opts: { theme: 'default', maxLines: 14 }
renderMarp = (flow, opts = {}) ->
  max = opts.maxLines ? 14
  style = for line in THEME_CSS.split('\n')
    if line then "  #{line}" else ''
  front = [
    '---'
    'marp: true'
    "theme: #{opts.theme ? 'default'}"
    'size: 16:9'
    'paginate: true'
    # JSON.stringify yields a valid double-quoted YAML scalar.
    "title: #{JSON.stringify flow.name}"
    "footer: #{JSON.stringify noHtml(flow.name)}"
    'style: |'
    style...
    '---'
  ].join '\n'

  perStep = (stepSlides(s, max) for s in flow.steps)
  # Slide number of each step's first slide, for the route's links: after the
  # title slide and the route slides.
  next = 1 + routeCount(flow.steps.length) + 1
  positions = for stepDeck in perStep
    at = next
    next += stepDeck.length
    at
  deck = [titleSlide(flow), routeSlides(flow, positions)..., perStep.flat()...]
  # The front matter's closing `---` already opens the first slide, so only
  # the slides themselves are joined with rulers.
  front + '\n\n' + deck.join('\n\n---\n\n') + '\n'

# ── Building with Marp CLI ───────────────────────────────────────────────

# Output names Marp CLI builds from the deck; anything else is markdown.
BUILT = /\.(html|pdf|pptx)$/i

# Hand the deck to Marp CLI and write `out` (HTML, PDF or PowerPoint).
buildDeck = (deck, out) ->
  target = path.resolve out
  dir = fs.mkdtempSync path.join(os.tmpdir(), 'way-marp-')
  try
    source = path.join dir, 'deck.md'
    fs.writeFileSync source, deck
    # stdin is closed on purpose ('ignore'): Marp CLI waits on an open,
    # non-terminal stdin. https://nodejs.org/api/child_process.html#optionsstdio
    res = spawnSync 'marp', [source, '-o', target], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' }
    if res.error
      missing = res.error.code is 'ENOENT'
      fail if missing then 'cannot find `marp` (https://github.com/marp-team/marp-cli#install)' else res.error.message
    fail res.stderr.trim() unless res.status is 0
  finally
    fs.rmSync dir, { recursive: true, force: true }
  # Say where it went: the file itself is not something to print.
  console.log target

main = ->
  { flowId, values } = readArgs USAGE,
    theme: { type: 'string' }
    'max-lines': { type: 'string' }
  maxLines = undefined
  if values['max-lines']?
    maxLines = Number values['max-lines']
    fail '--max-lines must be a whole number above 0' unless Number.isInteger(maxLines) and maxLines > 0
  deck = renderMarp loadFlow(flowId, values), { theme: values.theme, maxLines }
  if values.out and BUILT.test(values.out) then buildDeck(deck, values.out) else emit(deck, values.out)

module.exports = { renderMarp, codeBudget, fenceFor, noHtml, windowLines }

# Only when run as a script, not when another file requires this one.
# https://nodejs.org/api/modules.html#accessing-the-main-module
run main if require.main is module

# ── REPL examples ────────────────────────────────────────────────────────
# Start a REPL in this folder with `coffee`, then paste:
#
# { codeBudget, fenceFor, noHtml, renderMarp } = require './marp'
#
# # 1. A deck for a flow in your database: front matter, title, route, then the steps
# { loadFlow } = require './_flow'
# renderMarp(loadFlow 'export').split('\n---\n').length
#
# # 2. Code containing ``` gets a longer fence
# fenceFor 'md += "```" + lang'   # → '````'
#
# # 3. A long note leaves room for fewer code lines
# codeBudget { title: 'T', body: '' }, 14                    # → 14
# codeBudget { title: 'T', body: 'x'.repeat(84 * 8) }, 14    # → 10
#
# # 4. Flow text is never HTML, but code keeps its angle brackets
# noHtml 'Returns <b> or `Map<string, T>`'   # → 'Returns &lt;b> or `Map<string, T>`'
#
# From a shell:
#   scripts/render/coffee/marp.coffee "export flow" -o export.slides.html
#   scripts/render/coffee/marp.coffee "export flow" > deck.md

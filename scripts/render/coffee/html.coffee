#!/usr/bin/env coffee
# ──────────────────────────────────────────────────────────────────────────
# html.coffee <flowId> — a waystation flow as ONE self-contained HTML file.
#
# No JavaScript, no network requests, no dependencies: inline CSS only. The
# file can be emailed, attached to a PR, or opened from disk.
#
#   • Sticky step rail on wide screens, hidden on narrow ones.
#   • Each step's code sits in a <details> so it folds without JS.
#   • Light and dark follow the OS via `prefers-color-scheme`.
#   • Print styles double as a PDF path (browser → Print → Save as PDF).
#
# The flow arrives ready to render, from `way export <flowId> --json`
# (see _flow.coffee). Nothing here reshapes data: this file is the template.
#
# A port of ../html.ts. tests/render_coffee.test.ts checks that both produce
# the same bytes, so a change to one needs the same change in the other.
#
# References:
#   • <details>/<summary>:   https://developer.mozilla.org/en-US/docs/Web/HTML/Element/details
#   • prefers-color-scheme:  https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme
#   • Print media queries:   https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_media_queries/Printing
#   • CoffeeScript strings (`'''` keeps text as is, `"…#{x}…"` interpolates):
#     https://coffeescript.org/#strings
# ──────────────────────────────────────────────────────────────────────────

{ escapeHtml, plural, fail, readArgs, loadFlow, emit, run } = require './_flow'

USAGE = '''
  html.coffee — a waystation flow as one self-contained HTML file

  USAGE
    html.coffee <flowId> [-o FILE] [--db PATH] [--paper A4|Letter] [--no-highlight]

    <flowId>         A flow's id, or any part of its name. `-` reads
                     `way export <flow> --json` from stdin instead.
    -o, --out FILE   Write here instead of stdout.
    --db PATH        Use a non-default waystation database.
    --paper SIZE     Paper size when the page is printed. Default A4.
    --no-highlight   Leave the code uncoloured.

  EXAMPLES
    html.coffee "export flow" -o export.html
    html.coffee 3f2a9c1e > flow.html
'''

# ── Syntax highlighting (tiny, line-based) ───────────────────────────────
#
# A deliberately small tokenizer: comments, strings, numbers, keywords,
# call names, type-ish names. It works a line at a time, so multi-line
# strings are not tracked. That trade keeps the file dependency-free.

FAMILY =
  typescript: 'c'
  javascript: 'c'
  go: 'c'
  rust: 'c'
  c: 'c'
  cpp: 'c'
  java: 'c'
  kotlin: 'c'
  swift: 'c'
  php: 'c'
  css: 'c'
  scss: 'c'
  python: 'py'
  ruby: 'rb'
  bash: 'sh'
  sql: 'sql'
  json: 'data'
  yaml: 'data'
  toml: 'data'

words = (s) -> new Set s.split(' ')

KEYWORDS =
  c: words 'abstract as async await break case catch class const continue default defer delete do else ' +
    'enum export extends false final finally fn for func function go if impl implements import ' +
    'in instanceof interface let match mut new nil null of package private protected pub public ' +
    'readonly return self static struct super switch this throw true try type typeof undefined ' +
    'use var void while yield'
  py: words 'and as assert async await break class continue def del elif else except False finally for ' +
    'from global if import in is lambda None nonlocal not or pass raise return True try while ' +
    'with yield'
  rb: words 'alias and begin break case class def do else elsif end ensure false for if in module next ' +
    'nil not or redo rescue retry return self super then true undef unless until when while yield'
  sh: words 'case do done elif else esac export fi for function if in local return then until while'
  sql: words 'select from where and or not null is in as join left right inner outer on group by order ' +
    'having limit insert into values update set delete create table index if exists primary key ' +
    'foreign references default case when then else end asc desc distinct union all'
  data: words 'true false null'

# Each piece is written as a regex literal and read back as text with
# `.source`, so no backslash needs doubling.
# https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/source

# Line-comment opener per family. JSON has none, but YAML/TOML use `#`.
LINE_COMMENT =
  c: /\/\/.*/.source
  py: /#.*/.source
  rb: /#.*/.source
  sh: /#.*/.source
  sql: /--.*/.source
  data: /#.*/.source

BLOCK_COMMENT = /\/\*.*?(?:\*\/|$)/.source
STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/.source
NUMBER = /\b\d[\d_]*(?:\.\d+)?\b/.source
IDENT = /[A-Za-z_$][\w$]*/.source

# Build the per-family token regex. Group order = token class.
tokenRegex = (family) ->
  block = if family is 'c' then "|#{BLOCK_COMMENT}" else ''
  new RegExp "(#{LINE_COMMENT[family]}#{block})|(#{STRING})|(#{NUMBER})|(#{IDENT})", 'g'

span = (cls, text) -> """<span class="#{cls}">#{escapeHtml text}</span>"""

# Highlight a block of lines. Returns one HTML string per input line.
# Unknown languages come back escaped but uncoloured.
highlightLines = (lines, lang) ->
  family = FAMILY[lang]
  return lines.map((line) -> escapeHtml line) unless family
  re = tokenRegex family
  keywords = KEYWORDS[family]
  # Tracks an unclosed `/* … ` so following lines stay comment-coloured.
  inBlock = false

  lines.map (line) ->
    if family is 'c'
      if inBlock
        inBlock = false if line.includes '*/'
        return span 'c', line
      # A snippet may start mid-JSDoc; ` * text` lines are comment bodies.
      return span 'c', line if /^\s*\*(\s|\/|$)/.test(line)
    out = ''
    last = 0
    for m from line.matchAll(re)
      out += escapeHtml line.slice(last, m.index)
      [text, comment, str, num, ident] = m
      end = m.index + text.length
      if comment?
        out += span 'c', text
        inBlock = true if text.startsWith('/*') and not text.endsWith('*/')
      else if str?
        out += span 's', text
      else if num?
        out += span 'n', text
      else if keywords.has(if family is 'sql' then ident.toLowerCase() else ident)
        out += span 'k', text
      else if line[end] is '('
        out += span 'f', text
      else if /^[A-Z][a-z]/.test(ident)
        out += span 't', text
      else
        out += escapeHtml text
      last = end
    out + escapeHtml line.slice(last)

# ── Note bodies ──────────────────────────────────────────────────────────

spansToHtml = (spans) ->
  parts = for s in spans
    v = escapeHtml s.v
    switch s.t
      when 'code' then "<code>#{v}</code>"
      when 'strong' then "<strong>#{v}</strong>"
      when 'em' then "<em>#{v}</em>"
      # `href` was scheme-checked when the view was built (src/flows/view.ts); escaping covers the rest.
      when 'link' then """<a href="#{escapeHtml s.href}">#{v}</a>"""
      else v
  parts.join ''

blocksToHtml = (blocks) ->
  parts = for b in blocks
    switch b.t
      when 'p' then "<p>#{spansToHtml b.spans}</p>"
      when 'ul', 'ol'
        items = ("<li>#{spansToHtml i}</li>" for i in b.items).join ''
        "<#{b.t}>#{items}</#{b.t}>"
      when 'code' then """<pre class="inline-code"><code>#{escapeHtml b.v}</code></pre>"""
  parts.join '\n'

# ── Page pieces ──────────────────────────────────────────────────────────

# Longest code block that print keeps on a single page.
KEEP_LINES = 30

codeHtml = (step, highlight) ->
  return '' unless step.lines.length
  rendered =
    if highlight then highlightLines step.lines, step.lang
    else step.lines.map (line) -> escapeHtml line
  # Line numbers live in `data-n` and are drawn by CSS ::before, so selecting
  # and copying the code never picks them up. The spans are joined without
  # newlines: each is display:block, and a literal "\n" inside <pre> would
  # add a blank row between them.
  rows = for html, i in rendered
    hit = if i is step.hitIndex then ' hit' else ''
    """<span class="ln#{hit}" data-n="#{step.startLine + i}">#{html}</span>"""
  # Blocks up to KEEP_LINES stay whole in print (`break-inside: avoid`).
  # Longer ones may split across pages: forcing a tall block to stay whole
  # is what leaves a half-empty page behind.
  keep = if step.lines.length <= KEEP_LINES then ' keep' else ''
  [
    """<details class="code#{keep}" open>"""
    """<summary><span class="path">#{escapeHtml(step.ref ? '')}</span><span class="lang">#{escapeHtml step.lang}</span></summary>"""
    "<pre><code>#{rows.join ''}</code></pre>"
    '</details>'
  ].join '\n'

stepHtml = (step, highlight) ->
  loc =
    if not step.ref then ''
    else if step.url
      """<a class="loc" href="#{escapeHtml step.url}">#{escapeHtml step.ref} <span aria-hidden="true">↗</span></a>"""
    else
      """<span class="loc">#{escapeHtml step.ref}</span>"""
  note = if step.blocks.length then """<div class="note">#{blocksToHtml step.blocks}</div>""" else ''
  [
    """<li class="step" id="step-#{step.n}">"""
    """<span class="badge" aria-hidden="true">#{step.n}</span>"""
    "<h2>#{escapeHtml step.title}</h2>"
    loc
    note
    codeHtml(step, highlight)
    '</li>'
  ].join '\n'

railHtml = (flow) ->
  items = for s in flow.steps
    """<li><a href="#step-#{s.n}"><span class="n">#{s.n}</span><span class="t">#{escapeHtml s.title}</span></a></li>"""
  """<nav class="rail" aria-label="Steps"><p class="rail-title">Route</p><ol>\n#{items.join '\n'}\n</ol></nav>"""

metaHtml = (flow) ->
  chips = []
  chips.push """<span class="chip">#{escapeHtml flow.repo}</span>""" if flow.repo
  chips.push """<span class="chip">#{escapeHtml flow.branch}</span>""" if flow.branch
  chips.push """<span class="chip mono">#{escapeHtml flow.commit.slice(0, 7)}</span>""" if flow.commit
  chips.push """<span class="chip">#{plural flow.steps.length, 'step'}</span>"""
  chips.push """<span class="chip">#{plural flow.files.length, 'file'}</span>""" if flow.files.length
  """<p class="meta">#{chips.join ''}</p>"""

# ── Stylesheet ───────────────────────────────────────────────────────────
#
# Colours are custom properties so the dark block only swaps values.
# Token classes: c comment · s string · n number · k keyword · f call · t type.
#
# The `@media print` block is a second layout, not an afterthought:
#   • `print-color-adjust: exact` asks the browser to print fills (badges,
#     code panels, hit line) even when "Background graphics" is unticked.
#     https://developer.mozilla.org/en-US/docs/Web/CSS/print-color-adjust
#   • Steps may split across pages; headings, notes and short code blocks
#     may not. https://developer.mozilla.org/en-US/docs/Web/CSS/break-inside
#   • Wrapped code lines hang under the code, not under the line number.
#   • The dark palette is `screen`-only, so paper is always dark-on-white.
#
# A `'''` block is taken as written: nothing in it is interpolated.
CSS = '''
:root{
  --bg:#faf9f6;--ink:#1c1b19;--muted:#6b675f;--line:#e2ded5;
  --accent:#0f766e;--accent-soft:rgba(15,118,110,.11);--on-accent:#fff;
  --code-bg:#f3f1eb;
  --c:#8a857a;--s:#a1420f;--n:#955a00;--k:#6b3fd4;--f:#1f55c9;--t:#0f766e;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
}
@media screen and (prefers-color-scheme:dark){:root{
  --bg:#111416;--ink:#e8e6e1;--muted:#9c978d;--line:#2a2f33;
  --accent:#4fd1c5;--accent-soft:rgba(79,209,197,.15);--on-accent:#0b1213;
  --code-bg:#0c0f11;
  --c:#7b8188;--s:#f2a68a;--n:#f0c070;--k:#c0a5ff;--f:#8db4ff;--t:#6fe0d0;
}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 var(--sans);-webkit-text-size-adjust:100%}
a{color:var(--accent)}
.page{max-width:1120px;margin:0 auto;padding:56px 24px 96px;display:grid;grid-template-columns:230px minmax(0,1fr);gap:56px}
.rail{position:sticky;top:32px;align-self:start;max-height:calc(100vh - 64px);overflow:auto;font-size:13.5px}
.rail-title{margin:0 0 10px;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.rail ol{list-style:none;margin:0;padding:0}
.rail a{display:flex;gap:10px;padding:5px 8px;border-radius:6px;color:var(--muted);text-decoration:none;line-height:1.35}
.rail a:hover{color:var(--ink);background:var(--accent-soft)}
.rail .n{flex:none;width:1.4em;text-align:right;font-variant-numeric:tabular-nums;color:var(--accent);font-weight:600}
.eyebrow{margin:0 0 10px;font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
h1{margin:0;font-size:clamp(28px,4.2vw,40px);line-height:1.15;letter-spacing:-.015em;text-wrap:balance}
.desc{margin:14px 0 0;max-width:62ch;color:var(--muted);font-size:17px}
.desc code,.note code{font:.88em var(--mono);background:var(--code-bg);padding:.12em .38em;border-radius:4px}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 0}
.chip{font-size:12.5px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
.chip.mono{font-family:var(--mono)}
.steps{list-style:none;margin:48px 0 0;padding:0}
.step{position:relative;padding:0 0 44px 56px;scroll-margin-top:24px}
.step::before{content:"";position:absolute;left:15px;top:40px;bottom:4px;width:2px;background:var(--line)}
.step:last-child{padding-bottom:0}
.step:last-child::before{display:none}
.badge{position:absolute;left:0;top:0;width:32px;height:32px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;font-size:14px;font-weight:650;font-variant-numeric:tabular-nums}
h2{margin:0;padding-top:2px;font-size:20px;line-height:1.35;letter-spacing:-.005em}
.loc{display:inline-block;margin-top:4px;font:12.5px var(--mono);color:var(--muted);text-decoration:none;overflow-wrap:anywhere}
a.loc:hover{color:var(--accent)}
.note{margin-top:10px;max-width:68ch}
.note p{margin:.55em 0}
.note ul,.note ol{margin:.55em 0;padding-left:1.3em}
.note li{margin:.2em 0}
.inline-code{margin:.7em 0;padding:10px 14px;background:var(--code-bg);border-radius:8px;overflow-x:auto;font:13px/1.55 var(--mono)}
.code{margin-top:16px;border:1px solid var(--line);border-radius:10px;background:var(--code-bg);overflow:hidden}
.code summary{display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;font:12px var(--mono);color:var(--muted);list-style:none}
.code summary::-webkit-details-marker{display:none}
.code summary::before{content:"▸";font-size:10px;transition:transform .12s}
.code[open] summary::before{transform:rotate(90deg)}
.code .path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.code .lang{flex:none;opacity:.8}
.code pre{margin:0;padding:10px 0;border-top:1px solid var(--line);overflow-x:auto;font:13px/1.65 var(--mono);tab-size:2}
.code code{display:inline-block;min-width:100%}
.ln{display:block;padding-right:18px;white-space:pre}
.ln::before{content:attr(data-n);display:inline-block;width:3.4em;margin-right:16px;text-align:right;color:var(--muted);opacity:.65;user-select:none;-webkit-user-select:none}
.ln.hit{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.ln.hit::before{color:var(--accent);opacity:1;font-weight:600}
.c{color:var(--c);font-style:italic}.s{color:var(--s)}.n{color:var(--n)}.k{color:var(--k)}.f{color:var(--f)}.t{color:var(--t)}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
@media (max-width:900px){.page{display:block;padding:36px 18px 72px}.rail{display:none}.step{padding-left:46px}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.code summary::before{transition:none}}
@media print{
  :root{--bg:#fff;--code-bg:#f5f4f0;--line:#d8d4cb}
  html{scroll-behavior:auto}
  body{background:#fff;font-size:10pt;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  a{text-decoration:none}
  .page{display:block;max-width:none;padding:0}
  .rail{display:none}
  .eyebrow{margin-bottom:6pt;font-size:7.5pt}
  h1{font-size:22pt}
  .desc{max-width:none;margin-top:8pt;font-size:11.5pt}
  .meta{gap:5pt;margin-top:10pt}
  .chip{padding:1.5pt 7pt;font-size:8pt}
  .steps{margin-top:16pt;padding-top:16pt;border-top:.6pt solid var(--line)}
  .step{padding:0 0 17pt 30pt}
  .step::before{display:none}
  .badge{width:20pt;height:20pt;font-size:9.5pt}
  h2{padding-top:1.5pt;font-size:12.5pt;break-after:avoid}
  .loc{margin-top:1pt;font-size:7.8pt;break-after:avoid}
  .note{max-width:none;margin-top:5pt;break-inside:avoid;break-after:avoid}
  .note p{margin:.4em 0}
  .inline-code{font-size:8pt;white-space:pre-wrap}
  .code{margin-top:8pt;border-width:.6pt;border-radius:5pt;overflow:visible}
  .code.keep{break-inside:avoid}
  .code summary{padding:4pt 9pt;font-size:7.5pt;break-after:avoid}
  .code summary::before{display:none}
  .code pre{padding:5pt 0;font-size:8pt;line-height:1.45;overflow:visible}
  .code code{display:block;min-width:0}
  .ln{padding-left:calc(3.4em + 12pt);text-indent:calc(-3.4em - 12pt);white-space:pre-wrap;overflow-wrap:anywhere;break-inside:avoid}
  .ln::before{margin-right:12pt;text-indent:0}
  footer{margin-top:4pt;padding-top:8pt;font-size:8pt;break-before:avoid}
}
'''

# ── Page rule (print) ────────────────────────────────────────────────────

# Escape text for a double-quoted CSS string. `<` is hex-escaped so a flow
# name can never spell `</style>` and end the stylesheet early.
# Ref: https://www.w3.org/TR/css-syntax-3/#consume-string-token
cssString = (text) ->
  text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\3c ')
    .replace(/\s+/g, ' ')

# The `@page` rule: paper size, margins, and a running footer in the bottom
# margin ("flow name · 2 / 5"). Margin boxes need Chrome 131+; browsers
# without them simply print no footer.
# Refs: https://developer.mozilla.org/en-US/docs/Web/CSS/@page
#       https://developer.chrome.com/blog/print-margins
pageCss = (flow, paper) ->
  footer = '  @bottom-center{content:"' + cssString(flow.name) + '  \\b7  " counter(page) " / " counter(pages);' +
    'font:7.5pt ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#6b675f}'
  ["@page{size:#{paper};margin:16mm 16mm 19mm;", footer, '}'].join '\n'

# ── Entry point ──────────────────────────────────────────────────────────

# Render a flow as a complete, self-contained HTML document.
# `flow` is the view `way export --json` prints. opts: { highlight: true, paper: 'A4' }
renderHtml = (flow, opts = {}) ->
  highlight = opts.highlight ? true
  desc = if flow.description then """<p class="desc">#{spansToHtml flow.descriptionSpans}</p>""" else ''
  credits = [flow.repo, if flow.updatedAt then "updated #{flow.updatedAt}" else null]
    .filter(Boolean).map((v) -> escapeHtml String(v)).join(' · ')
  [
    '<!doctype html>'
    '<html lang="en">'
    '<head>'
    '<meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1">'
    '<meta name="color-scheme" content="light dark">'
    "<title>#{escapeHtml flow.name}</title>"
    '<style>'
    CSS
    pageCss(flow, opts.paper ? 'A4')
    '</style>'
    '</head>'
    '<body>'
    '<div class="page">'
    railHtml(flow)
    '<main>'
    '<header>'
    '<p class="eyebrow">Waystation flow</p>'
    "<h1>#{escapeHtml flow.name}</h1>"
    desc
    metaHtml(flow)
    '</header>'
    '<ol class="steps">'
    (stepHtml(s, highlight) for s in flow.steps).join('\n')
    '</ol>'
    "<footer>Waystation flow#{if credits then " · #{credits}" else ''}</footer>"
    '</main>'
    '</div>'
    '</body>'
    '</html>'
    ''
  ].join '\n'

main = ->
  { flowId, values } = readArgs USAGE,
    paper: { type: 'string' }
    'no-highlight': { type: 'boolean' }
  paper = values.paper ? 'A4'
  fail "--paper must be A4 or Letter, not #{paper}" unless paper in ['A4', 'Letter']
  page = renderHtml loadFlow(flowId, values), { paper, highlight: not values['no-highlight'] }
  emit page, values.out

module.exports = { renderHtml, highlightLines, cssString }

# Only when run as a script, not when another file requires this one.
# https://nodejs.org/api/modules.html#accessing-the-main-module
run main if require.main is module

# ── REPL examples ────────────────────────────────────────────────────────
# Start a REPL in this folder with `coffee`, then paste:
#
# { highlightLines, renderHtml } = require './html'
#
# # 1. Whole page for a flow in your database
# { loadFlow } = require './_flow'
# renderHtml(loadFlow 'export').includes '<ol class="steps">'   # → true
#
# # 2. Titles are escaped, never interpreted
# renderHtml(name: '<script>x</script>', description: '', descriptionSpans: [], files: [], steps: []).includes '<script>'   # → false
#
# # 3. Highlighter on its own
# highlightLines ['const a = "b"; // c'], 'typescript'
# # → [ '<span class="k">const</span> a = <span class="s">&quot;b&quot;</span>; <span class="c">// c</span>' ]
#
# From a shell:
#   scripts/render/coffee/html.coffee "export flow" -o export.html
#   way export "export flow" --json | scripts/render/coffee/html.coffee - > export.html

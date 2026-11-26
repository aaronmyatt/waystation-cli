// ──────────────────────────────────────────────────────────────────────────
// Shared helpers for the Waystation Typst templates (flow.typ, cards.typ).
//
// Input: the JSON written by `render.ts typst` (see ../typst.ts). The path
// comes from `--input flow=<path>` and is resolved relative to this file.
//
// Optional restyling, no template edits needed:
//   --input accent='#7c3aed'      accent colour
//   --input font='Helvetica Neue' body font (default is bundled with Typst,
//                                 so the output is the same on any machine)
//
// References:
//   • sys.inputs:        https://typst.app/docs/reference/foundations/sys/
//   • json():            https://typst.app/docs/reference/data-loading/json/
//   • raw + raw.line:    https://typst.app/docs/reference/text/raw/
//   • Bundled fonts:     https://typst.app/docs/reference/text/text/#parameters-font
// ──────────────────────────────────────────────────────────────────────────

// ── Inputs ───────────────────────────────────────────────────────────────

#let flow = json(sys.inputs.at("flow", default: "flow.json"))
#let accent = rgb(sys.inputs.at("accent", default: "#0f766e"))
#let body-font = sys.inputs.at("font", default: "Libertinus Serif")
// DejaVu Sans Mono ships inside the Typst binary.
#let mono-font = "DejaVu Sans Mono"

#let ink = rgb("#1c1b19")
#let muted = rgb("#6b675f")
#let hairline = rgb("#dcd8cf")
#let code-bg = rgb("#f3f1eb")

// ── Note bodies ──────────────────────────────────────────────────────────
//
// Notes arrive pre-parsed (see `Block` / `Span` in ../_shared.ts), so no
// markdown package is needed and the template compiles offline.

// A `for` loop in code mode joins the value of each iteration, so this
// returns one piece of content made of all the spans.
#let spans(xs) = for s in xs {
  if s.t == "code" {
    raw(s.v)
  } else if s.t == "strong" {
    strong(s.v)
  } else if s.t == "em" {
    emph(s.v)
  } else if s.t == "link" {
    link(s.href, s.v)
  } else {
    [#s.v]
  }
}

// ── Code panel ───────────────────────────────────────────────────────────

// `lines`: array of strings. `start`: line number of lines.at(0).
// `hit`: 0-based index of the focal line, or -1 for none.
#let code-panel(lines, lang, start, hit, size: 8.2pt) = {
  // `raw.line` is shown once per line of a raw block; `it.number` is
  // 1-based within the block and `it.body` is the highlighted line.
  show raw.line: it => {
    let is-hit = it.number - 1 == hit
    box(
      width: 100%,
      inset: (left: 6pt, right: 8pt, y: 2.4pt),
      fill: if is-hit { accent.transparentize(86%) } else { none },
      stroke: if is-hit { (left: 2pt + accent) } else { none },
      // Two columns, so a line too long for the panel wraps under the code
      // rather than under its number. The number cell also acts as a strut:
      // empty source lines keep their height.
      // Ref: https://typst.app/docs/reference/layout/grid/
      grid(
        columns: (2.4em, 1fr),
        column-gutter: 1em,
        align(right, text(
          fill: if is-hit { accent } else { muted.lighten(30%) },
          str(start + it.number - 1),
        )),
        it.body,
      ),
    )
  }
  set par(leading: 0.3em)
  block(
    width: 100%,
    fill: code-bg,
    radius: 4pt,
    inset: (y: 5pt),
    clip: true,
    // Typst scales raw text to 0.8em by default; divide to land on `size`.
    text(size: size / 0.8, raw(
      lines.join("\n"),
      // "text" is waystation's "unknown language" marker; `none` skips
      // highlighting.
      lang: if lang == "text" { none } else { lang },
      block: true,
    )),
  )
}

#let blocks(bs) = for b in bs {
  if b.t == "p" {
    par(spans(b.spans))
  } else if b.t == "ul" {
    list(..b.items.map(i => [#spans(i)]))
  } else if b.t == "ol" {
    enum(..b.items.map(i => [#spans(i)]))
  } else if b.t == "code" {
    code-panel(b.v.split("\n"), b.lang, 1, -1)
  }
}

// ── Small pieces ─────────────────────────────────────────────────────────

// Filled circle carrying a step number.
#let badge(n, size: 1.55em) = box(
  width: size,
  height: size,
  radius: 50%,
  fill: accent,
  align(center + horizon, text(fill: white, weight: "bold", size: 0.82em, n)),
)

// `src/x.ts:12`, linked to GitHub when the flow knows the repo.
#let file-ref(step, size: 8pt) = {
  if step.ref == none { return }
  let label = text(font: mono-font, size: size, fill: muted, step.ref)
  if step.url == none { label } else { link(step.url, label) }
}

// "repo · branch · abc1234 · 9 steps · 6 files"
#let meta-line() = {
  let parts = ()
  if flow.repo != none { parts.push(flow.repo) }
  if flow.branch != none { parts.push(flow.branch) }
  if flow.commit != none { parts.push(flow.commit.slice(0, 7)) }
  parts.push(str(flow.steps.len()) + " steps")
  parts.push(str(flow.files.len()) + " files")
  parts.join("  ·  ")
}

// ──────────────────────────────────────────────────────────────────────────
// Waystation flow → one card per step (PNG or SVG).
//
// Each step becomes its own page. Page height is `auto`, so every card is
// exactly as tall as its content. Typst writes one image per page when the
// output path carries a page-number template (`{0p}` = zero-padded).
//
// Compile (in a folder holding flow.json, lib.typ and this file):
//   typst compile --input flow=flow.json --ppi 144 cards.typ 'card-{0p}.png'
//   typst compile --input flow=flow.json           cards.typ 'card-{0p}.svg'
//
// 600pt wide at 144 ppi = 1200px: crisp in Slack, PR comments, and slides.
//
// References:
//   • page() with auto height: https://typst.app/docs/reference/layout/page/#parameters-height
//   • pagebreak():             https://typst.app/docs/reference/layout/pagebreak/
// ──────────────────────────────────────────────────────────────────────────

#import "lib.typ": *

#set document(title: flow.name)
#set page(width: 600pt, height: auto, margin: 0pt, fill: rgb("#faf9f6"))
#set text(font: body-font, size: 12pt, fill: ink, lang: "en")
#set par(leading: 0.62em, spacing: 0.85em)
#show raw: set text(font: mono-font)
#show link: set text(fill: accent)

#let total = flow.steps.len()

#for (i, step) in flow.steps.enumerate() {
  if i > 0 { pagebreak() }
  // The left stroke is the card's accent bar; it spans the full page height
  // because the page is exactly as tall as this block.
  block(width: 100%, inset: (left: 34pt, right: 30pt, y: 28pt), stroke: (left: 6pt + accent), {
    // Top row: flow name on the left, position on the right.
    grid(
      columns: (1fr, auto),
      column-gutter: 12pt,
      text(size: 8pt, weight: "bold", fill: muted, tracking: 0.12em, upper(flow.name)),
      text(size: 8pt, weight: "bold", fill: accent, str(step.n) + " / " + str(total)),
    )
    v(12pt)
    grid(
      columns: (auto, 1fr),
      column-gutter: 10pt,
      align: horizon,
      badge(str(step.n), size: 1.9em),
      text(size: 19pt, weight: "bold", step.title),
    )
    if step.ref != none {
      v(4pt)
      file-ref(step, size: 8.5pt)
    }
    v(8pt)
    blocks(step.blocks)
    if step.lines.len() > 0 {
      v(4pt)
      code-panel(step.lines, step.lang, step.startLine, step.hitIndex, size: 8.6pt)
    }
  })
}

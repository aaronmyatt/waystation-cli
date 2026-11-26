// ──────────────────────────────────────────────────────────────────────────
// Waystation flow → A4 document (PDF).
//
// Compile (in a folder holding flow.json, lib.typ and this file):
//   typst compile --input flow=flow.json flow.typ flow.pdf
//
// Steps are real headings, so the PDF gets a bookmark outline for free.
//
// References:
//   • page():     https://typst.app/docs/reference/layout/page/
//   • heading():  https://typst.app/docs/reference/model/heading/
//   • counter():  https://typst.app/docs/reference/introspection/counter/
// ──────────────────────────────────────────────────────────────────────────

#import "lib.typ": *

#set document(title: flow.name)
#set page(
  paper: "a4",
  margin: (x: 2.2cm, top: 2.4cm, bottom: 2.6cm),
  // `context` is needed because the page counter depends on where the
  // footer is placed. `both: true` supplies current and final page numbers.
  footer: context align(center, text(size: 8pt, fill: muted)[
    #flow.name #h(0.8em) #counter(page).display("1 / 1", both: true)
  ]),
)
#set text(font: body-font, size: 10.5pt, fill: ink, lang: "en")
#set par(leading: 0.62em, spacing: 0.9em)
#show raw: set text(font: mono-font)
#show link: set text(fill: accent)

// Each step heading: numbered badge + title. `sticky` keeps the heading on
// the same page as whatever follows it.
#set heading(numbering: "1")
#show heading: it => block(
  sticky: true,
  above: 2.1em,
  below: 0.55em,
  grid(
    columns: (auto, 1fr),
    column-gutter: 0.7em,
    align: horizon,
    badge(context counter(heading).display("1")),
    text(size: 13pt, weight: "bold", it.body),
  ),
)

// ── Title block ──────────────────────────────────────────────────────────

#block(below: 0.7em, text(
  size: 8pt,
  weight: "bold",
  fill: accent,
  tracking: 0.14em,
  upper("Waystation flow"),
))
#block(below: 0.8em, text(size: 24pt, weight: "bold", flow.name))
#if flow.description != "" {
  block(below: 0.9em, text(size: 12pt, fill: muted, spans(flow.descriptionSpans)))
}
#block(below: 1.1em, text(size: 8.5pt, fill: muted, meta-line()))
#line(length: 100%, stroke: 0.6pt + hairline)

// ── Steps ────────────────────────────────────────────────────────────────

#for step in flow.steps {
  heading(step.title)
  if step.ref != none {
    block(above: 0pt, below: 0.8em, file-ref(step))
  }
  blocks(step.blocks)
  if step.lines.len() > 0 {
    code-panel(step.lines, step.lang, step.startLine, step.hitIndex)
  }
}

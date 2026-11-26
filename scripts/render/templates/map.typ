// ──────────────────────────────────────────────────────────────────────────
// Waystation flow → route map: one diagram, rich cards as nodes.
//
// The Mermaid idea (a route, boxed by file) drawn with the Typst cards
// (title, lines, note, highlighted code). Consecutive steps in the same file
// share a box.
//
// Two shapes, picked by `cols`:
//   • cols=1   one column, read top to bottom. The default for the full
//              map: it scrolls like the code it shows.
//   • cols>1   boxes run left to right and wrap into rows. The default for
//              the lighter detail levels, where cards are small.
//
// A flow is a single ordered path, so no graph-layout engine is needed. The
// placement rule is small and deterministic (see "Layout" below).
//
// Compile (in a folder holding flow.json, lib.typ and this file):
//   typst compile --input flow=flow.json map.typ map.svg
//   typst compile --input flow=flow.json --ppi 144 map.typ map.png
//
// Options:
//   --input detail=full     cards with note + code (default)
//   --input detail=notes    cards with note, no code
//   --input detail=titles   title-only cards: a compact overview
//   --input cols=1          boxes per row (default: 1 for full, 3 for notes,
//                           4 for titles)
//   --input card-width=400  card width in pt (default 400; 230 for titles)
//
// Read the computed geometry back as JSON (what the tests assert on):
//   typst eval 'query(<layout>).first().value' --in map.typ --input flow=flow.json
//
// References:
//   • measure():  https://typst.app/docs/reference/layout/measure/
//   • place():    https://typst.app/docs/reference/layout/place/
//   • curve():    https://typst.app/docs/reference/visualize/curve/
//   • polygon():  https://typst.app/docs/reference/visualize/polygon/
//   • metadata + query: https://typst.app/docs/reference/introspection/metadata/
// ──────────────────────────────────────────────────────────────────────────

#import "lib.typ": *

// ── Inputs and constants ─────────────────────────────────────────────────

#let detail = sys.inputs.at("detail", default: "full")
#let card-w = float(sys.inputs.at(
  "card-width",
  default: if detail == "titles" { "230" } else { "400" },
)) * 1pt

// Boxes per row. The full map defaults to a single column, top to bottom.
#let cols = int(sys.inputs.at(
  "cols",
  default: if detail == "full" { "1" } else if detail == "titles" { "4" } else { "3" },
))

#let lane-pad = 12pt // space between a box's edge and its cards
#let h-gap = 56pt // gutter between boxes in a row; arrows turn here
#let v-gap = 30pt // vertical space between stacked cards
// Space between rows. Wrapped rows need room for the "next row" arrow to
// run sideways; a single column only needs room for a short drop.
#let row-gap = if cols == 1 { 44pt } else { 60pt }
#let head-h = 36pt // band at the top of a box holding the file name
#let anchor = 22pt // how far below a card's top a sideways arrow lands
#let corner = 9pt // radius of an arrow's bend
#let lane-w = card-w + 2 * lane-pad

#set document(title: flow.name)
#set page(width: auto, height: auto, margin: 30pt, fill: rgb("#faf9f6"))
#set text(font: body-font, size: 10pt, fill: ink, lang: "en")
#set par(leading: 0.6em, spacing: 0.8em)
#show raw: set text(font: mono-font)
#show link: set text(fill: accent)

// ── Card ─────────────────────────────────────────────────────────────────

#let card(step) = block(
  width: card-w,
  fill: white,
  stroke: 0.6pt + hairline,
  radius: 6pt,
  inset: 12pt,
  {
    grid(
      columns: (auto, 1fr),
      column-gutter: 8pt,
      align: horizon,
      badge(str(step.n), size: 1.7em),
      text(size: 11.5pt, weight: "bold", step.title),
    )
    if step.ref != none {
      v(3pt)
      // The box header already names the file, so the card shows lines only.
      let label = text(
        font: mono-font,
        size: 7.5pt,
        fill: muted,
        "L" + str(step.line) + if step.endLine != none { "–" + str(step.endLine) } else { "" },
      )
      if step.url == none { label } else { link(step.url, label) }
    }
    if detail != "titles" and step.blocks.len() > 0 {
      v(6pt)
      text(size: 9pt, blocks(step.blocks))
    }
    if detail == "full" and step.lines.len() > 0 {
      v(4pt)
      code-panel(step.lines, step.lang, step.startLine, step.hitIndex, size: 7.2pt)
    }
  },
)

// ── Arrows ───────────────────────────────────────────────────────────────

#let wire-stroke = (paint: accent, thickness: 1.4pt, cap: "round", join: "round")

// -1, 0 or 1: which way `b` lies from `a` along one axis.
#let toward(a, b) = if b > a { 1 } else if b < a { -1 } else { 0 }
// Length in pt of an axis-aligned segment.
#let span(p, q) = calc.abs((q.at(0) - p.at(0)).pt()) + calc.abs((q.at(1) - p.at(1)).pt())

// `pts`: two or more (x, y) points, absolute within the canvas. Every
// segment is horizontal or vertical. Bends are rounded; the last segment
// ends in an arrowhead and always points right or down.
#let draw-wire(pts) = {
  let (x2, y2) = pts.at(-1)
  let (x1, y1) = pts.at(-2)
  let down = toward(x1, x2) == 0
  let head = 7pt
  // Stop the line short of the tip so its round cap hides under the head.
  let end = if down { (x2, y2 - head * 0.7) } else { (x2 - head * 0.7, y2) }

  let parts = (curve.move(pts.at(0)),)
  for i in range(1, pts.len() - 1) {
    let (p, v, q) = (pts.at(i - 1), pts.at(i), pts.at(i + 1))
    // Never round more than half of either neighbouring segment.
    let r = calc.min(corner.pt(), span(p, v) / 2, span(v, q) / 2) * 1pt
    parts.push(curve.line((
      v.at(0) - toward(p.at(0), v.at(0)) * r,
      v.at(1) - toward(p.at(1), v.at(1)) * r,
    )))
    // Quadratic bend: control point on the corner itself.
    parts.push(curve.quad(v, (
      v.at(0) + toward(v.at(0), q.at(0)) * r,
      v.at(1) + toward(v.at(1), q.at(1)) * r,
    )))
  }
  parts.push(curve.line(end))

  // A small dot marks where the arrow leaves the previous stop.
  let (x0, y0) = pts.at(0)
  place(top + left, dx: x0 - 2.6pt, dy: y0 - 2.6pt, circle(radius: 2.6pt, fill: accent))
  place(top + left, curve(stroke: wire-stroke, ..parts))
  place(top + left, polygon(
    fill: accent,
    ..if down {
      ((x2, y2), (x2 - head * 0.55, y2 - head), (x2 + head * 0.55, y2 - head))
    } else {
      ((x2, y2), (x2 - head, y2 - head * 0.55), (x2 - head, y2 + head * 0.55))
    },
  ))
}

// Keep a long path on one line: "…lines/buildFlowAggregate.ts".
#let fit-label(file, max-chars) = {
  let chars = file.clusters()
  if chars.len() <= max-chars { file } else { "…" + chars.slice(-(max-chars - 1)).join() }
}

// ── Layout ───────────────────────────────────────────────────────────────
//
// 1. Measure every card: its height depends on its text.
// 2. Group consecutive steps in the same file into a "visit". A file the
//    route comes back to later gets a second box, so the route only ever
//    moves forward.
// 3. Put visits in rows of `cols`, each box top-aligned in its row, cards
//    stacked inside.
// 4. Join consecutive steps:
//      same box      → straight down
//      next box      → out of the right side, into the left side of the
//                      next box's first card, bending in the gutter if the
//                      two cards sit at different heights
//      next row      → down into the gap between rows, back to the left
//                      edge, down, and into the first card from the left
//      single column → straight down onto the top edge of the next box
//                      (so the arrow never crosses the file name)
//    Gutters and row gaps hold nothing but arrows, so no arrow can run
//    through a card and no two cards can overlap.

#context {
  if flow.steps.len() == 0 {
    text(fill: muted)[This flow has no steps.]
    return
  }

  let cards = flow.steps.map(card)
  let heights = cards.map(c => measure(c).height)

  // Visits: (file, steps) where `steps` holds indices into flow.steps.
  let visits = ()
  for (i, step) in flow.steps.enumerate() {
    if visits.len() > 0 and visits.last().file == step.file {
      visits.at(visits.len() - 1).steps.push(i)
    } else {
      visits.push((file: step.file, steps: (i,)))
    }
  }

  // A left gutter is only needed when an arrow has to come back around.
  let gutter = if cols > 1 and visits.len() > cols { 26pt } else { 0pt }

  let pos = flow.steps.map(_ => none) // per step: (x, y, h, visit, row)
  let boxes = () // per visit: (x, y, w, h, file)
  let row-y = 0pt
  let row-h = 0pt
  let width = 0pt
  for (v, visit) in visits.enumerate() {
    let col = calc.rem(v, cols)
    if col == 0 and v > 0 {
      row-y += row-h + row-gap
      row-h = 0pt
    }
    let x = gutter + col * (lane-w + h-gap)
    // Cards start below the header band. A note-only visit has no header;
    // in a single column it gives that space back, so the arrow into it is
    // as short as the others. In rows it keeps the offset, so card tops in
    // a row stay level.
    let y = row-y + if visit.file == none and cols == 1 { 0pt } else { head-h }
    for i in visit.steps {
      pos.at(i) = (x: x + lane-pad, y: y, h: heights.at(i), visit: v, row: calc.quo(v, cols))
      y += heights.at(i) + v-gap
    }
    let box-h = y - v-gap + lane-pad - row-y
    boxes.push((x: x, y: row-y, w: lane-w, h: box-h, file: visit.file))
    row-h = calc.max(row-h, box-h)
    width = calc.max(width, x + lane-w)
  }
  let height = row-y + row-h

  let wires = () // per hop: array of (x, y) points
  for i in range(1, flow.steps.len()) {
    let a = pos.at(i - 1)
    let b = pos.at(i)
    let into-y = b.y + anchor
    if a.visit == b.visit {
      let cx = a.x + card-w / 2
      wires.push(((cx, a.y + a.h), (cx, b.y)))
    } else if a.row == b.row {
      let from = (a.x + card-w, a.y + anchor)
      let turn-x = a.x + card-w + lane-pad + h-gap / 2
      if from.at(1) == into-y {
        wires.push((from, (b.x, into-y)))
      } else {
        wires.push((from, (turn-x, from.at(1)), (turn-x, into-y), (b.x, into-y)))
      }
    } else if cols == 1 {
      // Top to bottom: drop from the last card onto the next box's top
      // edge. A note-only visit has no box, so land on its card instead.
      let cx = a.x + card-w / 2
      let target = boxes.at(b.visit)
      wires.push(((cx, a.y + a.h), (cx, if target.file == none { b.y } else { target.y })))
    } else {
      let cx = a.x + card-w / 2
      let gap-y = boxes.at(b.visit).y - row-gap / 2
      let left-x = gutter / 2
      wires.push((
        (cx, a.y + a.h),
        (cx, gap-y),
        (left-x, gap-y),
        (left-x, into-y),
        (b.x, into-y),
      ))
    }
  }

  // ── Title ──────────────────────────────────────────────────────────────
  block(width: calc.max(width, 300pt), below: 20pt, {
    block(below: 6pt, text(
      size: 8pt,
      weight: "bold",
      fill: accent,
      tracking: 0.14em,
      upper("Waystation flow"),
    ))
    block(below: 6pt, text(size: 20pt, weight: "bold", flow.name))
    if flow.description != "" {
      block(below: 6pt, text(size: 11pt, fill: muted, spans(flow.descriptionSpans)))
    }
    text(size: 8.5pt, fill: muted, meta-line())
  })

  // ── Canvas ─────────────────────────────────────────────────────────────
  // Drawn back to front: boxes, then arrows, then cards.
  box(width: width, height: height, {
    // DejaVu Sans Mono is 0.602em wide per character.
    let label-chars = calc.floor(card-w.pt() / (8 * 0.602))
    for b in boxes {
      // Note-only visits have no file: no box, no label, just the cards.
      if b.file != none {
        place(top + left, dx: b.x, dy: b.y, rect(
          width: b.w,
          height: b.h,
          radius: 9pt,
          fill: rgb("#f0eee7"),
          stroke: 0.6pt + hairline,
        ))
        place(top + left, dx: b.x + lane-pad, dy: b.y + 13pt, text(
          font: mono-font,
          size: 8pt,
          weight: "bold",
          fill: muted,
          fit-label(b.file, label-chars),
        ))
      }
    }
    for w in wires { draw-wire(w) }
    for (i, c) in cards.enumerate() {
      place(top + left, dx: pos.at(i).x, dy: pos.at(i).y, c)
    }
  })

  // Geometry in plain numbers (pt), for `typst eval` and the tests.
  [#metadata((
    width: width.pt(),
    height: height.pt(),
    card-width: card-w.pt(),
    cols: cols,
    cards: pos.map(p => (x: p.x.pt(), y: p.y.pt(), h: p.h.pt(), visit: p.visit, row: p.row)),
    boxes: boxes.map(b => (x: b.x.pt(), y: b.y.pt(), w: b.w.pt(), h: b.h.pt(), file: b.file)),
    wires: wires.map(w => w.map(p => (p.at(0).pt(), p.at(1).pt()))),
  )) <layout>]
}

// ──────────────────────────────────────────────────────────────────────────
// Typst target: emit DATA, not Typst source.
//
// Generating `.typ` markup from TypeScript would mean escaping every title,
// note, and code line against Typst's syntax. Instead the templates in
// ./templates/ are static and load the flow with Typst's own `json()`:
//
//   templates/lib.typ    shared helpers (note bodies, code panel)
//   templates/flow.typ   A4 document  → PDF
//   templates/cards.typ  one step per page, auto height → PNG / SVG cards
//   templates/map.typ    the whole route as one diagram, cards joined by
//                        arrows and boxed by file → SVG / PNG
//
// This module's only job is to hand them the normalised flow as JSON. Text
// arrives in Typst as strings, never as markup, so nothing in a flow can
// inject Typst code.
//
// References:
//   • json():      https://typst.app/docs/reference/data-loading/json/
//   • sys.inputs:  https://typst.app/docs/reference/foundations/sys/
//   • CLI export formats (pdf/png/svg) and page-number templates in output
//     paths: run `typst compile --help`
// ──────────────────────────────────────────────────────────────────────────

import { normalize } from './_shared.ts';
import type { FlowInput } from './_shared.ts';

/** File names of the static templates that sit beside the data file. */
export const TYPST_TEMPLATES: readonly string[] = ['lib.typ', 'flow.typ', 'cards.typ', 'map.typ'];

/**
 * Serialise the normalised flow for the Typst templates. Every `Step` key is
 * always present (null when unknown), which Typst reads as `none`.
 */
export function renderTypstData(input: FlowInput): string {
  return JSON.stringify(normalize(input), null, 2) + '\n';
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { renderTypstData } from './scripts/render/typst.ts';
//
// // 1. Data file for the templates
// JSON.parse(renderTypstData({ flow: { name: 'Demo' }, matches: [] })).name; // → 'Demo'
//
// // 2. Compile by hand (run inside a folder holding flow.json + the templates)
// // typst compile --input flow=flow.json flow.typ flow.pdf
// // typst compile --input flow=flow.json --ppi 144 cards.typ 'card-{0p}.png'
// // typst compile --input flow=flow.json cards.typ 'card-{0p}.svg'
// // typst compile --input flow=flow.json map.typ map.svg
// // typst compile --input flow=flow.json --input detail=titles map.typ overview.svg
//
// // 3. Restyle without editing the template
// // typst compile --input flow=flow.json --input accent='#7c3aed' --input font='Helvetica Neue' flow.typ

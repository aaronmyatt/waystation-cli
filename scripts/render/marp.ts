// ──────────────────────────────────────────────────────────────────────────
// Render a flow as a Marp slide deck: one step per slide, styled to match
// the HTML page (html.ts) — same colours, number badge, code panel with line
// numbers, and the same highlight on the focal line.
//
// Marp decks are plain markdown. Slides are split by `---` rulers and the
// front matter turns the file into a deck. Marp CLI exports the result to
// HTML, PDF, or PPTX.
//
// Everything here works with Marp's defaults: no `--html` flag, no theme
// file. The look comes from three Marp features:
//
//   1. `style:` in the front matter — CSS layered over the built-in theme.
//   2. `<style scoped>` on a slide — CSS for that slide only. Each code slide
//      uses it to hand its code panel three values: room for a number gutter
//      (`--gutter`), the line numbers (`--ln`), and which line to highlight
//      (`--hit`). Marpit reads `<style>` itself, so this is not "raw HTML"
//      and needs no flag.
//   3. `paginate` — Marp puts the page number on each slide as an attribute.
//      The theme draws it twice: as the round step badge, and as "3 / 9".
//      The title and route slides use `_paginate: skip`, so page numbers
//      equal step numbers.
//
// Slides have a fixed height, so each step's code window is trimmed to fit,
// centred on the focal line (see `codeBudget`). A step whose note leaves no
// room for code gets two slides: the note, then the code.
//
// Flow text is markdown, but never HTML: Marp lets a list of "safe" tags
// through, so every `<` outside code is written as an entity (see `noHtml`).
//
// References:
//   • Marpit markdown (slide rulers):        https://marpit.marp.app/markdown
//   • Directives (`paginate`, `_class`, `header`, `footer`, the `_` prefix):
//     https://marpit.marp.app/directives
//   • `style:` and `<style scoped>`:         https://marpit.marp.app/theme-css?id=tweak-style-through-markdown
//   • Marp's code auto-shrink (why the highlight lives on `code`, not `pre`):
//     https://github.com/marp-team/marp-core#auto-scaling-features
//   • Marp CLI (render to HTML/PDF/PPTX):    https://github.com/marp-team/marp-cli
//   • Fenced code rules (why the fence length varies):
//     https://spec.commonmark.org/0.31.2/#fenced-code-blocks
// ──────────────────────────────────────────────────────────────────────────

import { normalize, plural } from './_shared.ts';
import type { FlowInput, NormFlow, Step } from './_shared.ts';

/** Options for {@linkcode renderMarp}. */
export type MarpOptions = {
  /** Built-in Marp theme the deck's own CSS is layered over. Default `default`. */
  theme?: string;
  /** Max code lines per slide before trimming. Default 14. */
  maxLines?: number;
};

/** A slice of a step's code, cut to fit one slide. */
export type CodeWindow = {
  /** The lines shown. */
  lines: string[];
  /** True when some of the step's lines were left out. */
  cut: boolean;
  /** Index, within the step's lines, of the first line shown. */
  start: number;
};

// ── Slide geometry ───────────────────────────────────────────────────────
//
// A Marp slide is 1280 × 720 CSS px (the 16:9 default). These numbers are
// used twice: in the theme CSS, and to work out how many code lines fit.

const SLIDE_W = 1280;
const SLIDE_H = 720;
const PAD_X = 64;
const PAD_TOP = 62;
const PAD_BOTTOM = 52;
/** Title line height in px. Also the badge's diameter. */
const TITLE_LINE = 44;
/** Note text: 22px × 1.45. */
const NOTE_LINE = 32;
/** Code text: 16px × 1.5. A whole number, so the highlight band is crisp. */
const CODE_LINE = 24;
/** Space a code panel takes besides its lines: margin 16 + padding 28 + border 2. */
const PANEL_CHROME = 46;
/** Fewest code lines worth showing. Below this the code gets its own slide. */
const MIN_CODE_LINES = 4;
/** Rough characters per line, used only to guess how tall text will be. */
const NOTE_COLS = 84;
const TITLE_COLS = 54;
/** Steps listed on one route slide (two columns of seven). */
const ROUTE_PER_SLIDE = 14;

// ── Theme ────────────────────────────────────────────────────────────────

/**
 * CSS for the front matter's `style:` key. The palette is the HTML page's
 * (see `CSS` in html.ts); highlight.js token classes are mapped onto the
 * same six token colours.
 *
 * Code blocks: Marp wraps the content of every `pre` in a component that
 * shrinks it when a line is too wide. So the line numbers and the highlight
 * band are drawn on the inner `code` element — they shrink with the text and
 * stay lined up. `min-width` makes `code` fill the block when lines are short.
 *
 * A code block inside a note is a plain block. The step's own code panel is
 * the last `pre` on the slide; the slide's scoped style gives it `--gutter`,
 * `--ln` and `--hit`, which turn on the number gutter and the highlight.
 *
 *   • Line numbers: `code::before` shows the string in `--ln`.
 *     https://developer.mozilla.org/en-US/docs/Web/CSS/content
 *   • Highlight: two one-line-tall background layers moved down `--hit` lines.
 *     https://developer.mozilla.org/en-US/docs/Web/CSS/background-position
 *   • Badge and "3 / 9": `attr()` reads the page number Marp sets.
 *     https://developer.mozilla.org/en-US/docs/Web/CSS/attr
 *   • Slides read top-down: Marp's default theme is a block container
 *     centred with `align-content`, so that is the property to override.
 *     https://developer.mozilla.org/en-US/docs/Web/CSS/align-content
 */
function themeCss(): string {
  // 2px less than the content width: the panel's left and right borders.
  const codeW = SLIDE_W - 2 * PAD_X - 2;
  return `
section {
  --bg: #faf9f6; --ink: #1c1b19; --muted: #6b675f; --line: #e2ded5;
  --accent: #0f766e; --accent-soft: rgba(15,118,110,.11); --code-bg: #f3f1eb;
  --c: #8a857a; --s: #a1420f; --n: #955a00; --k: #6b3fd4; --f: #1f55c9; --t: #0f766e;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  width: ${SLIDE_W}px; height: ${SLIDE_H}px;
  padding: ${PAD_TOP}px ${PAD_X}px ${PAD_BOTTOM}px;
  align-content: start;
  background: var(--bg); color: var(--ink);
  font: 22px/1.45 var(--sans);
}
section a { color: var(--accent); }
section h1, section h2 { margin: 0; padding: 0; border: 0; color: var(--ink); }
section h2 { font-size: 34px; line-height: ${TITLE_LINE}px; letter-spacing: -.005em; }
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
  position: absolute; left: ${PAD_X}px; top: ${PAD_TOP}px; right: auto; bottom: auto;
  width: ${TITLE_LINE}px; height: ${TITLE_LINE}px; padding: 0; border-radius: 50%;
  background: var(--accent); color: #fff;
  font: 650 20px/${TITLE_LINE}px var(--sans); text-align: center;
  font-variant-numeric: tabular-nums;
}
section[data-marpit-pagination]::before {
  content: attr(data-marpit-pagination) " / " attr(data-marpit-pagination-total);
  position: absolute; right: ${PAD_X}px; bottom: 20px;
  font: 14px/1.4 var(--sans); color: var(--muted); font-variant-numeric: tabular-nums;
}

/* Breadcrumb (file:line) above the title; flow name below the content. */
section header, section footer {
  left: ${PAD_X}px; right: auto; margin: 0; color: var(--muted);
}
section header { top: 26px; font: 15px/1.4 var(--mono); }
section footer { bottom: 20px; font: 14px/1.4 var(--sans); }
section header a { color: inherit; text-decoration: none; }
section header code { padding: 0; background: none; font: inherit; }

/* Code blocks. The per-slide style sets --gutter, --ln and --hit on the step's panel. */
section pre {
  margin: 16px 0 0; padding: 14px 0; overflow: hidden;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--code-bg); font: 16px/${CODE_LINE}px var(--mono); tab-size: 2;
}
section > pre > code { min-width: ${codeW}px; }
section pre > code {
  display: block; position: relative; box-sizing: border-box;
  padding: 0 20px 0 var(--gutter, 20px); color: var(--ink); font: inherit;
  background-color: transparent;
  background-image:
    linear-gradient(var(--accent), var(--accent)),
    linear-gradient(var(--accent-soft), var(--accent-soft));
  background-repeat: no-repeat;
  background-size: 3px ${CODE_LINE}px, 100% ${CODE_LINE}px;
  background-position: 0 calc(var(--hit, -1) * ${CODE_LINE}px);
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
`.trim();
}

// ── Code windows ─────────────────────────────────────────────────────────

/**
 * Pick the fence for a code block. CommonMark closes a fence only on a run
 * of backticks at least as long as the opener, so code that itself contains
 * ``` needs a longer fence.
 */
export function fenceFor(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Trim a step's context to `max` lines, keeping the focal line in view. */
export function windowLines(step: Step, max: number): CodeWindow {
  if (step.lines.length <= max) return { lines: step.lines, cut: false, start: 0 };
  const centre = step.hitIndex >= 0 ? step.hitIndex : 0;
  const start = Math.max(0, Math.min(centre - Math.floor(max / 2), step.lines.length - max));
  return { lines: step.lines.slice(start, start + max), cut: true, start };
}

/**
 * How many code lines fit on this step's slide, never more than `max`. Zero
 * or less means the note leaves no room for code at all.
 *
 * An estimate, not a measurement: the slide's free height, minus the title
 * and a guess at the note's height, divided by the height of a code line.
 * A long note gets a shorter code window instead of pushing the code off the
 * bottom of the slide.
 */
export function codeBudget(step: Step, max: number): number {
  const titleLines = Math.max(1, Math.ceil(step.title.length / TITLE_COLS));
  // Each source line wraps to one or more slide lines; a blank line is a
  // paragraph gap, a bit under half a line.
  const noteLines = step.body.split('\n').reduce(
    (sum, line) => sum + (line.trim() ? Math.ceil(line.length / NOTE_COLS) : 0.45),
    0,
  );
  const note = step.body.trim() ? 14 + noteLines * NOTE_LINE : 0;
  const free = SLIDE_H - PAD_TOP - PAD_BOTTOM - titleLines * TITLE_LINE - note - PANEL_CHROME;
  return Math.min(max, Math.floor(free / CODE_LINE));
}

// ── Slides ───────────────────────────────────────────────────────────────

/**
 * Keep flow text from being read as HTML. Marp passes a list of "safe" tags
 * through even without `--html`, so a stray `<b>` in a title would swallow
 * the rest of its slide, and `<!--` or `<style>` in a note would be read as
 * deck directives. Every `<` outside inline code and fenced blocks becomes
 * `&lt;`, which markdown shows as a plain `<`.
 * Ref: https://github.com/marp-team/marp-core#html-boolean--object
 */
export function noHtml(text: string): string {
  let fenced = false;
  return text.split('\n').map((line) => {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      return line;
    }
    // The first alternative swallows whole code spans so they pass through.
    return fenced ? line : line.replace(/`[^`]*`|</g, (m) => (m === '<' ? '&lt;' : m));
  }).join('\n');
}

/** A lone `---` in a note would split the slide; soften it to `***`. */
function slideSafe(body: string): string {
  return body.replace(/^\s*---+\s*$/gm, '***');
}

/**
 * A directive comment. JSON.stringify yields a valid double-quoted YAML
 * scalar; `-->` inside the value would end the comment early, so its `>` is
 * written as a YAML unicode escape.
 */
function directive(key: string, value: string): string {
  return `<!-- ${key}: ${JSON.stringify(value).replaceAll('-->', '--\\u003e')} -->`;
}

/** Text safe to use as a markdown link label. */
function linkLabel(text: string): string {
  return text.replace(/[\[\]\\]/g, '\\$&');
}

function titleSlide(flow: NormFlow): string {
  const meta = [flow.repo, flow.branch, flow.commit?.slice(0, 7)]
    .filter(Boolean).map((v) => `\`${v}\``);
  meta.push(plural(flow.steps.length, 'step'), plural(flow.files.length, 'file'));
  return [
    // The `_` prefix scopes a directive to this slide only. `skip` leaves the
    // slide out of the page count, so step 1 is page 1.
    '<!-- _class: lead -->',
    '<!-- _paginate: skip -->',
    '<!-- _footer: "" -->',
    'Waystation flow',
    `# ${noHtml(flow.name)}`,
    noHtml(flow.description),
    meta.join(' · '),
  ].filter(Boolean).join('\n\n');
}

/** Number of route slides a flow needs. A one-step flow needs no map. */
function routeCount(steps: number): number {
  return steps < 2 ? 0 : Math.ceil(steps / ROUTE_PER_SLIDE);
}

/**
 * The step list: the deck's version of the HTML page's side rail. Each entry
 * links to its slide — Marp gives every slide its position as an id, so
 * `#4` jumps to the fourth slide. `positions[i]` is the slide of step `i`.
 */
function routeSlides(flow: NormFlow, positions: number[]): string[] {
  const count = routeCount(flow.steps.length);
  const slides: string[] = [];
  for (let i = 0; i < flow.steps.length && count > 0; i += ROUTE_PER_SLIDE) {
    // A markdown list that starts at `15.` keeps counting from 15.
    const items = flow.steps.slice(i, i + ROUTE_PER_SLIDE).map((s, k) =>
      `${s.n}. [${linkLabel(noHtml(s.title))}](#${positions[i + k]})` +
      (s.ref ? ` \`${s.ref}\`` : '')
    );
    slides.push([
      '<!-- _class: route -->',
      '<!-- _paginate: skip -->',
      count > 1 ? `## Route (${slides.length + 1} of ${count})` : '## Route',
      items.join('\n'),
    ].join('\n\n'));
  }
  return slides;
}

/** `file:line`, linked when the flow knows its repo, plus a note when the code is trimmed. */
function breadcrumb(step: Step, win: CodeWindow | null): string {
  const parts: string[] = [];
  if (step.ref) {
    const ref = `\`${step.ref}\``;
    parts.push(step.url ? `[${ref}](${step.url})` : ref);
  }
  if (win?.cut) parts.push(`showing ${win.lines.length} of ${step.lines.length} lines`);
  return parts.join(' · ');
}

/** The step's code panel: its per-slide style, then the fenced block. */
function codePanel(step: Step, win: CodeWindow): string {
  const first = (step.startLine ?? 1) + win.start;
  // `\A ` is a newline inside a CSS string: one number per code line.
  // https://developer.mozilla.org/en-US/docs/Web/CSS/string#escape_sequences
  const numbers = win.lines.map((_, i) => first + i).join('\\A ');
  // A range capture has no single focal line (hitIndex -1): no band.
  const hit = step.hitIndex >= 0 ? step.hitIndex - win.start : -1;
  const code = win.lines.join('\n');
  const fence = fenceFor(code);
  return [
    // The panel is the last `pre` on the slide; any `pre` before it is a code
    // block from the note and stays plain.
    `<style scoped>section > pre:last-of-type { --gutter: 4.8em; --ln: "${numbers}"; --hit: ${hit}; }</style>`,
    `${fence}${step.lang}\n${code}\n${fence}`,
  ].join('\n\n');
}

/** One step's slides: usually one; two when the note leaves no room for code. */
function stepSlides(step: Step, max: number): string[] {
  // No number in the heading: the badge shows it.
  const title = `## ${noHtml(step.title)}`;
  const body = step.body ? slideSafe(noHtml(step.body)) : '';
  const join = (...parts: string[]): string => parts.filter(Boolean).join('\n\n');
  const head = (win: CodeWindow | null): string => {
    const crumb = breadcrumb(step, win);
    return crumb ? directive('_header', crumb) : '';
  };
  if (!step.lines.length) return [join(head(null), title, body)];

  const budget = codeBudget(step, max);
  if (budget >= MIN_CODE_LINES) {
    const win = windowLines(step, budget);
    return [join(head(win), title, body, codePanel(step, win))];
  }
  // Note first, then the code on a slide of its own. `hold` repeats the page
  // number instead of counting on, so both slides carry this step's badge.
  const alone = Math.max(MIN_CODE_LINES, codeBudget({ ...step, body: '' }, max));
  const win = windowLines(step, alone);
  return [
    join(head(null), title, body),
    join('<!-- _paginate: hold -->', head(win), title, codePanel(step, win)),
  ];
}

/** Render an aggregate as Marp-flavoured markdown. */
export function renderMarp(input: FlowInput, opts: MarpOptions = {}): string {
  const flow = normalize(input);
  const max = opts.maxLines ?? 14;
  const front = [
    '---',
    'marp: true',
    `theme: ${opts.theme ?? 'default'}`,
    'size: 16:9',
    'paginate: true',
    // JSON.stringify yields a valid double-quoted YAML scalar.
    `title: ${JSON.stringify(flow.name)}`,
    `footer: ${JSON.stringify(noHtml(flow.name))}`,
    'style: |',
    ...themeCss().split('\n').map((line) => (line ? `  ${line}` : '')),
    '---',
  ].join('\n');

  const perStep = flow.steps.map((s) => stepSlides(s, max));
  // Slide number of each step's first slide, for the route's links: after the
  // title slide and the route slides.
  let next = 1 + routeCount(flow.steps.length) + 1;
  const positions = perStep.map((slides) => {
    const at = next;
    next += slides.length;
    return at;
  });
  const slides = [titleSlide(flow), ...routeSlides(flow, positions), ...perStep.flat()];
  // The front matter's closing `---` already opens the first slide, so only
  // the slides themselves are joined with rulers.
  return front + '\n\n' + slides.join('\n\n---\n\n') + '\n';
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { codeBudget, fenceFor, noHtml, renderMarp } from './scripts/render/marp.ts';
//
// // 1. Title slide + one slide per step (a one-step flow has no route slide)
// const deck = renderMarp({ flow: { name: 'Demo' }, matches: [
//   { step_content: { title: 'Intro', body: 'Hello' } },
// ] });
// deck.split('\n---\n').length; // → 3 (front matter close, title, step)
//
// // 2. Code containing ``` gets a longer fence
// fenceFor('md += "```" + lang'); // → '````'
//
// // 3. A long note leaves room for fewer code lines
// const step = { title: 'T', body: 'x'.repeat(84 * 8) };
// codeBudget({ ...step, body: '' } as any, 14); // → 14
// codeBudget(step as any, 14);                  // → 10
//
// // 4. Flow text is never HTML, but code keeps its angle brackets
// noHtml('Returns <b> or `Map<string, T>`'); // → 'Returns &lt;b> or `Map<string, T>`'
//
// // 5. Render with Marp CLI (no --html flag needed)
// // npx @marp-team/marp-cli flow.marp.md -o flow.slides.html
// // npx @marp-team/marp-cli flow.marp.md --pdf
// // npx @marp-team/marp-cli flow.marp.md --pptx

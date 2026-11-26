// ──────────────────────────────────────────────────────────────────────────
// Render a flow as ONE self-contained HTML file.
//
// No JavaScript, no network requests, no dependencies: inline CSS only. The
// file can be emailed, attached to a PR, or opened from disk.
//
//   • Sticky step rail on wide screens, hidden on narrow ones.
//   • Each step's code sits in a <details> so it folds without JS.
//   • Light and dark follow the OS via `prefers-color-scheme`.
//   • Print styles double as the PDF path (browser → Print → Save as PDF).
//
// References:
//   • <details>/<summary>: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/details
//   • prefers-color-scheme: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme
//   • Print media queries:  https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_media_queries/Printing
// ──────────────────────────────────────────────────────────────────────────

import { escapeHtml, normalize, plural } from './_shared.ts';
import type { Block, FlowInput, NormFlow, Span, Step } from './_shared.ts';

/** Options for {@linkcode renderHtml}. */
export type HtmlOptions = {
  /** Emit syntax-colour spans. Default true. */
  highlight?: boolean;
  /** Paper size for print / PDF. Default `A4`. */
  paper?: 'A4' | 'Letter';
};

// ── Syntax highlighting (tiny, line-based) ───────────────────────────────
//
// A deliberately small tokenizer: comments, strings, numbers, keywords,
// call names, type-ish names. It works a line at a time, so multi-line
// strings are not tracked. That trade keeps the file dependency-free; swap
// in a real highlighter here if exact colours ever matter.

type Family = 'c' | 'py' | 'rb' | 'sh' | 'sql' | 'data';

const FAMILY: Record<string, Family> = {
  typescript: 'c',
  javascript: 'c',
  go: 'c',
  rust: 'c',
  c: 'c',
  cpp: 'c',
  java: 'c',
  kotlin: 'c',
  swift: 'c',
  php: 'c',
  css: 'c',
  scss: 'c',
  python: 'py',
  ruby: 'rb',
  bash: 'sh',
  sql: 'sql',
  json: 'data',
  yaml: 'data',
  toml: 'data',
};

const words = (s: string): Set<string> => new Set(s.split(' '));

const KEYWORDS: Record<Family, Set<string>> = {
  c: words(
    'abstract as async await break case catch class const continue default defer delete do else ' +
      'enum export extends false final finally fn for func function go if impl implements import ' +
      'in instanceof interface let match mut new nil null of package private protected pub public ' +
      'readonly return self static struct super switch this throw true try type typeof undefined ' +
      'use var void while yield',
  ),
  py: words(
    'and as assert async await break class continue def del elif else except False finally for ' +
      'from global if import in is lambda None nonlocal not or pass raise return True try while ' +
      'with yield',
  ),
  rb: words(
    'alias and begin break case class def do else elsif end ensure false for if in module next ' +
      'nil not or redo rescue retry return self super then true undef unless until when while yield',
  ),
  sh: words(
    'case do done elif else esac export fi for function if in local return then until while',
  ),
  sql: words(
    'select from where and or not null is in as join left right inner outer on group by order ' +
      'having limit insert into values update set delete create table index if exists primary key ' +
      'foreign references default case when then else end asc desc distinct union all',
  ),
  data: words('true false null'),
};

/** Line-comment opener per family. JSON has none, but YAML/TOML use `#`. */
const LINE_COMMENT: Record<Family, string> = {
  c: String.raw`\/\/.*`,
  py: '#.*',
  rb: '#.*',
  sh: '#.*',
  sql: '--.*',
  data: '#.*',
};

const STRING = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|` + '`(?:[^`\\\\]|\\\\.)*`';
const NUMBER = String.raw`\b\d[\d_]*(?:\.\d+)?\b`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

/** Build the per-family token regex. Group order = token class. */
function tokenRegex(family: Family): RegExp {
  const block = family === 'c' ? String.raw`|\/\*.*?(?:\*\/|$)` : '';
  return new RegExp(
    `(${LINE_COMMENT[family]}${block})|(${STRING})|(${NUMBER})|(${IDENT})`,
    'g',
  );
}

const span = (cls: string, text: string): string =>
  `<span class="${cls}">${escapeHtml(text)}</span>`;

/**
 * Highlight a block of lines. Returns one HTML string per input line.
 * Unknown languages come back escaped but uncoloured.
 */
export function highlightLines(lines: string[], lang: string): string[] {
  const family = FAMILY[lang];
  if (!family) return lines.map(escapeHtml);
  const re = tokenRegex(family);
  const keywords = KEYWORDS[family];
  // Tracks an unclosed `/* … ` so following lines stay comment-coloured.
  let inBlock = false;

  return lines.map((line) => {
    if (family === 'c') {
      if (inBlock) {
        if (line.includes('*/')) inBlock = false;
        return span('c', line);
      }
      // A snippet may start mid-JSDoc; ` * text` lines are comment bodies.
      if (/^\s*\*(\s|\/|$)/.test(line)) return span('c', line);
    }
    let out = '';
    let last = 0;
    for (const m of line.matchAll(re)) {
      out += escapeHtml(line.slice(last, m.index));
      const [text, comment, str, num, ident] = m;
      const end = m.index + text.length;
      if (comment !== undefined) {
        out += span('c', text);
        if (text.startsWith('/*') && !text.endsWith('*/')) inBlock = true;
      } else if (str !== undefined) out += span('s', text);
      else if (num !== undefined) out += span('n', text);
      else if (keywords.has(family === 'sql' ? ident.toLowerCase() : ident)) out += span('k', text);
      else if (line[end] === '(') out += span('f', text);
      else if (/^[A-Z][a-z]/.test(ident)) out += span('t', text);
      else out += escapeHtml(text);
      last = end;
    }
    return out + escapeHtml(line.slice(last));
  });
}

// ── Note bodies ──────────────────────────────────────────────────────────

function spansToHtml(spans: Span[]): string {
  return spans.map((s) => {
    const v = escapeHtml(s.v);
    switch (s.t) {
      case 'code':
        return `<code>${v}</code>`;
      case 'strong':
        return `<strong>${v}</strong>`;
      case 'em':
        return `<em>${v}</em>`;
      case 'link':
        // `href` was scheme-checked in parseInline; escaping covers the rest.
        return `<a href="${escapeHtml(s.href)}">${v}</a>`;
      default:
        return v;
    }
  }).join('');
}

function blocksToHtml(blocks: Block[]): string {
  return blocks.map((b) => {
    switch (b.t) {
      case 'p':
        return `<p>${spansToHtml(b.spans)}</p>`;
      case 'ul':
      case 'ol':
        return `<${b.t}>${b.items.map((i) => `<li>${spansToHtml(i)}</li>`).join('')}</${b.t}>`;
      case 'code':
        return `<pre class="inline-code"><code>${escapeHtml(b.v)}</code></pre>`;
    }
  }).join('\n');
}

// ── Page pieces ──────────────────────────────────────────────────────────

/** Longest code block that print keeps on a single page. */
const KEEP_LINES = 30;

function codeHtml(step: Step, highlight: boolean): string {
  if (!step.lines.length) return '';
  const rendered = highlight ? highlightLines(step.lines, step.lang) : step.lines.map(escapeHtml);
  // Line numbers live in `data-n` and are drawn by CSS ::before, so selecting
  // and copying the code never picks them up. The spans are joined without
  // newlines: each is display:block, and a literal "\n" inside <pre> would
  // add a blank row between them.
  const rows = rendered.map((html, i) =>
    `<span class="ln${i === step.hitIndex ? ' hit' : ''}" data-n="${
      step.startLine + i
    }">${html}</span>`
  ).join('');
  // Blocks up to KEEP_LINES stay whole in print (`break-inside: avoid`).
  // Longer ones may split across pages: forcing a tall block to stay whole
  // is what leaves a half-empty page behind.
  const keep = step.lines.length <= KEEP_LINES ? ' keep' : '';
  return `<details class="code${keep}" open>
<summary><span class="path">${escapeHtml(step.ref ?? '')}</span><span class="lang">${
    escapeHtml(step.lang)
  }</span></summary>
<pre><code>${rows}</code></pre>
</details>`;
}

function stepHtml(step: Step, highlight: boolean): string {
  const loc = !step.ref
    ? ''
    : step.url
    ? `<a class="loc" href="${escapeHtml(step.url)}">${
      escapeHtml(step.ref)
    } <span aria-hidden="true">↗</span></a>`
    : `<span class="loc">${escapeHtml(step.ref)}</span>`;
  return `<li class="step" id="step-${step.n}">
<span class="badge" aria-hidden="true">${step.n}</span>
<h2>${escapeHtml(step.title)}</h2>
${loc}
${step.blocks.length ? `<div class="note">${blocksToHtml(step.blocks)}</div>` : ''}
${codeHtml(step, highlight)}
</li>`;
}

function railHtml(flow: NormFlow): string {
  const items = flow.steps.map((s) =>
    `<li><a href="#step-${s.n}"><span class="n">${s.n}</span><span class="t">${
      escapeHtml(s.title)
    }</span></a></li>`
  ).join('\n');
  return `<nav class="rail" aria-label="Steps"><p class="rail-title">Route</p><ol>\n${items}\n</ol></nav>`;
}

function metaHtml(flow: NormFlow): string {
  const chips: string[] = [];
  if (flow.repo) chips.push(`<span class="chip">${escapeHtml(flow.repo)}</span>`);
  if (flow.branch) chips.push(`<span class="chip">${escapeHtml(flow.branch)}</span>`);
  if (flow.commit) {
    chips.push(`<span class="chip mono">${escapeHtml(flow.commit.slice(0, 7))}</span>`);
  }
  chips.push(`<span class="chip">${plural(flow.steps.length, 'step')}</span>`);
  if (flow.files.length) {
    chips.push(`<span class="chip">${plural(flow.files.length, 'file')}</span>`);
  }
  return `<p class="meta">${chips.join('')}</p>`;
}

// ── Stylesheet ───────────────────────────────────────────────────────────
//
// Colours are custom properties so the dark block only swaps values.
// Token classes: c comment · s string · n number · k keyword · f call · t type.
//
// The `@media print` block is a second layout, not an afterthought. It is
// what makes "print this page" the PDF export:
//   • `print-color-adjust: exact` asks the browser to print fills (badges,
//     code panels, hit line) even when "Background graphics" is unticked.
//     https://developer.mozilla.org/en-US/docs/Web/CSS/print-color-adjust
//   • Steps may split across pages; headings, notes and short code blocks
//     may not. https://developer.mozilla.org/en-US/docs/Web/CSS/break-inside
//   • `code` becomes display:block. An inline-block cannot be split, so a
//     long listing would otherwise jump whole to the next page.
//   • Wrapped code lines hang under the code, not under the line number
//     (padding-left + negative text-indent).
//   • The dark palette is `screen`-only, so paper is always dark-on-white.
const CSS = `
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
`.trim();

// ── Page rule (print) ────────────────────────────────────────────────────

/**
 * Escape text for a double-quoted CSS string. `<` is hex-escaped so a flow
 * name can never spell `</style>` and end the stylesheet early.
 * Ref: https://www.w3.org/TR/css-syntax-3/#consume-string-token
 */
export function cssString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\3c ')
    .replace(/\s+/g, ' ');
}

/**
 * The `@page` rule: paper size, margins, and a running footer in the bottom
 * margin ("flow name · 2 / 5"). Margin boxes need Chrome 131+; browsers
 * without them simply print no footer. Custom properties are not relied on
 * inside the margin box, hence the literal font and colour.
 * Refs: https://developer.mozilla.org/en-US/docs/Web/CSS/@page
 *       https://developer.chrome.com/blog/print-margins
 */
function pageCss(flow: NormFlow, paper: 'A4' | 'Letter'): string {
  return `@page{size:${paper};margin:16mm 16mm 19mm;
  @bottom-center{content:"${
    cssString(flow.name)
  }  \\b7  " counter(page) " / " counter(pages);font:7.5pt ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#6b675f}
}`;
}

// ── Entry point ──────────────────────────────────────────────────────────

/** Render an aggregate as a complete, self-contained HTML document. */
export function renderHtml(input: FlowInput, opts: HtmlOptions = {}): string {
  const flow = normalize(input);
  const highlight = opts.highlight ?? true;
  const desc = flow.description ? `<p class="desc">${spansToHtml(flow.descriptionSpans)}</p>` : '';
  const footer = [flow.repo, flow.updatedAt ? `updated ${flow.updatedAt}` : null]
    .filter(Boolean).map((v) => escapeHtml(String(v))).join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(flow.name)}</title>
<style>
${CSS}
${pageCss(flow, opts.paper ?? 'A4')}
</style>
</head>
<body>
<div class="page">
${railHtml(flow)}
<main>
<header>
<p class="eyebrow">Waystation flow</p>
<h1>${escapeHtml(flow.name)}</h1>
${desc}
${metaHtml(flow)}
</header>
<ol class="steps">
${flow.steps.map((s) => stepHtml(s, highlight)).join('\n')}
</ol>
<footer>Waystation flow${footer ? ` · ${footer}` : ''}</footer>
</main>
</div>
</body>
</html>
`;
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { highlightLines, renderHtml } from './scripts/render/html.ts';
//
// // 1. Whole page from a tiny aggregate
// renderHtml({ flow: { name: 'Demo' }, matches: [
//   { step_content: { title: 'Intro', body: 'Hello **world**' } },
// ] }).includes('<h2>Intro</h2>'); // → true
//
// // 2. Titles are escaped, never interpreted
// renderHtml({ flow: { name: '<script>x</script>' }, matches: [] }).includes('<script>'); // → false
//
// // 3. Highlighter on its own
// highlightLines(['const a = "b"; // c'], 'typescript');
// // → ['<span class="k">const</span> a = <span class="s">&quot;b&quot;</span>; <span class="c">// c</span>']
//
// // 4. From the checked-in fixture (Deno)
// // deno run --allow-read scripts/render/render.ts html scripts/render/fixtures/flow.json > flow.html

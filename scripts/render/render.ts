// ──────────────────────────────────────────────────────────────────────────
// CLI wrapper around the render scripts.
//
//   render.ts <format> [input]            one format → stdout (pipeable)
//   render.ts all [input] [--out-dir DIR] every format → files, then compile
//                                         with typst / mmdc / marp / Chrome when present
//
//   format: html | mermaid | marp | codetour | typst
//   input:  aggregate JSON (`way show <flow> --json`) or the markdown from
//           `way export <flow> --frontmatter`. Omit or pass `-` for stdin.
//
// Runtime-agnostic: only `node:` built-ins, which Deno, Node and Bun all
// provide. The renderers themselves import nothing.
//
//   deno run --allow-read --allow-write --allow-run scripts/render/render.ts all flow.json
//   node scripts/render/render.ts html flow.json > flow.html
//   bun  scripts/render/render.ts mermaid flow.json
//   way show my-flow --json | deno run scripts/render/render.ts marp > deck.md
//
// References:
//   • Deno's Node built-in support: https://docs.deno.com/runtime/fundamentals/node/#node-built-in-modules
//   • Node running .ts directly:    https://nodejs.org/api/typescript.html#type-stripping
//   • child_process.spawnSync:      https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options
// ──────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalize, parseInput, slugify } from './_shared.ts';
import type { FlowInput } from './_shared.ts';
import { renderCodeTour } from './codetour.ts';
import { renderHtml } from './html.ts';
import { renderMarp } from './marp.ts';
import { renderMermaid } from './mermaid.ts';
import { renderTypstData, TYPST_TEMPLATES } from './typst.ts';

const USAGE = `render — turn a waystation flow into shareable artifacts

USAGE
  render.ts <format> [input]              Print one format to stdout.
  render.ts all [input] [--out-dir DIR]   Write every format (default DIR: dist/render).

FORMATS
  html       Self-contained page (inline CSS, no JS).
  mermaid    Flowchart of the route, boxed by file.
  marp       Slide deck markdown, one step per slide.
  codetour   VS Code CodeTour .tour JSON.
  typst      Normalised JSON for the Typst templates (flow, cards, map).

INPUT
  A file path, or stdin when omitted or "-". Either aggregate JSON
  (way show <flow> --json) or markdown from way export <flow> --frontmatter.
`;

/** Text renderers, keyed by format name. Each is pure: aggregate → string. */
const RENDERERS: Record<string, (input: FlowInput) => string> = {
  html: renderHtml,
  mermaid: renderMermaid,
  marp: renderMarp,
  codetour: renderCodeTour,
  typst: renderTypstData,
};

// ── I/O helpers ──────────────────────────────────────────────────────────

/**
 * Read the flow from a path, or from stdin. Stdin goes through the
 * `process.stdin` stream rather than `readFileSync('/dev/stdin')`: Deno
 * treats that path as a device and demands --allow-all for it, while the
 * stream needs no permission on any of the three runtimes.
 * Ref: https://nodejs.org/api/process.html#processstdin
 */
async function readFlow(path: string | undefined): Promise<FlowInput> {
  if (path && path !== '-') return parseInput(readFileSync(path, 'utf8'));
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return parseInput(text);
}

/**
 * Run an external tool. Returns false (and says why) when the tool is not
 * installed or exits non-zero, so one missing tool never aborts the rest.
 */
function tryRun(cmd: string, args: string[], cwd: string, quiet = false): boolean {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.error) {
    const missing = (res.error as { code?: string }).code === 'ENOENT';
    console.error(`  skip  ${cmd}: ${missing ? 'not on PATH' : res.error.message}`);
    return false;
  }
  if (res.status !== 0) {
    console.error(`  FAIL  ${cmd} ${args.join(' ')}\n${res.stderr}`);
    return false;
  }
  // Tools like typst print warnings on stderr even on success; surface them.
  // `quiet` is for tools whose stderr is routine chatter (headless Chrome).
  if (!quiet && res.stderr.trim()) console.error(res.stderr.trim());
  return true;
}

// ── HTML → PDF through a Chromium-family browser ─────────────────────────

/**
 * Where to look for a browser, in order. `CHROME_PATH` wins. App-bundle
 * paths cover macOS; the bare names cover Linux installs on PATH.
 */
function browserCandidates(): string[] {
  return [
    process.env.CHROME_PATH ?? '',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    'google-chrome',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
  ].filter((c) => c && (!c.startsWith('/') || existsSync(c)));
}

/**
 * Print an HTML file to PDF with headless Chrome. The page's own
 * `@media print` + `@page` rules (see html.ts) decide the layout; this only
 * drives the browser. Returns false when no browser is available.
 *
 *   --headless=new                   no window
 *   --user-data-dir=<temp>           a throwaway profile, so the run never
 *                                    attaches to (or touches) a Chrome that
 *                                    is already open
 *   --no-pdf-header-footer           drop Chrome's date/URL header + footer
 *   --generate-pdf-document-outline  PDF bookmarks from the headings
 *
 * Ref: https://developer.chrome.com/docs/chromium/headless
 */
function htmlToPdf(htmlPath: string, pdfPath: string): boolean {
  const profile = mkdtempSync(join(tmpdir(), 'way-render-'));
  try {
    for (const browser of browserCandidates()) {
      const args = [
        '--headless=new',
        `--user-data-dir=${profile}`,
        '--no-pdf-header-footer',
        '--generate-pdf-document-outline',
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
      ];
      const res = spawnSync(browser, args, { encoding: 'utf8' });
      if (!res.error && res.status === 0 && existsSync(pdfPath)) return true;
    }
    console.error('  skip  html → pdf: no Chromium-family browser found (set CHROME_PATH)');
    return false;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

// ── `all`: write every artifact into one folder ──────────────────────────

function renderAll(input: FlowInput, outDir: string): void {
  const slug = slugify(normalize(input).name);
  const typstDir = join(outDir, 'typst');
  mkdirSync(join(typstDir, 'cards'), { recursive: true });

  const write = (name: string, text: string): void => {
    writeFileSync(join(outDir, name), text);
    console.log(`  wrote ${join(outDir, name)}`);
  };

  write(`${slug}.html`, renderHtml(input));
  // The PDF is the HTML page printed: one layout source for screen and paper.
  if (htmlToPdf(join(outDir, `${slug}.html`), join(outDir, `${slug}.pdf`))) {
    console.log(`  built ${join(outDir, `${slug}.pdf`)} (from the HTML)`);
  }
  write(`${slug}.mmd`, renderMermaid(input));
  write(`${slug}.marp.md`, renderMarp(input));
  write(`${slug}.tour`, renderCodeTour(input));
  write(join('typst', 'flow.json'), renderTypstData(input));

  // Copy the templates beside the data so the folder compiles on its own
  // and a template can be tweaked there without touching the originals.
  const templates = join(dirname(fileURLToPath(import.meta.url)), 'templates');
  for (const name of TYPST_TEMPLATES) copyFileSync(join(templates, name), join(typstDir, name));

  // Typst: document PDF, then one PNG and one SVG card per step. The output
  // format is inferred from the extension; `{0p}` is the zero-padded page.
  const flowArg = ['--input', 'flow=flow.json'];
  const typst = (...args: string[]): boolean =>
    tryRun('typst', ['compile', ...flowArg, ...args], typstDir);
  // Kept beside the HTML-printed PDF for comparison, under its own name.
  if (typst('flow.typ', `../${slug}.typst.pdf`)) {
    console.log(`  built ${join(outDir, `${slug}.typst.pdf`)}`);
  }
  if (typst('--ppi', '144', 'cards.typ', 'cards/card-{0p}.png')) {
    console.log(`  built ${join(typstDir, 'cards')}/card-N.png`);
  }
  if (typst('cards.typ', 'cards/card-{0p}.svg')) {
    console.log(`  built ${join(typstDir, 'cards')}/card-N.svg`);
  }

  // Route map: the whole flow as one picture (cards + arrows, boxed by
  // file). The full map is a single column read top to bottom (map.typ's
  // default for full detail); the title-only overview wraps into rows.
  const maps: [string, string[]][] = [
    [`${slug}.map.svg`, []],
    [`${slug}.map.png`, ['--ppi', '144']],
    [`${slug}.map-overview.svg`, ['--input', 'detail=titles']],
  ];
  for (const [name, extra] of maps) {
    if (typst(...extra, 'map.typ', `../${name}`)) console.log(`  built ${join(outDir, name)}`);
  }

  // Mermaid CLI: route map as SVG. https://github.com/mermaid-js/mermaid-cli
  if (tryRun('mmdc', ['-i', `${slug}.mmd`, '-o', `${slug}.mmd.svg`, '-b', 'transparent'], outDir)) {
    console.log(`  built ${join(outDir, `${slug}.mmd.svg`)}`);
  }

  // Marp CLI: the deck as one HTML file (no browser needed for HTML output;
  // `--pdf` / `--pptx` would launch one). https://github.com/marp-team/marp-cli
  if (tryRun('marp', [`${slug}.marp.md`, '-o', `${slug}.slides.html`], outDir)) {
    console.log(`  built ${join(outDir, `${slug}.slides.html`)}`);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const positional: string[] = [];
  let outDir = 'dist/render';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir') outDir = argv[++i] ?? outDir;
    else if (argv[i] === '-h' || argv[i] === '--help') positional.unshift('help');
    else positional.push(argv[i]);
  }
  const [format, inputPath] = positional;

  if (!format || format === 'help') {
    console.log(USAGE);
    return format ? 0 : 1;
  }
  if (format === 'all') {
    renderAll(await readFlow(inputPath), resolve(outDir));
    return 0;
  }
  const render = RENDERERS[format];
  if (!render) {
    console.error(`render: unknown format "${format}"\n\n${USAGE}`);
    return 1;
  }
  process.stdout.write(render(await readFlow(inputPath)));
  return 0;
}

process.exitCode = await main(process.argv.slice(2));

// ── REPL examples ────────────────────────────────────────────────────────
// // 1. Everything, from the checked-in fixture
// // deno run --allow-read --allow-write --allow-run scripts/render/render.ts all scripts/render/fixtures/flow.json
//
// // 2. One format to stdout, on each runtime
// // deno run --allow-read scripts/render/render.ts html scripts/render/fixtures/flow.json | head -5
// // node scripts/render/render.ts mermaid scripts/render/fixtures/flow.json
// // bun  scripts/render/render.ts codetour scripts/render/fixtures/flow.json
//
// // 3. Straight from the waystation CLI
// // way show "my flow" --json | deno run --allow-read scripts/render/render.ts html > my-flow.html
// // way export "my flow" --frontmatter | deno run --allow-read scripts/render/render.ts mermaid

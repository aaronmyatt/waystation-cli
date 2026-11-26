// ──────────────────────────────────────────────────────────────────────────
// Browser-side probe for the Marp deck layout test (render_scripts.test.ts).
//
// The test builds a deck, appends this script to the page, and loads it in
// headless Chrome with `--dump-dom`. The script measures every slide and
// writes the numbers, as JSON, into a `pre` element with id "measure" that
// the test reads back. Numbers only: nothing here takes a screenshot.
//
// All positions are in slide px (a slide is 1280 × 720), measured from the
// slide's top-left corner, whatever size the browser drew the slide at.
//
// References:
//   • getBoundingClientRect: https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect
//   • getComputedStyle (2nd argument reads ::before / ::after):
//     https://developer.mozilla.org/en-US/docs/Web/API/Window/getComputedStyle
//   • Range.getBoundingClientRect (where one character was drawn):
//     https://developer.mozilla.org/en-US/docs/Web/API/Range/getBoundingClientRect
// ──────────────────────────────────────────────────────────────────────────

// Slide children the deck is expected to produce. Anything else means a
// piece of flow text was read as HTML and wrapped the slide's content.
const EXPECTED = /^(HEADER|FOOTER|STYLE|H1|H2|P|UL|OL|PRE|MARP-PRE|BLOCKQUOTE|HR|TABLE)$/;

function measureSlide(sec) {
  const S = sec.getBoundingClientRect();
  const k = S.width / 1280; // page px per slide px
  const r1 = (n) => Math.round(n * 10) / 10;
  const edge = (el, side) =>
    (el.getBoundingClientRect()[side] - (side === 'bottom' ? S.top : S.left)) / k;
  const style = getComputedStyle(sec);
  const badge = getComputedStyle(sec, '::after');
  const title = sec.querySelector('h1, h2');
  const content = [...sec.children].filter((c) => !/^(HEADER|FOOTER|STYLE)$/.test(c.tagName));

  // Marp swaps `pre` for its own `marp-pre` element once the page loads.
  const blocks = [...sec.querySelectorAll(':scope > pre, :scope > marp-pre')];
  // The step's panel is the last block, and the only one handed a gutter.
  const hasGutter = (el) => getComputedStyle(el).getPropertyValue('--gutter').trim() !== '';
  const panel = blocks.length && hasGutter(blocks.at(-1)) ? blocks.at(-1) : null;

  const row = {
    page: Number(sec.id),
    pag: sec.dataset.marpitPagination ?? null,
    total: sec.dataset.marpitPaginationTotal ?? null,
    background: style.backgroundColor,
    titleY: title ? r1((title.getBoundingClientRect().top - S.top) / k) : null,
    badge: badge.display === 'none' ? null : {
      content: badge.content,
      left: badge.left,
      top: badge.top,
      width: badge.width,
      height: badge.height,
    },
    pager: getComputedStyle(sec, '::before').content,
    // Lowest and rightmost edge of the slide's content.
    bottom: r1(Math.max(...content.map((c) => edge(c, 'bottom')))),
    right: r1(Math.max(...content.map((c) => edge(c, 'right')))),
    strays: [...sec.children].filter((c) => !EXPECTED.test(c.tagName)).map((c) => c.tagName),
    // Code blocks from the note: these must stay plain.
    plain: blocks.filter((el) => el !== panel).map((el) => {
      const code = el.querySelector('code');
      return {
        numbers: getComputedStyle(code, '::before').content,
        pad: getComputedStyle(code).paddingLeft,
      };
    }),
    panel: null,
  };
  if (!panel) return row;

  const code = panel.querySelector('code');
  const C = code.getBoundingClientRect();
  // 1 unless Marp shrank the code to fit a wide line.
  const shrink = C.width / k / code.offsetWidth;
  const lineHeight = parseFloat(getComputedStyle(code).lineHeight);

  // Where each non-blank line of text was really drawn: the vertical centre
  // of its first character, in units of one code line. Line i should read
  // i + 0.5, which is also the centre of highlight band i.
  const centres = {};
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let node;
  let line = 0;
  while ((node = walker.nextNode())) {
    for (let i = 0; i < node.data.length; i++) {
      if (node.data[i] === '\n') {
        line++;
        continue;
      }
      if (line in centres) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const box = range.getBoundingClientRect();
      const y = (box.top + box.height / 2 - C.top) / k / shrink;
      centres[line] = Math.round((y / lineHeight) * 100) / 100;
    }
  }

  const numbers = getComputedStyle(code, '::before');
  row.panel = {
    x: r1((C.left - S.left) / k),
    width: r1(C.width / k),
    shrink: Math.round(shrink * 1000) / 1000,
    hit: Number(getComputedStyle(panel).getPropertyValue('--hit')),
    lines: code.textContent.replace(/\n$/, '').split('\n').length,
    lineHeight,
    numbers: numbers.content,
    numbersLineHeight: numbers.lineHeight,
    centres,
    band: getComputedStyle(code).backgroundPosition,
    background: getComputedStyle(panel).backgroundColor,
  };
  return row;
}

// Wait a moment after load: Marp's own script sizes the code blocks first.
addEventListener('load', () =>
  setTimeout(() => {
    const out = document.createElement('pre');
    out.id = 'measure';
    out.textContent = JSON.stringify([...document.querySelectorAll('section')].map(measureSlide));
    document.body.append(out);
  }, 400));

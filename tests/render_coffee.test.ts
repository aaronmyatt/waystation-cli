// ──────────────────────────────────────────────────────────────────────────
// Parity checks for scripts/render/coffee/*.coffee.
//
// The CoffeeScript scripts are ports of the TypeScript renderers, which have
// their own structure tests (render_scripts.test.ts). So the question here is
// narrow: given the same flow, does each script print the same bytes as its
// TypeScript twin? If yes, everything those tests prove holds for both.
//
// The scripts are run as real programs, the way a person runs them. They read
// what `way export <flow> --json` prints: the view from src/flows/view.ts.
// It goes in on stdin (`-`), or through a stand-in `way` program for the
// tests that check the flow-id path.
//
// Needs `coffee` on PATH (brew install coffeescript); skipped without it.
//
// References:
//   • Deno.Command:  https://docs.deno.com/api/deno/~/Deno.Command
//   • Deno.test:     https://docs.deno.com/api/deno/~/Deno.test
// ──────────────────────────────────────────────────────────────────────────

import { assert, assertEquals } from '@std/assert';
import fixture from '../scripts/render/fixtures/flow.json' with { type: 'json' };
import type { FlowInput } from '../scripts/render/_shared.ts';
import { renderHtml } from '../scripts/render/html.ts';
import { renderMarp } from '../scripts/render/marp.ts';
import { toFlowView } from '../src/flows/view.ts';

const SCRIPTS = new URL('../scripts/render/coffee/', import.meta.url);

// ── Running the scripts ──────────────────────────────────────────────────

/** True when `name --version` runs (and we are allowed to run it). */
function has(name: string): boolean {
  try {
    return new Deno.Command(name, {
      args: ['--version'],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
    }).outputSync().success;
  } catch {
    return false;
  }
}

const NO_COFFEE = !has('coffee');

type Run = { code: number; out: string; err: string };

/** Run one script. `stdin` is the text piped in, or null for no stdin at all. */
async function coffee(
  script: string,
  args: string[],
  stdin: string | null = null,
  env: Record<string, string> = {},
): Promise<Run> {
  const child = new Deno.Command('coffee', {
    args: [new URL(script, SCRIPTS).pathname, ...args],
    stdin: stdin === null ? 'null' : 'piped',
    stdout: 'piped',
    stderr: 'piped',
    env,
  }).spawn();
  if (stdin !== null) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const res = await child.output();
  const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  return { code: res.code, out: text(res.stdout), err: text(res.stderr) };
}

/** What `way export <flow> --json` would print for this aggregate. */
const viewJson = (input: FlowInput): string => JSON.stringify(toFlowView(input), null, 2);

/** Run a script on a flow's view given on stdin; its stdout, after checking it succeeded. */
async function render(script: string, input: FlowInput, args: string[] = []): Promise<string> {
  const res = await coffee(script, ['-', ...args], viewJson(input));
  assertEquals([res.code, res.err], [0, ''], `${script} ${args.join(' ')}`);
  return res.out;
}

// ── Inputs ───────────────────────────────────────────────────────────────

/** A code match with the current `grep_meta` shape. */
function match(file: string, lang: string, lines: string[], start: number, hit: number) {
  return {
    file_path: `/w/${file}`,
    repo_relative_file_path: file,
    file_name: file.split('/').pop(),
    line_no: start + Math.max(0, hit),
    // A range capture stores the whole slice as its `line`.
    line: hit < 0 ? lines.join('\n') : lines[hit],
    grep_meta: JSON.stringify({
      context_lines: lines,
      context_start_line: start,
      matched_index_in_context: Math.max(0, hit),
      language: lang,
    }),
    git_repo_root: 'acme/demo',
    git_commit_sha: 'abc1234def5678',
    git_branch: 'main',
  };
}

const numbered = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `const v${i} = call(${i}); // line ${i}`);

/**
 * One flow that walks every branch of the port: each stored shape of
 * `grep_meta`, each highlighter family, every note construct, text that
 * tries to become markup, and the slide-fitting cases.
 */
const tricky: FlowInput = {
  flow: {
    name: '  Tricky <b> "flow" \\ </style> --> name  ',
    description: 'With `code`, **bold**, *em*, a [link](https://example.com) and <i>.',
    git_repo_root: '/not/a/slug',
    git_branch: 'feature/x',
    updated_at: '2026-01-02 03:04:05',
  },
  matches: [
    {
      step_content: { title: 'C family: comments, strings, calls, types', body: 'Short.' },
      match: match(
        'src/a.ts',
        'typescript',
        [
          '/** JSDoc opener',
          ' * body line',
          ' */',
          'export async function load(id: string): Promise<Flow> {',
          '  const s = \'it\\\'s\' + "q\\"q" + `t${id}`; /* open',
          '  still comment */ return new Map<string, Flow>().get(id) ?? 42_000.5;',
          '}',
        ],
        10,
        3,
      ),
    },
    {
      step_content: { title: 'Python', body: '' },
      // grep_meta already an object, with no start line or index: both are derived.
      match: {
        ...match('tools/x.py', 'python', [], 7, 0),
        grep_meta: {
          context_lines: ['def f(x):\r\n', '    return None  # done', "    s = 'a'"],
          language: 'python',
        },
        line: '    return None  # done',
        line_no: 8,
      },
    },
    {
      step_content: { title: 'SQL is case-blind', body: null },
      match: match(
        'db/q.sql',
        'sql',
        ['SELECT a, count(*) FROM t -- why', "WHERE b = 'x' LIMIT 10"],
        1,
        0,
      ),
    },
    { match: match('conf/app.yaml', 'yaml', ['key: true # note', 'n: 12'], 3, 1) },
    { match: match('bin/run', 'bash', ['if [ -f "$1" ]; then echo hi; fi # ok'], 1, 0) },
    { match: match('lib/x.rb', 'ruby', ['def go; nil unless Thing.new(1); end # ok'], 1, 0) },
    {
      step_content: { title: 'Legacy context shape', body: 'Old rows.' },
      match: {
        file_path: '/w/old.go',
        line_no: 20,
        line: 'x := 1',
        grep_meta: JSON.stringify({
          before: 'a\nb\n',
          match: 'x := 1',
          after: 'c',
          language: 'go',
        }),
        git_repo_root: 'acme/demo',
        git_branch: 'main',
      },
    },
    {
      step_content: { title: 'Broken grep_meta falls back to the line', body: '' },
      match: {
        repo_relative_file_path: 'src/b.ts',
        line_no: 5,
        line: 'one\ntwo',
        grep_meta: '{not json',
      },
    },
    {
      step_content: { title: 'No context at all', body: '' },
      match: { repo_relative_file_path: 'src/c.unknownlang', line_no: 0 },
    },
    {
      step_content: { title: 'Focal index out of range', body: '' },
      match: {
        ...match('src/d.ts', 'typescript', ['a', 'b'], 1, 0),
        grep_meta: JSON.stringify({
          context_lines: ['a', 'b'],
          context_start_line: 1,
          matched_index_in_context: 9,
          language: 'typescript',
        }),
      },
    },
    {
      step_content: {
        title: 'Every note construct <b> [x] `c<d>`',
        body: [
          'Para one **bold** *em* `code<x>` [ok](https://a.example/x?y=1&z=2) [bad](javascript:alert(1))',
          'continues here snake_case_name.',
          '',
          '- item one',
          '* item `two`',
          '',
          '1. first',
          '2) second',
          '',
          '---',
          '',
          '```sh',
          'echo "<b>" && echo ```',
          '```',
          '',
          'After <!-- _class: x --> and <style>p{}</style>.',
        ].join('\n'),
      },
    },
    {
      step_content: { title: 'Range capture, longer than a slide', body: 'A range.' },
      match: match('src/e.ts', 'typescript', numbered(40), 100, -1),
    },
    {
      step_content: { title: 'Trimmed around the focal line', body: 'Trim.' },
      match: match('src/e.ts', 'typescript', numbered(40), 200, 31),
    },
    {
      step_content: {
        title: 'A note too long to share a slide with its code',
        body: Array.from({ length: 16 }, (_, i) => `Line ${i} ${'word '.repeat(14)}`).join('\n\n'),
      },
      match: match('src/f.ts', 'typescript', numbered(12), 1, 4),
    },
    {
      step_content: { title: 'Code that contains a fence', body: '' },
      match: match('src/g.ts', 'typescript', ["md += '```' + lang;", "md += '````';"], 1, 0),
    },
    // Enough steps for a second route slide.
    ...Array.from(
      { length: 4 },
      (_, i) => ({ step_content: { title: `Filler ${i}`, body: 'Note.' } }),
    ),
  ],
};

const INPUTS: [string, FlowInput][] = [
  ['fixture', fixture as FlowInput],
  ['tricky', tricky],
  ['empty', {}],
];

// ── Parity ───────────────────────────────────────────────────────────────

Deno.test({
  name: 'coffee html: the same bytes as the TypeScript renderer',
  ignore: NO_COFFEE,
  fn: async () => {
    for (const [label, input] of INPUTS) {
      assertEquals(await render('html.coffee', input), renderHtml(input), label);
      assertEquals(
        await render('html.coffee', input, ['--paper', 'Letter', '--no-highlight']),
        renderHtml(input, { paper: 'Letter', highlight: false }),
        `${label}, Letter, no highlight`,
      );
    }
  },
});

Deno.test({
  name: 'coffee marp: the same bytes as the TypeScript renderer',
  ignore: NO_COFFEE,
  fn: async () => {
    for (const [label, input] of INPUTS) {
      assertEquals(await render('marp.coffee', input), renderMarp(input), label);
      assertEquals(
        await render('marp.coffee', input, ['--max-lines', '6', '--theme', 'gaia']),
        renderMarp(input, { maxLines: 6, theme: 'gaia' }),
        `${label}, 6 lines, gaia`,
      );
    }
    // The tricky flow really does reach the hard cases.
    const deck = renderMarp(tricky);
    assert(deck.includes('<!-- _paginate: hold -->') && deck.includes('## Route (2 of 2)'));
  },
});

// ── The flow-id path ─────────────────────────────────────────────────────

/** A stand-in `way`: logs its arguments, then prints `stdout` and exits with `code`. */
async function fakeWay(dir: string, stdoutFile: string, code: number): Promise<string> {
  const bin = `${dir}/way`;
  await Deno.writeTextFile(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n` +
      (code === 0 ? `cat "${stdoutFile}"\n` : `echo 'Error: No flow found matching "x"' >&2\n`) +
      `exit ${code}\n`,
  );
  await Deno.chmod(bin, 0o755);
  return bin;
}

Deno.test({
  name: 'coffee: a flow id is fetched with `way export <id> --json`, and --db is passed on',
  ignore: NO_COFFEE,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'way-coffee-' });
    try {
      await Deno.writeTextFile(`${dir}/flow.json`, viewJson(fixture as FlowInput));
      const env = { WAY_BIN: await fakeWay(dir, `${dir}/flow.json`, 0) };

      const res = await coffee('html.coffee', ['my flow', '--db', '/tmp/x.db'], null, env);
      assertEquals([res.code, res.err], [0, '']);
      assertEquals(res.out, renderHtml(fixture as FlowInput));
      assertEquals(
        await Deno.readTextFile(`${dir}/args`),
        'export\nmy flow\n--json\n--db\n/tmp/x.db\n',
      );

      // -o writes the file and keeps stdout empty.
      const saved = await coffee('marp.coffee', ['abc123', '-o', `${dir}/deck.md`], null, env);
      assertEquals([saved.code, saved.out], [0, '']);
      assertEquals(await Deno.readTextFile(`${dir}/deck.md`), renderMarp(fixture as FlowInput));
      assertEquals(await Deno.readTextFile(`${dir}/args`), 'export\nabc123\n--json\n');
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: 'coffee: failures are one clean line and a non-zero exit',
  ignore: NO_COFFEE,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'way-coffee-' });
    try {
      // `way` could not find the flow: its message is passed on.
      const env = { WAY_BIN: await fakeWay(dir, '', 1) };
      const missing = await coffee('typst.coffee', ['x'], null, env);
      assertEquals([missing.code, missing.out], [1, '']);
      assertEquals(missing.err, 'typst.coffee: Error: No flow found matching "x"\n');

      // No `way` at all.
      const noWay = await coffee('html.coffee', ['x'], null, { WAY_BIN: `${dir}/nope` });
      assertEquals(noWay.code, 1);
      assert(noWay.err.startsWith('html.coffee: cannot find'), noWay.err);

      // Bad calls print the usage; --help is not a failure.
      const none = await coffee('marp.coffee', []);
      assert(none.code === 1 && none.err.includes('USAGE') && none.out === '', none.err);
      const help = await coffee('marp.coffee', ['--help']);
      assert(help.code === 0 && help.out.includes('USAGE') && help.err === '', help.err);
      const bad = await coffee('html.coffee', ['-', '--paper', 'B5'], viewJson({}));
      assertEquals([bad.code, bad.out], [1, '']);
      assert(bad.err.includes('--paper must be A4 or Letter'), bad.err);

      // The stored rows (`way show --json`) are not the view: say what to run instead.
      const rows = await coffee('html.coffee', ['-'], JSON.stringify(fixture));
      assertEquals([rows.code, rows.out], [1, '']);
      assert(rows.err.includes('way export <flow> --json'), rows.err);
      const junk = await coffee('marp.coffee', ['-'], 'not json');
      assertEquals([junk.code, junk.err], [1, 'marp.coffee: the flow is not valid JSON\n']);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ── Built outputs ────────────────────────────────────────────────────────

Deno.test({
  name: 'coffee typst: writes a PDF and prints where it went',
  ignore: NO_COFFEE || !has('typst'),
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: 'way-coffee-' });
    try {
      const out = `${dir}/flow.pdf`;
      const res = await coffee('typst.coffee', ['-', '-o', out], viewJson(tricky));
      assertEquals([res.code, res.err], [0, '']);
      // On macOS the temp folder is a symlink, so compare the file, not the text.
      assertEquals(await Deno.realPath(res.out.trim()), await Deno.realPath(out));
      const bytes = await Deno.readFile(out);
      assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Markdown → terminal rendering.
//
// Two-tier strategy:
//   1. If `glow` or `bat` is on PATH, shell out to it. They produce visibly
//      better output than anything we can do in-process (true pagers, full
//      syntax highlighting, theming).
//      • glow:   https://github.com/charmbracelet/glow
//      • bat:    https://github.com/sharkdp/bat
//   2. Otherwise, fall back to in-process rendering with
//      `marked` + `marked-terminal`. This is dynamically imported so users
//      who never call the pretty-printer (e.g. only ever run `way add` and
//      `way list`) don't pay the cli-highlight/highlight.js startup cost.
//      • marked-terminal: https://github.com/mikaelbr/marked-terminal
//
// Why dynamic import: `marked-terminal` pulls in highlight.js (~MBs of
// language definitions) via cli-highlight. Keeping it behind a runtime
// import means `way list` and `way add` stay snappy for users whose flows
// have nothing to render.
// ──────────────────────────────────────────────────────────────────────────

/** Result of a fallback-chain render attempt — used by the test harness. */
export type RenderOutcome = 'glow' | 'bat' | 'marked-terminal' | 'raw';

export type RenderConfig = {
  /** Preferred order of external renderers. Defaults to `['glow', 'bat']`. */
  externalPreference?: ('glow' | 'bat')[];
  /** Wrap width passed to marked-terminal's reflow. Defaults to 100. */
  width?: number;
  /** Disable all external renderers and use the in-process fallback only.
   *  Useful for tests and CI logs. */
  forceInProcess?: boolean;
};

/**
 * Render `md` to the terminal. Tries external renderers (glow → bat) first,
 * then falls back to marked-terminal in-process. As a last-resort, prints
 * the markdown verbatim — which is what `console.log(md)` would have done
 * anyway, so the function is always at least as good as not calling it.
 *
 * Returns which renderer ended up being used; the caller usually ignores it.
 */
export async function prettyPrintMarkdown(
  md: string,
  config: RenderConfig = {},
): Promise<RenderOutcome> {
  if (!config.forceInProcess) {
    for (const bin of config.externalPreference ?? ['glow', 'bat']) {
      const ok = await tryExternal(bin, md);
      if (ok) return bin;
    }
  }

  try {
    const rendered = await renderInProcess(md, { width: config.width ?? 100 });
    Deno.stdout.writeSync(new TextEncoder().encode(rendered));
    if (!rendered.endsWith('\n')) Deno.stdout.writeSync(new TextEncoder().encode('\n'));
    return 'marked-terminal';
  } catch (err) {
    // Last-resort: dump raw markdown. This can happen if the npm dep
    // failed to install (offline first run, etc.) — better to show the
    // user something useful than to crash.
    console.error(
      `[render] in-process renderer failed (${err instanceof Error ? err.message : err}); ` +
        `falling back to raw output.`,
    );
    console.log(md);
    return 'raw';
  }
}

/**
 * Try to render `md` by piping it through an external binary. Returns
 * `true` only if the binary exited 0 *and* stdout was inherited so the
 * user saw the result; on any failure we silently return `false` so the
 * caller can fall through to the next option.
 */
async function tryExternal(bin: 'glow' | 'bat', md: string): Promise<boolean> {
  // External-renderer argv.
  //
  //   • glow: take the default. Trying to suppress glow's word-wrap by
  //     passing a huge `-w` value is a TRAP — glow's `-w` doesn't mean
  //     "wrap-at-most-at"; it means "render to this column width", and
  //     glow then pads every short line with trailing spaces up to that
  //     width. A `-w 10000` produces 10 000 cols of whitespace per line.
  //     The terminal then soft-wraps that whitespace across many rows
  //     and the viewer sees a near-empty screen. Source:
  //     https://github.com/charmbracelet/glow (see `glow --help`).
  //
  //   • bat: `--wrap=never` keeps code lines at their authored width;
  //     the emulator handles soft-wrap on narrow screens.
  //     https://github.com/sharkdp/bat#configuration-file
  //
  //   • To prevent file-URL breaks across lines we instead strip the
  //     inline-link markup at the markdown layer before piping (see
  //     `noInlineLinks` in src/flows/markdown.ts).
  const args = bin === 'bat'
    ? ['-l', 'md', '--style=plain', '--paging=never', '--wrap=never']
    : ['-'];

  try {
    const child = new Deno.Command(bin, {
      args,
      stdin: 'piped',
      stdout: 'inherit',
      stderr: 'inherit',
    }).spawn();

    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(md));
    } finally {
      await writer.close();
    }
    const status = await child.status;
    return status.success;
  } catch {
    // ENOENT (binary not on PATH) lands here, as does any permission error.
    // Either way we want to fall through to the next option silently.
    return false;
  }
}

/**
 * Convert markdown to an ANSI-styled string using marked + marked-terminal.
 * The dynamic imports happen here so this module's *static* graph stays
 * small.
 */
async function renderInProcess(md: string, opts: { width: number }): Promise<string> {
  // Dynamic imports keep `marked-terminal` (and its transitive highlight.js
  // payload) out of the load path of `init`/`list`/`add`.
  // https://docs.deno.com/runtime/fundamentals/modules/#dynamic-imports
  const { marked } = await import('marked');
  // marked-terminal's published types are slightly behind the v7 runtime
  // (DefinitelyTyped at v6 last we checked). We import as any to avoid
  // pinning to a stale typedef.
  // deno-lint-ignore no-explicit-any
  const mt: any = await import('marked-terminal');
  const factory = mt.markedTerminal ?? mt.default ?? mt;

  // Match the external-renderer policy: never hard-wrap. The terminal is
  // responsible for the visual line break, which keeps file URLs and code
  // intact. `width` is irrelevant when `reflowText: false`, but we still
  // forward it so a future caller can opt back in if they want a fixed-
  // width column for display.
  marked.use(factory({ width: opts.width, reflowText: false }));
  const result = marked.parse(md);
  // marked.parse can return string or Promise<string> depending on options;
  // await covers both cases without runtime overhead.
  return await Promise.resolve(result as string);
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { prettyPrintMarkdown } from './flows/renderTerminal.ts';
//
// // 1. Auto chain: prefers glow → bat → marked-terminal
// await prettyPrintMarkdown('# Hello\n\n`bat` *italic* **bold**');
//
// // 2. Force the in-process renderer (skip glow/bat)
// await prettyPrintMarkdown('# Hi', { forceInProcess: true });
//
// // 3. Customize the external preference order (e.g. prefer bat over glow)
// await prettyPrintMarkdown('# Hi', { externalPreference: ['bat', 'glow'] });

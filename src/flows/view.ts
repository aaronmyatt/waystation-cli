// ──────────────────────────────────────────────────────────────────────────
// Flow view: a flow flattened into the shape renderers want.
//
// A `FlowAggregate` is the stored rows, joined: `grep_meta` is a JSON string
// inside the JSON, a range capture looks almost like a single-line one, and
// notes are markdown text. Every renderer needs the same answers out of that
// — which lines of code, which one is the focal line, what is the permalink,
// what are the note's paragraphs — so they are worked out once, here.
//
//   aggregate  ──toFlowView()──▶  { name, files, steps: [{ title, ref, url,
//                                   lines, startLine, hitIndex, blocks, … }] }
//
// `way export <flow> --json` prints exactly this (pipelines/exportJson.ts),
// so a script in any language can render a flow without knowing how it is
// stored.
//
// Pure functions over plain data, no imports: this file also runs unchanged
// under Node and Bun, which is how scripts/render/ uses it.
//
// References:
//   • GitHub permalink format:
//     https://docs.github.com/en/repositories/working-with-files/using-files/getting-permanent-links-to-files
//   • The markdown constructs approximated below: https://spec.commonmark.org/0.31.2/#inlines
// ──────────────────────────────────────────────────────────────────────────

// ── Input types (loose mirror of FlowAggregate) ──────────────────────────
//
// Every field is optional and may be null, so a `FlowAggregate`, a row
// written by an older version, and a hand-built test fixture all fit.

/** A code location as stored in the `matches` table. All fields optional. */
export type MatchViewInput = {
  line?: string | null;
  file_path?: string | null;
  repo_relative_file_path?: string | null;
  file_name?: string | null;
  line_no?: number | null;
  /** JSON string (current) or already-parsed object (tolerated). */
  grep_meta?: unknown;
  git_repo_root?: string | null;
  git_commit_sha?: string | null;
  git_branch?: string | null;
};

/** One step of a flow: a code match, a note, or both. */
export type StepViewInput = {
  content_kind?: string;
  match?: MatchViewInput | null;
  step_content?: { title?: string | null; body?: string | null } | null;
};

/** Anything shaped like a waystation `FlowAggregate`. */
export type FlowViewInput = {
  flow?: {
    id?: string;
    name?: string | null;
    description?: string | null;
    git_repo_root?: string | null;
    git_commit_sha?: string | null;
    git_branch?: string | null;
    updated_at?: string | null;
  };
  matches?: StepViewInput[];
};

// ── View types (what renderers read) ─────────────────────────────────────

/** Inline run inside a note body. `v` is always plain, unescaped text. */
export type NoteSpan =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'link'; v: string; href: string };

/** Block of a note body. A tiny markdown subset, enough for step notes. */
export type NoteBlock =
  | { t: 'p'; spans: NoteSpan[] }
  | { t: 'ul'; items: NoteSpan[][] }
  | { t: 'ol'; items: NoteSpan[][] }
  | { t: 'code'; lang: string; v: string };

/** One step, flattened. Every key is always present (null when unknown) so
 *  templating languages without optional chaining (Typst) can read it. */
export type StepView = {
  /** 1-based position in the flow. */
  n: number;
  /** Raw note body (markdown). Empty string when absent. */
  body: string;
  /** `body` parsed into blocks — for targets that can't render markdown. */
  blocks: NoteBlock[];
  title: string;
  /** Repo-relative path when known, else the stored path. */
  file: string | null;
  /** First line of interest: the hit line, or the start of a range. */
  line: number | null;
  /** Last line of a range capture; null for single-line captures. */
  endLine: number | null;
  /** `src/x.ts:12` or `src/x.ts:12-20`. Null for note-only steps. */
  ref: string | null;
  /** GitHub permalink, when the repo looks like `owner/name`. */
  url: string | null;
  lang: string;
  /** Code context lines, without trailing newlines. */
  lines: string[];
  /** Line number of `lines[0]`. */
  startLine: number;
  /** Index into `lines` of the focal line; -1 for ranges and notes. */
  hitIndex: number;
};

/** A flow, flattened for rendering. */
export type FlowView = {
  name: string;
  description: string;
  /** `description` as inline spans, for targets that can't render markdown. */
  descriptionSpans: NoteSpan[];
  repo: string | null;
  branch: string | null;
  commit: string | null;
  updatedAt: string | null;
  /** Distinct files touched, in first-visit order. */
  files: string[];
  steps: StepView[];
};

// ── Markdown-lite parser (note bodies) ───────────────────────────────────

// One alternation, tried left to right at each position:
//   `code` | **strong** | *em* | [text](href)
// Underscore emphasis is deliberately unsupported: snake_case identifiers in
// notes (`order_index`) would otherwise turn italic.
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Only these link targets survive; anything else (e.g. `javascript:`)
 *  degrades to plain text. Relative and fragment links are allowed. */
function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** Split one line of note text into inline spans. */
export function parseInline(text: string): NoteSpan[] {
  const spans: NoteSpan[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) spans.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ t: 'code', v: m[1] });
    else if (m[2] !== undefined) spans.push({ t: 'strong', v: m[2] });
    else if (m[3] !== undefined) spans.push({ t: 'em', v: m[3] });
    else if (isSafeHref(m[5])) spans.push({ t: 'link', v: m[4], href: m[5] });
    else spans.push({ t: 'text', v: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ t: 'text', v: text.slice(last) });
  return spans;
}

/** Parse a note body into blocks: paragraphs, lists, fenced code. */
export function parseBlocks(body: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  const lines = body.split(/\r?\n/);
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) blocks.push({ t: 'p', spans: parseInline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,})\s*(\S*)/);
    if (fence) {
      flush();
      const code: string[] = [];
      // Consume until a closing fence at least as long as the opener.
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      blocks.push({ t: 'code', lang: fence[2] || 'text', v: code.join('\n') });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const item = bullet ?? ordered;
    if (item) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      const prev = blocks[blocks.length - 1];
      if (prev && prev.t === kind) prev.items.push(parseInline(item[1]));
      else blocks.push({ t: kind, items: [parseInline(item[1])] });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}

// ── Code context ─────────────────────────────────────────────────────────

type Context = { lines: string[]; startLine: number; hitIndex: number; lang: string };

/** Pull code context out of a match, tolerating every stored shape. */
function readContext(match: MatchViewInput): Context | undefined {
  const lineNo = Number(match.line_no) || 1;
  let meta: Record<string, unknown> | undefined;
  if (typeof match.grep_meta === 'string') {
    try {
      meta = JSON.parse(match.grep_meta);
    } catch {
      meta = undefined;
    }
  } else if (match.grep_meta && typeof match.grep_meta === 'object') {
    meta = match.grep_meta as Record<string, unknown>;
  }
  const lang = typeof meta?.language === 'string' ? meta.language : 'text';

  // Current shape, written by buildMatchFromCapture in src/commands/add.ts.
  if (Array.isArray(meta?.context_lines)) {
    const lines = (meta.context_lines as unknown[]).map((l) =>
      String(l ?? '').replace(/\r?\n$/, '')
    );
    const startLine = Number(meta.context_start_line) ||
      Math.max(1, lineNo - Math.floor(lines.length / 2));
    const idx = meta.matched_index_in_context;
    return { lines, startLine, hitIndex: typeof idx === 'number' ? idx : lineNo - startLine, lang };
  }
  // Legacy shape: { before, match, after } strings.
  if (meta && (meta.before || meta.match || meta.after)) {
    const split = (
      v: unknown,
    ): string[] => (v ? String(v).replace(/\r?\n$/, '').split(/\r?\n/) : []);
    const before = split(meta.before);
    const lines = [...before, ...split(meta.match), ...split(meta.after)];
    return { lines, startLine: Math.max(1, lineNo - before.length), hitIndex: before.length, lang };
  }
  // No context at all: fall back to the captured line itself.
  if (match.line) return { lines: match.line.split(/\r?\n/), startLine: lineNo, hitIndex: 0, lang };
  return undefined;
}

/** True when `repo` is an `owner/name` slug rather than a filesystem path. */
function isGitHubSlug(repo: string | null | undefined): repo is string {
  return !!repo && /^[\w.-]+\/[\w.-]+$/.test(repo);
}

// ── Steps and flow ───────────────────────────────────────────────────────

function toStepView(input: StepViewInput, n: number): StepView {
  const match = input.match ?? undefined;
  const title = input.step_content?.title?.trim();
  const body = input.step_content?.body?.trim() ?? '';
  const base = { n, body, blocks: parseBlocks(body) };

  if (!match || !(match.repo_relative_file_path || match.file_path)) {
    return {
      ...base,
      title: title || `Step ${n}`,
      file: null,
      line: null,
      endLine: null,
      ref: null,
      url: null,
      lang: 'text',
      lines: [],
      startLine: 1,
      hitIndex: -1,
    };
  }

  const file = (match.repo_relative_file_path || match.file_path) as string;
  const line = Number(match.line_no) || 1;
  const ctx = readContext(match) ?? { lines: [], startLine: line, hitIndex: -1, lang: 'text' };

  // Range captures store the whole joined slice in `match.line` (see
  // buildMatchFromCapture). That is the only reliable signal telling a range
  // apart from a single-line capture that happens to start its window.
  const isRange = ctx.lines.length > 1 && match.line === ctx.lines.join('\n');
  const endLine = isRange ? ctx.startLine + ctx.lines.length - 1 : null;
  const inBounds = ctx.hitIndex >= 0 && ctx.hitIndex < ctx.lines.length;
  const ref = `${file}:${line}${endLine ? `-${endLine}` : ''}`;

  // Prefer the commit SHA: a branch link drifts as the branch moves, a SHA
  // link is a true permalink.
  const rev = match.git_commit_sha || match.git_branch;
  const url = isGitHubSlug(match.git_repo_root) && rev && match.repo_relative_file_path
    ? `https://github.com/${match.git_repo_root}/blob/${rev}/${encodeURI(file)}#L${line}${
      endLine ? `-L${endLine}` : ''
    }`
    : null;

  return {
    ...base,
    title: title || `${match.file_name || file}:${line}`,
    file,
    line,
    endLine,
    ref,
    url,
    lang: ctx.lang,
    lines: ctx.lines,
    startLine: ctx.startLine,
    hitIndex: isRange || !inBounds ? -1 : ctx.hitIndex,
  };
}

/** Flatten an aggregate into the shape every renderer consumes. */
export function toFlowView(input: FlowViewInput): FlowView {
  const flow = input.flow ?? {};
  const steps = (input.matches ?? []).map((m, i) => toStepView(m, i + 1));
  const files: string[] = [];
  for (const s of steps) if (s.file && !files.includes(s.file)) files.push(s.file);
  const description = flow.description?.trim() ?? '';
  return {
    name: flow.name?.trim() || 'Untitled flow',
    description,
    descriptionSpans: parseInline(description),
    repo: flow.git_repo_root ?? null,
    branch: flow.git_branch ?? null,
    commit: flow.git_commit_sha ?? null,
    updatedAt: flow.updated_at ?? null,
    files,
    steps,
  };
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { parseBlocks, toFlowView } from './src/flows/view.ts';
//
// // 1. Note-only flow
// toFlowView({ flow: { name: 'Demo' }, matches: [{ step_content: { title: 'Hi', body: 'A `b`' } }] });
//
// // 2. Single-line capture: hitIndex points at the focal line
// toFlowView({ matches: [{ match: {
//   file_path: '/w/a.ts', repo_relative_file_path: 'a.ts', line_no: 2, line: 'b',
//   grep_meta: JSON.stringify({ context_lines: ['a', 'b', 'c'], context_start_line: 1,
//     matched_index_in_context: 1, language: 'typescript' }),
// } }] }).steps[0].hitIndex; // → 1
//
// // 3. Range capture: no single focal line, but an end line and a range ref
// const range = toFlowView({ matches: [{ match: {
//   repo_relative_file_path: 'a.ts', line_no: 1, line: 'a\nb',
//   grep_meta: JSON.stringify({ context_lines: ['a', 'b'], context_start_line: 1 }),
// } }] }).steps[0];
// [range.hitIndex, range.endLine, range.ref]; // → [-1, 2, 'a.ts:1-2']
//
// // 4. Markdown-lite blocks
// parseBlocks('Intro **bold**\n\n- one\n- two'); // → [{t:'p',…}, {t:'ul',…}]

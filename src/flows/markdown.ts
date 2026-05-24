// ──────────────────────────────────────────────────────────────────────────
// Render a FlowAggregate as Markdown (with optional YAML-ish frontmatter).
//
// Ported from waystation-vscode/src/utils/flowMarkdown.ts. The original
// accessed step/match fields by ad-hoc property names (e.g.
// `m.step_content_title || m.note_name`) baked into the SQL projection. This
// port reads through JSON pointer constants defined in ../pointers.ts so the
// renderer doesn't care how the aggregate was assembled — only the shape of
// the FlowAggregate matters.
//
// References:
//   • CommonMark spec (rendered output target): https://commonmark.org/
//   • GitHub permalink format used for "View on GitHub" links:
//     https://docs.github.com/en/repositories/working-with-files/using-files/getting-permanent-links-to-files
// ──────────────────────────────────────────────────────────────────────────

import { relative as posixRelative } from '@std/path/posix';
import * as jp from '../vendor/jsonpointer.ts';
import { P } from '../pointers.ts';
import type { FlowAggregate, FlowMatchState } from '../types.ts';

/** Build a `github.com/.../blob/.../path#Lnn` permalink for a match. */
function generateGithubLink(m: FlowMatchState): string | undefined {
  const match = m.match;
  if (!match || !match.git_repo_root || !match.git_branch || !match.file_path) {
    return undefined;
  }
  const relPath = match.repo_relative_file_path || match.file_path;
  return `https://github.com/${match.git_repo_root}/blob/${match.git_branch}/${relPath}#L${match.line_no}`;
}

/**
 * Determine the heading text for a step. Title precedence:
 *   step_content.title  →  step_content.body's first line (truncated)  →
 *   `Step N`.
 */
function headingFor(m: FlowMatchState, n: number): string {
  const title = m.step_content?.title;
  if (title) return String(title);
  return `Step ${n}`;
}

/** Try to parse a `grep_meta` JSON blob; tolerate non-JSON input. */
function parseGrepMeta(raw: unknown): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  if (typeof raw !== 'string') return raw as Record<string, unknown>;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw } as Record<string, unknown>;
  }
}

export type RenderOptions = {
  /** When true, emit GitHub permalinks and absolute paths suitable for
   *  publishing. When false, emit workspace-relative file links. */
  export?: boolean;
  /** When provided, rewrite absolute file paths into relative form. */
  workspaceRoot?: string;
  /** Override label for the H1 if the flow has no name. */
  flowLabel?: string;
  /**
   * Suppress the inline `[heading](file://...#Lnn)` markdown link in step
   * headings; emit just `## heading` instead. Useful for terminal renderers
   * (glow / marked-terminal) where a long URL would break across lines and
   * the path is already shown plainly in the `grep_meta` line below.
   */
  noInlineLinks?: boolean;
};

/**
 * Render the flow aggregate body as Markdown. Does *not* include
 * frontmatter — call {@linkcode addFrontmatter} separately if you want it.
 */
export function generateFlowMarkdown(
  aggregate: FlowAggregate,
  opts: RenderOptions = {},
): string {
  // Read top-level fields via pointers so a future schema rename only
  // touches src/pointers.ts.
  const flowName = jp.get(aggregate, P.flowName) ?? opts.flowLabel ?? 'Untitled flow';
  const flowDescription = jp.get(aggregate, P.flowDescription);
  const matches: FlowMatchState[] = (jp.get(aggregate, P.matches) as FlowMatchState[]) ?? [];

  let md = `# ${flowName}\n`;
  if (flowDescription) md += `\n> ${flowDescription}\n`;

  if (!matches.length) {
    md += '\n_No matches found for this flow._';
    return md;
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const heading = headingFor(m, i + 1);
    const filePath = m.match?.file_path;
    const lineNo = m.match?.line_no;

    // ── heading + permalink/relative link ──────────────────────────────
    if (opts.noInlineLinks) {
      // Terminal-friendly: plain heading, no embedded URL. The file
      // location still appears on the `grep_meta` line below.
      md += `\n## ${heading}`;
    } else if (opts.export) {
      const link = generateGithubLink(m);
      if (link) md += `\n## [${heading}](${link})`;
      else md += `\n## ${heading}`;
    } else if (filePath) {
      // Build a relative URL the IDE can resolve back to a real file.
      let rel = filePath;
      if (opts.workspaceRoot && filePath.startsWith(opts.workspaceRoot)) {
        rel = posixRelative(opts.workspaceRoot, filePath);
      }
      const relPosix = rel.split(/[\\\/]/).join('/');
      const linePart = lineNo && Number.isFinite(Number(lineNo)) ? `#L${lineNo}` : '';
      const fileUrl = encodeURI(`${relPosix}${linePart}`);
      md += `\n## [${heading}](/${fileUrl})`;
    } else {
      // Note-only step: no file backing.
      md += `\n## ${heading}`;
    }

    // ── body (note text) ───────────────────────────────────────────────
    const body = m.step_content?.body;
    if (body) md += `\n\n${body}`;

    // ── code context block via grep_meta ───────────────────────────────
    const grepMeta = parseGrepMeta(m.match?.grep_meta);
    if (grepMeta) {
      md += '\n\n';
      const ctxLines = (grepMeta as { context_lines?: string[] }).context_lines;
      if (Array.isArray(ctxLines)) {
        const startLine = (grepMeta as { context_start_line?: number }).context_start_line ??
          (lineNo ? Math.max(1, lineNo - Math.floor(ctxLines.length / 2)) : 1);

        if (opts.export) {
          const link = generateGithubLink(m);
          if (link) md += `\n\n[View on GitHub](${link})`;
        } else {
          const fileForHeader = m.match?.repo_relative_file_path || filePath;
          const lineForHeader = (grepMeta as { line?: number }).line || lineNo;
          if (fileForHeader) md += `${fileForHeader} +${lineForHeader || 1}`;
        }

        const lang = (grepMeta as { language?: string }).language || 'text';
        md += '\n```' + lang + '\n';
        ctxLines.forEach((ln: string, idx: number) => {
          const ln_no = startLine + idx;
          const safeLine = String(ln || '').replace(/\r?\n$/, '');
          md += `   ${ln_no}: ${safeLine}\n`;
        });
        md += '```\n';
      } else {
        // Legacy grep_meta shape: { file, line, before, match, after, raw, language }.
        const g = grepMeta as Record<string, unknown>;
        if (g.file) md += `> File: ${g.file}\n`;
        if (g.line) md += `> Line: ${g.line}\n`;
        if (g.raw && !g.match && !g.before && !g.after) {
          md += '\n```text\n' + String(g.raw).trim() + '\n```\n';
        } else {
          const lang = (g.language as string) || 'text';
          md += '\n```' + lang + '\n';
          if (g.before) md += String(g.before).trim() + '\n';
          if (g.match) md += String(g.match).trim() + '\n';
          if (g.after) md += String(g.after).trim() + '\n';
          md += '```\n';
        }
      }
    }

    md += '\n';
  }

  return md;
}

/**
 * Wrap the aggregate's flow scalars and the full JSON aggregate inside a
 * YAML-ish frontmatter block. Returns the frontmatter only — caller
 * concatenates it with the rendered body.
 *
 * The serialised JSON is the canonical machine-readable form of the flow.
 * External tools (e.g. the future agentic-session runner, the frontend) can
 * parse this back out using `@waystation/core`'s pointer constants without
 * having to re-implement the field paths.
 */
export function addFrontmatter(aggregate: FlowAggregate): string {
  const flow = aggregate.flow;
  return `---
id: ${JSON.stringify(flow.id ?? '')}
name: ${JSON.stringify(flow.name ?? '')}
local_only: ${flow.local_only ?? false}
created_at: ${JSON.stringify(flow.created_at ?? '')}
updated_at: ${JSON.stringify(flow.updated_at ?? '')}
flow: ${JSON.stringify(aggregate)}
---`;
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { generateFlowMarkdown, addFrontmatter } from './flows/markdown.ts';
//
// const agg = {
//   flow: { id: 'f1', name: 'Demo', description: 'Walkthrough' },
//   matches: [
//     { flows_id: 'f1', content_kind: 'note', content_id: 'sc1', order_index: 0,
//       step_content: { kind: 'note', title: 'Intro', body: 'Hello' } },
//   ],
// };
//
// // 1. Plain body
// generateFlowMarkdown(agg);
//
// // 2. Export-style with GitHub permalinks
// generateFlowMarkdown(agg, { export: true });
//
// // 3. With frontmatter
// addFrontmatter(agg) + '\n' + generateFlowMarkdown(agg);

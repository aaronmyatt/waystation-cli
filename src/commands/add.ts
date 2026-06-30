// ──────────────────────────────────────────────────────────────────────────
// `way add <path>:<line>[:<endLine>] [--flow <flowId>] [--local-only]`
//
// Reads the target file and captures lines into a Match:
//   • Single-line form  `path:N`     — captures lines max(1, N-3)..min(EOF, N+3)
//                                     so the saved step shows a `grep -C 3`
//                                     style window of context.
//   • Range form        `path:S:E`   — captures lines S..E verbatim.
//
// In both cases we populate `match.grep_meta` with the JSON shape the
// markdown renderer (`src/flows/markdown.ts`) consumes:
//   { context_lines: string[], context_start_line: number,
//     matched_index_in_context: number, language: string }
//
// Without `grep_meta`, the renderer has nothing to emit beneath the step
// heading — the saved data is invisible to `way show` / `way export`.
// ──────────────────────────────────────────────────────────────────────────

import { basename, extname, resolve } from '@std/path';
import { initializeCli } from '../db/sqlite.ts';
import { saveMatch } from '../pipelines/saveMatch.ts';
import { defaultDbPath } from './_common.ts';
import type { Match } from '../types.ts';

/** How many lines of context to include before & after the target line
 *  when the user omits an end-line. Matches `grep -C 3` muscle memory. */
const CONTEXT_LINES_BEFORE = 3;
const CONTEXT_LINES_AFTER = 3;

/**
 * Map a file extension to a language hint for the fenced code block. The
 * value is a free-form string — it's only used as the info string after
 * the triple-backtick, so any markdown renderer that recognises it
 * (highlight.js / cli-highlight / glow) will syntax-highlight accordingly.
 *
 * Kept small and explicit: every entry is a language we actively expect
 * to capture from. Add more as the need arises rather than pre-emptively
 * covering every extension.
 */
function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.sql': 'sql',
    '.md': 'markdown',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.hpp': 'cpp',
    '.java': 'java',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.php': 'php',
    '.rs/': 'rust',
  };
  return map[ext] ?? 'text';
}

/**
 * Parse a `path:line[:endLine]` spec. Split on the last two colons so a
 * Windows-style drive prefix (`C:\foo:42`) doesn't confuse the parser.
 *
 * Exported for unit tests so we can verify the parsing in isolation.
 */
export function parseAddSpec(spec: string): {
  filePath: string;
  lineNo: number;
  endLine?: number;
} {
  if (!spec) throw new Error('add: expected <path>:<line>[:<endLine>] argument');
  const parts = spec.split(':');
  if (parts.length < 2) {
    throw new Error(`add: malformed spec "${spec}" (expected <path>:<line>)`);
  }
  const endLineStr = parts.length >= 3 ? parts[parts.length - 1] : undefined;
  const lineStr = parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1];
  const filePath = resolve(
    parts.slice(0, parts.length >= 3 ? parts.length - 2 : parts.length - 1).join(':'),
  );
  const lineNo = Number(lineStr);
  const endLine = endLineStr ? Number(endLineStr) : undefined;
  if (!Number.isFinite(lineNo) || lineNo < 1) {
    throw new Error(`add: invalid line number "${lineStr}"`);
  }
  if (endLine !== undefined && (!Number.isFinite(endLine) || endLine < lineNo)) {
    throw new Error(
      `add: invalid end line "${endLineStr}" (must be ≥ start line ${lineNo})`,
    );
  }
  return { filePath, lineNo, endLine };
}

/**
 * Build the `Match` payload for a captured line/range. Exported so tests
 * can assert the captured shape without exercising the DB pipeline.
 *
 * @param filePath  Absolute path to the source file.
 * @param fileText  The file's contents (caller reads once).
 * @param lineNo    1-based line number (target of the capture).
 * @param endLine   Optional 1-based inclusive end line for range form.
 */
export function buildMatchFromCapture(
  filePath: string,
  fileText: string,
  lineNo: number,
  endLine?: number,
): Match {
  const allLines = fileText.split(/\r?\n/);
  const targetIdx = lineNo - 1;
  const startIdx = endLine
    // Range form: start exactly at the requested line.
    ? targetIdx
    // Single-line form: open a `grep -C N` window around the target.
    : Math.max(0, targetIdx - CONTEXT_LINES_BEFORE);
  const stopIdx = endLine
    ? endLine - 1
    : Math.min(allLines.length - 1, targetIdx + CONTEXT_LINES_AFTER);

  if (targetIdx < 0 || targetIdx >= allLines.length) {
    throw new Error(
      `add: line ${lineNo} out of range (file has ${allLines.length} lines)`,
    );
  }
  if (endLine !== undefined && endLine > allLines.length) {
    throw new Error(
      `add: end line ${endLine} out of range (file has ${allLines.length} lines)`,
    );
  }

  const contextLines = allLines.slice(startIdx, stopIdx + 1);
  const contextStartLine = startIdx + 1; // back to 1-based for display

  return {
    // schema.sql declares `matches.line` NOT NULL. For the single-line
    // form we keep the target line verbatim — it's also the value hashed
    // into the content-based match id (line | file_path | sha), so a
    // recapture of the same line de-duplicates naturally. For the range
    // form we use the joined slice — a range capture is logically a
    // different artefact from a single-line capture of the same target.
    line: endLine ? contextLines.join('\n') : allLines[targetIdx],
    file_path: filePath,
    file_name: basename(filePath),
    line_no: lineNo,
    grep_meta: JSON.stringify({
      context_lines: contextLines,
      context_start_line: contextStartLine,
      // 0-based offset into context_lines where the user-specified target
      // sits. The renderer can use this to highlight or otherwise mark
      // the focal line. For range captures the "target" is the start.
      matched_index_in_context: lineNo - contextStartLine,
      language: detectLanguage(filePath),
    }),
  };
}

export async function addCommand(
  spec: string,
  opts: { dbPath?: string; flow?: string; localOnly?: boolean; title?: string; desc?: string },
): Promise<void> {
  const { filePath, lineNo, endLine } = parseAddSpec(spec);
  const fileText = await Deno.readTextFile(filePath);
  const match = buildMatchFromCapture(filePath, fileText, lineNo, endLine);

  await initializeCli(opts.dbPath ?? defaultDbPath());

  const result = await saveMatch.process({
    match,
    flowId: opts.flow,
    defaultLocalOnly: opts.localOnly,
    stepTitle: opts.title,
    stepDesc: opts.desc,
  });

  // Build a human-readable summary that mentions the title/desc if provided.
  let summary =
    `Saved match ${result.resultMatchId} → flow ${result.flowId} (step ${result.flowMatchId})`;
  if (opts.title) summary += ` title="${opts.title}"`;
  if (opts.desc) summary += ` desc="${opts.desc.slice(0, 60)}${opts.desc.length > 60 ? '…' : ''}"`;

  console.log(summary);
}

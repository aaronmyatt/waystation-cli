// ──────────────────────────────────────────────────────────────────────────
// JSON pointer constants for the in-memory `FlowAggregate` shape.
//
// These pointers are the single source of truth for navigating the aggregate
// JSON. Pipeline stages, the markdown renderer, and any external consumer of
// the frontmatter blob should read/write through these constants rather than
// via direct property access. Why:
//
//   • Schema renames become a one-file edit.
//   • External tools (the agent runner, the frontend, dump scripts) can use
//     the same constants by importing `@waystation/core/pointers` — no need
//     to reimplement field paths.
//   • Pairs naturally with the vendored jsonpointer library; see jp.get/set.
//
// Pointer syntax follows RFC 6901: https://datatracker.ietf.org/doc/html/rfc6901
//   • "/foo/bar"   — nested property
//   • "/arr/0"     — array index
//   • "/arr/-"     — append (only meaningful for `set`)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pointer factory bundle. Plain string fields are literal pointers; functions
 * are pointer *builders* (parameterised over an array index).
 *
 * `as const` preserves the literal types so callers get autocomplete on the
 * pointer string itself when compile-time path checking is helpful.
 */
export const P = {
  // ── flow scalars ───────────────────────────────────────────────────────
  /** `agg.flow.id` */
  flowId: '/flow/id',
  /** `agg.flow.name` */
  flowName: '/flow/name',
  /** `agg.flow.description` */
  flowDescription: '/flow/description',
  /** `agg.flow.local_only` */
  flowLocalOnly: '/flow/local_only',
  /** `agg.flow.created_at` */
  flowCreatedAt: '/flow/created_at',
  /** `agg.flow.updated_at` */
  flowUpdatedAt: '/flow/updated_at',
  /** `agg.flow.git_repo_root` */
  flowGitRepoRoot: '/flow/git_repo_root',
  /** `agg.flow.git_commit_sha` */
  flowGitCommitSha: '/flow/git_commit_sha',
  /** `agg.flow.git_branch` */
  flowGitBranch: '/flow/git_branch',

  // ── matches array ──────────────────────────────────────────────────────
  /** The full matches array. */
  matches: '/matches',
  /** Append a new match — only usable with `jp.set`. */
  appendMatch: '/matches/-',

  // ── per-index match accessors ──────────────────────────────────────────
  /** The whole `FlowMatchState` at index `i`. */
  matchAt: (i: number): string => `/matches/${i}`,
  /** `content_kind` discriminator at index `i`. */
  matchKind: (i: number): string => `/matches/${i}/content_kind`,
  /** Order index field at index `i` (used when re-sequencing). */
  matchOrder: (i: number): string => `/matches/${i}/order_index`,

  // ── nested .match payload (when content_kind === 'match') ──────────────
  /** The joined `match` payload at index `i`. */
  matchPayload: (i: number): string => `/matches/${i}/match`,
  /** The captured source line at index `i`. */
  matchLine: (i: number): string => `/matches/${i}/match/line`,
  /** File path of the code reference at index `i`. */
  matchFilePath: (i: number): string => `/matches/${i}/match/file_path`,
  /** 1-based line number of the code reference at index `i`. */
  matchLineNo: (i: number): string => `/matches/${i}/match/line_no`,
  /** Grep metadata JSON string at index `i`. */
  matchGrepMeta: (i: number): string => `/matches/${i}/match/grep_meta`,
  /** Git repo root recorded for the match at index `i`. */
  matchRepoRoot: (i: number): string => `/matches/${i}/match/git_repo_root`,
  /** Git branch recorded for the match at index `i`. */
  matchBranch: (i: number): string => `/matches/${i}/match/git_branch`,

  // ── nested .step_content payload (when content_kind !== 'match') ───────
  /** The joined `step_content` payload at index `i`. */
  stepContent: (i: number): string => `/matches/${i}/step_content`,
  /** Title at index `i`. */
  stepTitle: (i: number): string => `/matches/${i}/step_content/title`,
  /** Body (markdown / sanitised HTML) at index `i`. */
  stepBody: (i: number): string => `/matches/${i}/step_content/body`,
  /** File path (e.g. image asset on disk) at index `i`. */
  stepFilePath: (i: number): string => `/matches/${i}/step_content/file_path`,
} as const;

// ── REPL examples ────────────────────────────────────────────────────────
// import * as jp from './vendor/jsonpointer.ts';
// import { P } from './pointers.ts';
//
// const agg = { flow: { name: 'A' }, matches: [] as any[] };
//
// // 1. Read & write a flow scalar
// jp.set(agg, P.flowName, 'Renamed');
// jp.get(agg, P.flowName);                       // 'Renamed'
//
// // 2. Append a match, then read the nested step body
// jp.set(agg, P.appendMatch, {
//   content_kind: 'note',
//   step_content: { kind: 'note', body: 'hello' },
// });
// jp.get(agg, P.stepBody(0));                    // 'hello'
//
// // 3. Update a single step title without touching the rest of the array
// jp.set(agg, P.stepTitle(0), 'A title');

// ──────────────────────────────────────────────────────────────────────────
// Git inspection — repo root / commit SHA / branch / remote URL for a path.
//
// Ported from waystation-vscode/src/db/matchUtils.ts:113-241 (the
// `getGitInfoFromCLI` path). The original file *also* has a VS-Code Git API
// fast path; we drop that here because this package runs outside VS Code.
//
// Strategy: run a series of `git` (and optional `gh`) subcommands in the
// given directory. Subprocess spawning goes through the injectable
// `CommandRunner` abstraction (src/platform.ts) so non-Deno consumers —
// the VS Code extension on Node.js, or tests with no subprocess access —
// can supply their own implementation. The default is `denoCommandRunner`.
//
// References:
//   • `git rev-parse`:    https://git-scm.com/docs/git-rev-parse
//   • `git remote`:       https://git-scm.com/docs/git-remote
//   • `gh repo view`:     https://cli.github.com/manual/gh_repo_view
// ──────────────────────────────────────────────────────────────────────────

import { relative } from '@std/path';
import type { GitInfo } from '../types.ts';
import { type CommandRunner, denoCommandRunner } from '../platform.ts';

/**
 * Extract `owner/repo` from a GitHub remote URL.
 * Accepts both HTTPS (`https://github.com/owner/repo.git`) and SSH
 * (`git@github.com:owner/repo.git`) forms. Returns `undefined` for any URL
 * that isn't recognisably GitHub-shaped.
 */
export function parseGitHubRepo(remoteUrl?: string): string | undefined {
  if (!remoteUrl) return undefined;
  // Matches the host segment in either URL form, then captures owner/repo.
  const match = remoteUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

const FALLBACK: GitInfo = {
  repoRoot: undefined,
  commitSha: 'unknown',
  branch: 'unknown',
  remoteUrl: undefined,
  repoRelativePath: undefined,
};

/**
 * Run a single git/gh command in `cwd` via the given runner. Returns the
 * trimmed stdout, or `undefined` if the command failed (non-zero exit,
 * missing binary, timeout, etc.).
 *
 * We swallow stderr deliberately — these commands are best-effort probes,
 * not user-facing operations, so logging "fatal: not a git repository" for
 * every non-repo directory would be noise.
 */
async function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  runner: CommandRunner,
): Promise<string | undefined> {
  const result = await runner(cmd, args, cwd);
  if (!result.success) return undefined;
  return result.stdout.trim() || undefined;
}

/**
 * Gather git context for a directory and (optionally) a specific file.
 *
 * The order of fallbacks for the remote URL was tuned in the original
 * extension to produce the cleanest possible `owner/repo` string:
 *   1. `gh repo view --json url`     — clean HTTPS, handles auth scopes.
 *   2. `gh repo view --json nameWithOwner` — recompose if step 1 missing.
 *   3. `git remote get-url origin`   — most reliable raw remote.
 *   4. `git config --get remote.origin.url` — older git fallback.
 *   5. First entry of `git remote`   — for repos without an `origin`.
 *
 * @param dirPath   Directory to inspect (usually the file's parent dir).
 * @param filePath  Optional file path to compute `repoRelativePath` for.
 * @param runner    Optional {@link CommandRunner} for spawning git/gh.
 *                  Defaults to `denoCommandRunner`; Node.js consumers pass
 *                  a `child_process`-backed implementation instead.
 */
export async function getGitInfo(
  dirPath: string,
  filePath?: string,
  runner: CommandRunner = denoCommandRunner,
): Promise<GitInfo> {
  try {
    const isInside = await runCmd('git', ['rev-parse', '--is-inside-work-tree'], dirPath, runner);
    if (isInside !== 'true') return FALLBACK;

    const fsRepoRoot = await runCmd('git', ['rev-parse', '--show-toplevel'], dirPath, runner);
    if (!fsRepoRoot) return FALLBACK;

    // Commit SHA — try full first, then short.
    let commitSha = await runCmd('git', ['rev-parse', 'HEAD'], dirPath, runner);
    if (!commitSha) {
      commitSha = await runCmd('git', ['rev-parse', '--short', 'HEAD'], dirPath, runner);
    }
    commitSha ||= 'unknown';

    // Branch — abbrev-ref usually works; falls back through symbolic-ref and
    // describe for detached-HEAD states.
    let branch = await runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dirPath, runner);
    if (!branch || branch === 'HEAD') {
      branch = await runCmd('git', ['symbolic-ref', '--short', 'HEAD'], dirPath, runner);
    }
    if (!branch || branch === 'HEAD') {
      branch = await runCmd('git', ['describe', '--all', '--exact-match'], dirPath, runner);
    }
    branch ||= 'unknown';

    // Remote URL — five fallbacks; see jsdoc above for rationale.
    let remoteUrl = await runCmd(
      'gh',
      ['repo', 'view', '--json', 'url', '-q', '.url'],
      dirPath,
      runner,
    );
    if (!remoteUrl) {
      const nameWithOwner = await runCmd(
        'gh',
        ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
        dirPath,
        runner,
      );
      if (nameWithOwner) remoteUrl = `https://github.com/${nameWithOwner}`;
    }
    if (!remoteUrl) {
      remoteUrl = await runCmd('git', ['remote', 'get-url', 'origin'], dirPath, runner);
    }
    if (!remoteUrl) {
      remoteUrl = await runCmd('git', ['config', '--get', 'remote.origin.url'], dirPath, runner);
    }
    if (!remoteUrl) {
      const remotes = await runCmd('git', ['remote'], dirPath, runner);
      const firstRemote = remotes?.split('\n')[0];
      if (firstRemote) {
        remoteUrl = await runCmd('git', ['remote', 'get-url', firstRemote], dirPath, runner);
      }
    }

    const repoRoot = parseGitHubRepo(remoteUrl) || fsRepoRoot;

    // Compute file path relative to the repo root. Normalised to forward
    // slashes so it round-trips cleanly across Windows and POSIX. Paths
    // outside the repo (`..`) are dropped — we don't want to record those.
    let repoRelativePath: string | undefined;
    if (filePath && fsRepoRoot) {
      try {
        repoRelativePath = relative(fsRepoRoot, filePath).replace(/\\/g, '/');
        if (repoRelativePath.startsWith('..')) repoRelativePath = undefined;
      } catch { /* leave undefined */ }
    }

    return { repoRoot, commitSha, branch, remoteUrl, repoRelativePath };
  } catch {
    return FALLBACK;
  }
}

// ── REPL examples ────────────────────────────────────────────────────────
// import { getGitInfo, parseGitHubRepo } from './flows/git.ts';
//
// // 1. Probe the current repo
// await getGitInfo(Deno.cwd());
// // → { repoRoot: 'aaronmyatt/waystation-cli', commitSha: '...', branch: 'main', ... }
//
// // 2. Compute relative path
// await getGitInfo(Deno.cwd(), `${Deno.cwd()}/src/cli.ts`);
// // → { ..., repoRelativePath: 'src/cli.ts' }
//
// // 3. Parse a remote URL
// parseGitHubRepo('git@github.com:foo/bar.git');   // 'foo/bar'
//
// // 4. Inject a custom runner (e.g. from Node.js, or a test fake)
// const fake: import('../platform.ts').CommandRunner = (_cmd, args) =>
//   Promise.resolve({ success: true, stdout: args.join(' '), stderr: '' });
// await getGitInfo('/anywhere', undefined, fake);

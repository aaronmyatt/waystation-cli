// ──────────────────────────────────────────────────────────────────────────
// Platform abstraction — runtime-specific primitives behind injectable
// interfaces.
//
// The library core (pipelines, flows, markdown) must stay runtime-agnostic
// so it can run under Deno (the CLI), Node.js (the VS Code extension via
// JSR's npm bridge), or a test harness with no subprocess access at all.
// Anything that touches `Deno.*` lives either here (as a *default*
// implementation) or in the CLI layer (`src/cli.ts`, `src/commands/`).
//
// Pattern: each capability is a small function type. Core code accepts an
// optional instance and falls back to the Deno default, so existing Deno
// callers need zero changes while other runtimes inject their own.
// See backlog TASK-12.
// ──────────────────────────────────────────────────────────────────────────

/** Outcome of running an external command via a {@link CommandRunner}. */
export type CommandResult = {
  /** True when the process exited with code 0. */
  success: boolean;
  /** Decoded stdout. Empty string when the process produced no output. */
  stdout: string;
  /** Decoded stderr. Implementations may return '' if they discard it. */
  stderr: string;
};

/**
 * Spawn an external command and wait for it to finish.
 *
 * Implementations must never throw for "normal" failures (missing binary,
 * non-zero exit, timeout) — they resolve with `success: false` instead.
 * Callers treat these as best-effort probes (e.g. git inspection), so an
 * exception-per-probe would force try/catch noise at every call site.
 *
 * @param cmd  Executable name or path (resolved against PATH).
 * @param args Argument vector — NOT a shell string; no quoting/expansion.
 * @param cwd  Working directory to run in.
 * @return     {@link CommandResult}; `success: false` on any failure.
 */
export type CommandRunner = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

/** A CommandResult representing any flavour of failure. */
const FAILED: CommandResult = { success: false, stdout: '', stderr: '' };

/**
 * Default {@link CommandRunner} backed by `Deno.Command`.
 * https://docs.deno.com/api/deno/~/Deno.Command
 *
 * Enforces a 5-second timeout per process. Deno's Command API has no
 * per-process timeout option, so we race `child.output()` against a timer
 * and SIGKILL the child if the timer wins. Clearing the timer in `finally`
 * is critical — a live timer after the test run makes Deno's test sanitizer
 * report a "leaked timer".
 */
export const denoCommandRunner: CommandRunner = async (cmd, args, cwd) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const child = new Deno.Command(cmd, {
      args,
      cwd,
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();

    const timeoutPromise = new Promise<'__TIMEOUT__'>((resolve) => {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch { /* already dead */ }
        resolve('__TIMEOUT__');
      }, 5000);
    });

    const result = await Promise.race([child.output(), timeoutPromise]);
    if (result === '__TIMEOUT__') return FAILED;
    const decoder = new TextDecoder();
    return {
      success: result.success,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    };
  } catch {
    // Missing binary, permission error, etc. — normalise to a failed result.
    return FAILED;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

// ── Filesystem abstraction ───────────────────────────────────────────────

/** Minimal stat result — just the two facts the library ever asks for. */
export type FileStat = {
  isFile: boolean;
  isDirectory: boolean;
};

/** A directory entry as yielded by {@link FileSystem.readDir}. */
export type DirEntry = {
  name: string;
  isFile: boolean;
};

/**
 * Filesystem + process-environment primitives used by the library core
 * (currently the `initDatabase` pipeline: path resolution, backups, backup
 * cleanup). Deliberately tiny — only the operations the core actually
 * performs, so a Node.js implementation is a ~20-line `fs/promises` wrapper
 * and an in-memory test fake is trivial.
 *
 * Error convention: `stat` returns `null` for a missing path instead of
 * throwing (mirroring how every call site immediately catch-and-defaults);
 * the mutating operations reject on failure and callers decide whether
 * that's fatal (backup copy) or ignorable (cleanup).
 */
export type FileSystem = {
  /** Stat a path, or `null` if it doesn't exist / isn't accessible. */
  stat(path: string): Promise<FileStat | null>;
  /** Copy a file, overwriting `dest` if present. */
  copyFile(src: string, dest: string): Promise<void>;
  /** Iterate the entries of a directory (non-recursive). */
  readDir(path: string): AsyncIterable<DirEntry>;
  /** Delete a file. */
  remove(path: string): Promise<void>;
  /** Create a directory; with `recursive` it's mkdir-p (no error if present). */
  mkdir(path: string, opts?: { recursive: boolean }): Promise<void>;
  /** Current working directory. */
  cwd(): string;
  /** Read an environment variable (e.g. HOME / USERPROFILE). */
  env(key: string): string | undefined;
};

/**
 * Default {@link FileSystem} backed by the Deno runtime APIs.
 * https://docs.deno.com/api/deno/file-system
 */
export const denoFs: FileSystem = {
  stat: async (path) => {
    try {
      const info = await Deno.stat(path);
      return { isFile: info.isFile, isDirectory: info.isDirectory };
    } catch {
      return null;
    }
  },
  copyFile: (src, dest) => Deno.copyFile(src, dest),
  // Deno.readDir entries are structurally compatible with DirEntry
  // ({ name, isFile, isDirectory, isSymlink }) — pass through directly.
  readDir: (path) => Deno.readDir(path),
  remove: (path) => Deno.remove(path),
  // { recursive: true } makes this mkdir-p: parents are created and an
  // already-existing directory is not an error.
  // https://docs.deno.com/api/deno/~/Deno.mkdir
  mkdir: (path, opts) => Deno.mkdir(path, opts),
  cwd: () => Deno.cwd(),
  env: (key) => Deno.env.get(key),
};

// ── REPL examples ────────────────────────────────────────────────────────
// import { denoCommandRunner, denoFs } from './platform.ts';
//
// // 1. Run a command that succeeds
// await denoCommandRunner('git', ['--version'], '.');
// // → { success: true, stdout: 'git version 2.x.y\n', stderr: '' }
//
// // 2. Missing binary — resolves (never throws)
// await denoCommandRunner('definitely-not-a-binary', [], '.');
// // → { success: false, stdout: '', stderr: '' }
//
// // 3. A custom runner for tests — no subprocess at all
// const fake: import('./platform.ts').CommandRunner = (cmd, args) =>
//   Promise.resolve({ success: true, stdout: `${cmd} ${args.join(' ')}`, stderr: '' });
//
// // 4. Probe the filesystem via the default FileSystem
// await denoFs.stat('deno.json');   // → { isFile: true, isDirectory: false }
// await denoFs.stat('/nope');       // → null (never throws)
// denoFs.env('HOME');               // → '/Users/you'

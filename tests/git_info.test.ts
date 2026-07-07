// Exercises getGitInfo's CommandRunner injection (TASK-12):
//   • a fake runner drives the full happy path with zero subprocesses,
//   • the remote-URL fallback chain is walked in the documented order,
//   • a non-repo directory short-circuits to the FALLBACK shape,
//   • the default (denoCommandRunner) still works against this real repo.

import { assert, assertEquals } from '@std/assert';
import { getGitInfo } from '../src/flows/git.ts';
import type { CommandRunner } from '../src/platform.ts';

/** Build a runner that answers from a lookup table keyed on `cmd args…`. */
function tableRunner(
  table: Record<string, string>,
  calls?: string[],
): CommandRunner {
  return (cmd, args, _cwd) => {
    const key = [cmd, ...args].join(' ');
    calls?.push(key);
    const stdout = table[key];
    return Promise.resolve(
      stdout !== undefined
        ? { success: true, stdout: `${stdout}\n`, stderr: '' }
        : { success: false, stdout: '', stderr: '' },
    );
  };
}

Deno.test('getGitInfo happy path via injected fake runner', async () => {
  const runner = tableRunner({
    'git rev-parse --is-inside-work-tree': 'true',
    'git rev-parse --show-toplevel': '/repo',
    'git rev-parse HEAD': 'abc123def456',
    'git rev-parse --abbrev-ref HEAD': 'main',
    'gh repo view --json url -q .url': 'https://github.com/foo/bar',
  });

  const info = await getGitInfo('/repo/src', '/repo/src/index.ts', runner);
  assertEquals(info.repoRoot, 'foo/bar');
  assertEquals(info.commitSha, 'abc123def456');
  assertEquals(info.branch, 'main');
  assertEquals(info.remoteUrl, 'https://github.com/foo/bar');
  assertEquals(info.repoRelativePath, 'src/index.ts');
});

Deno.test('getGitInfo walks the remote-URL fallback chain in order', async () => {
  // gh is unavailable (both invocations fail) → git remote get-url origin wins.
  const calls: string[] = [];
  const runner = tableRunner({
    'git rev-parse --is-inside-work-tree': 'true',
    'git rev-parse --show-toplevel': '/repo',
    'git rev-parse HEAD': 'abc123',
    'git rev-parse --abbrev-ref HEAD': 'main',
    'git remote get-url origin': 'git@github.com:foo/bar.git',
  }, calls);

  const info = await getGitInfo('/repo', undefined, runner);
  assertEquals(info.repoRoot, 'foo/bar'); // parsed from the SSH remote
  assertEquals(info.remoteUrl, 'git@github.com:foo/bar.git');

  // Both gh probes must have been attempted before the git fallback.
  const ghUrl = calls.indexOf('gh repo view --json url -q .url');
  const ghName = calls.indexOf('gh repo view --json nameWithOwner -q .nameWithOwner');
  const gitOrigin = calls.indexOf('git remote get-url origin');
  assert(ghUrl !== -1 && ghName !== -1 && gitOrigin !== -1, 'all three probes ran');
  assert(ghUrl < ghName && ghName < gitOrigin, 'fallbacks ran in documented order');
});

Deno.test('getGitInfo outside a work tree returns the fallback shape', async () => {
  const calls: string[] = [];
  const runner = tableRunner({}, calls); // every command fails
  const info = await getGitInfo('/not-a-repo', undefined, runner);
  assertEquals(info.commitSha, 'unknown');
  assertEquals(info.branch, 'unknown');
  assertEquals(info.repoRoot, undefined);
  // Short-circuits after the first probe — no pointless follow-up commands.
  assertEquals(calls, ['git rev-parse --is-inside-work-tree']);
});

Deno.test('getGitInfo drops paths outside the repo root', async () => {
  const runner = tableRunner({
    'git rev-parse --is-inside-work-tree': 'true',
    'git rev-parse --show-toplevel': '/repo',
    'git rev-parse HEAD': 'abc123',
    'git rev-parse --abbrev-ref HEAD': 'main',
  });
  const info = await getGitInfo('/repo', '/elsewhere/file.ts', runner);
  assertEquals(info.repoRelativePath, undefined);
});

Deno.test('getGitInfo default runner works against a real repo', async () => {
  // This test file lives inside the waystation-cli git repo, so the default
  // denoCommandRunner path should resolve real git context.
  const info = await getGitInfo(Deno.cwd());
  assert(info.commitSha && info.commitSha !== 'unknown', 'real commit sha resolved');
  assert(info.branch && info.branch !== 'unknown', 'real branch resolved');
});

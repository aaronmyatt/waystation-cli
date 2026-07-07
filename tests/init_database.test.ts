// Verifies that running `initDatabase` against a fresh temp directory:
//   • creates the DB file
//   • applies schema.sql (all 7 tables exist)
//   • is idempotent (second run does not fail)
//   • adds the local_only + synced_at migration columns
//   • routes every disk/env access through an injected FileSystem (TASK-13)

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { initDatabase } from '../src/pipelines/initDatabase.ts';
import { executeQuery, initializeCli } from '../src/db/sqlite.ts';
import { denoFs, type FileSystem } from '../src/platform.ts';

Deno.test('initDatabase creates DB and applies schema', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'way-init-test-' });
  try {
    const dbPath = join(dir, 'way.db');
    const ctx = await initDatabase.process({ storageDir: dir, dbPath });

    assertEquals(ctx.dbPath, dbPath);
    const stat = await Deno.stat(dbPath);
    assert(stat.isFile, 'DB file should exist after init');

    // Re-init the driver (the second .process resets state on success too)
    await initializeCli(dbPath);
    const tables = await executeQuery<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    );
    const names = tables.map((t) => t.name);
    for (
      const required of [
        'flows',
        'matches',
        'flow_matches',
        'step_contents',
        'flow_history',
        'tags',
        'flow_tags',
      ]
    ) {
      assert(names.includes(required), `expected ${required} table; got ${names.join(', ')}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('initDatabase is idempotent on a second run', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'way-init-idem-' });
  try {
    const dbPath = join(dir, 'way.db');
    await initDatabase.process({ storageDir: dir, dbPath });
    // Second run must succeed — and should produce a backup of the first DB.
    const ctx2 = await initDatabase.process({ storageDir: dir, dbPath });
    assert(ctx2.backupPath !== null, 'second init should produce a backup');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * Wrap denoFs so every call is recorded but behaviour stays real. Proves the
 * pipeline actually routes its disk/env access through the injected instance
 * rather than reaching for Deno.* directly.
 */
function spyFs(calls: string[]): FileSystem {
  return {
    stat: (p) => (calls.push(`stat ${p}`), denoFs.stat(p)),
    copyFile: (s, d) => (calls.push(`copyFile ${s} -> ${d}`), denoFs.copyFile(s, d)),
    readDir: (p) => (calls.push(`readDir ${p}`), denoFs.readDir(p)),
    remove: (p) => (calls.push(`remove ${p}`), denoFs.remove(p)),
    mkdir: (p, o) => (calls.push(`mkdir ${p}`), denoFs.mkdir(p, o)),
    cwd: () => (calls.push('cwd'), denoFs.cwd()),
    env: (k) => (calls.push(`env ${k}`), denoFs.env(k)),
  };
}

Deno.test('initDatabase routes disk access through an injected FileSystem', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'way-init-fs-' });
  try {
    const dbPath = join(dir, 'way.db');
    const calls: string[] = [];

    // First run: fresh install — stat(dbPath) misses, no backup copy.
    await initDatabase.process({ storageDir: dir, dbPath, fs: spyFs(calls) });
    assert(calls.some((c) => c === `mkdir ${dir}`), 'storage dir created via injected fs');
    assert(calls.some((c) => c === `stat ${dbPath}`), 'db existence probed via injected fs');
    assert(!calls.some((c) => c.startsWith('copyFile')), 'no backup on fresh install');

    // Second run: DB now exists — the backup copy must also go through the spy.
    calls.length = 0;
    const ctx2 = await initDatabase.process({ storageDir: dir, dbPath, fs: spyFs(calls) });
    assert(ctx2.backupPath, 'second init should produce a backup');
    assert(
      calls.some((c) => c === `copyFile ${dbPath} -> ${ctx2.backupPath}`),
      'backup copied via injected fs',
    );
    assert(calls.some((c) => c === `readDir ${dir}`), 'backup cleanup listed via injected fs');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('initDatabase resolves $HOME through the injected FileSystem env', async () => {
  const fakeHome = await Deno.makeTempDir({ prefix: 'way-init-home-' });
  try {
    // No homeDir / storageDir / dbPath inputs — the pipeline must consult
    // fs.env('HOME') and land the DB at $HOME/.waystation/way.db.
    const fs: FileSystem = { ...denoFs, env: (k) => (k === 'HOME' ? fakeHome : undefined) };
    const ctx = await initDatabase.process({ fs });

    assertEquals(ctx.dbPath, join(fakeHome, '.waystation', 'way.db'));
    const stat = await Deno.stat(ctx.dbPath!);
    assert(stat.isFile, 'DB created under the fake HOME');
  } finally {
    await Deno.remove(fakeHome, { recursive: true });
  }
});

Deno.test('initDatabase adds local_only and synced_at columns', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'way-init-cols-' });
  try {
    const dbPath = join(dir, 'way.db');
    await initDatabase.process({ storageDir: dir, dbPath });
    await initializeCli(dbPath);

    // pragma_table_info → one row per column. We just check presence.
    const cols = await executeQuery<{ name: string }>(
      `SELECT name FROM pragma_table_info('flows')`,
    );
    const names = cols.map((c) => c.name);
    assert(names.includes('local_only'), 'flows.local_only column missing');
    assert(names.includes('synced_at'), 'flows.synced_at column missing');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

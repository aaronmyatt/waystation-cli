// Verifies that running `initDatabase` against a fresh temp directory:
//   • creates the DB file
//   • applies schema.sql (all 7 tables exist)
//   • is idempotent (second run does not fail)
//   • adds the local_only + synced_at migration columns

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { initDatabase } from '../src/pipelines/initDatabase.ts';
import { executeQuery, initializeCli } from '../src/db/sqlite.ts';

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

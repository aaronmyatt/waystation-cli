// Verifies the DatabaseDriver abstraction (TASK-14):
//   • initDatabase accepts an injected driver and registers it for the
//     helper layer, so downstream pipelines run through it,
//   • saveMatch / buildFlowAggregate / exportMarkdown all route their DB
//     access through the injected driver (no direct sqlite.ts reach-around),
//   • a *standalone* driver — sharing zero module state with db/sqlite.ts,
//     structurally what a Node.js child_process implementation looks like —
//     can be substituted and the pipelines behave identically,
//   • the sqlite3-CLI probe is skipped for injected drivers.

import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { initDatabase } from '../src/pipelines/initDatabase.ts';
import { saveMatch } from '../src/pipelines/saveMatch.ts';
import { buildFlowAggregate } from '../src/pipelines/buildFlowAggregate.ts';
import { exportMarkdown } from '../src/pipelines/exportMarkdown.ts';
import type { DatabaseDriver } from '../src/db/driver.ts';
import { denoSqliteDriver } from '../src/db/sqlite.ts';

// ── Spy driver: real behaviour, recorded calls ───────────────────────────

/**
 * Wrap denoSqliteDriver so every interface call is recorded but behaviour
 * stays real. Proves the core routes DB access through the *registered*
 * driver rather than importing the Deno implementation directly (same
 * pattern as the spyFs in init_database.test.ts).
 */
function spyDriver(calls: string[]): DatabaseDriver {
  return {
    initialize: (p, l) => (calls.push(`initialize ${p}`), denoSqliteDriver.initialize(p, l)),
    query: (sql, p) => (calls.push(`query ${firstWords(sql)}`), denoSqliteDriver.query(sql, p)),
    get: (sql, p) => (calls.push(`get ${firstWords(sql)}`), denoSqliteDriver.get(sql, p)),
    run: (sql, p) => (calls.push(`run ${firstWords(sql)}`), denoSqliteDriver.run(sql, p)),
    transaction: (s) => (calls.push('transaction'), denoSqliteDriver.transaction(s)),
    batch: (s) => (calls.push('batch'), denoSqliteDriver.batch(s)),
    checkpoint: () => (calls.push('checkpoint'), denoSqliteDriver.checkpoint()),
    applySchema: (sql) => (calls.push('applySchema'), denoSqliteDriver.applySchema(sql)),
    getPath: () => denoSqliteDriver.getPath(),
  };
}

/** First few words of a SQL string — enough to identify the call in asserts. */
function firstWords(sql: string): string {
  return sql.trim().split(/\s+/).slice(0, 3).join(' ');
}

Deno.test('initDatabase + downstream pipelines route through an injected driver', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'way-driver-spy-' });
  try {
    const dbPath = join(dir, 'way.db');
    const calls: string[] = [];

    // AC #4: InitCtx accepts an optional driver.
    await initDatabase.process({ storageDir: dir, dbPath, driver: spyDriver(calls) });
    assert(calls.some((c) => c === `initialize ${dbPath}`), 'initialize via injected driver');
    assert(calls.includes('applySchema'), 'schema applied via injected driver');
    assert(
      calls.some((c) => c.startsWith('query SELECT COUNT(*)')),
      'column migrations probed via injected driver',
    );

    // AC #6: pipelines that only touch db/helpers.ts must hit the same
    // driver — it stays registered after init.
    calls.length = 0;
    const saved = await saveMatch.process({
      match: { line: 'const x = 1;', file_path: '/tmp/file.ts', file_name: 'file.ts', line_no: 5 },
    });
    assert(saved.resultMatchId, 'saveMatch works through injected driver');
    assert(calls.some((c) => c.startsWith('run')), 'saveMatch writes via injected driver');

    calls.length = 0;
    const { aggregate } = await buildFlowAggregate.process({ flowId: saved.flowId! });
    assertEquals(aggregate?.matches.length, 1);
    assert(calls.some((c) => c.startsWith('get')), 'aggregate reads via injected driver');

    calls.length = 0;
    const { markdown } = await exportMarkdown.process({ flowId: saved.flowId! });
    // No step_content/grep_meta captured → heading falls back to "Step 1"
    // and the file path appears in the step's relative link.
    assert(markdown?.includes('Step 1'), 'export renders through injected driver');
    assert(markdown?.includes('file.ts'), 'export links the captured file');
    assert(calls.some((c) => c.startsWith('query')), 'export queries via injected driver');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Standalone driver: zero shared state with db/sqlite.ts ──────────────

/**
 * A from-scratch DatabaseDriver that shells out to sqlite3 with its own
 * state, its own parameter binding, and piped stdin — structurally the same
 * implementation a Node.js consumer writes with `child_process` (AC #5).
 * It never touches db/sqlite.ts, so passing pipelines with it proves the
 * interface is complete: nothing in the core secretly needs the Deno driver.
 */
function standaloneDriver(): DatabaseDriver & { calls: string[] } {
  let dbPath = '';
  const calls: string[] = [];

  // Same ?-placeholder substitution contract as the reference driver.
  const bind = (sql: string, params: unknown[] = []): string => {
    let i = 0;
    return sql.replace(/\?/g, () => {
      const p = params[i++];
      if (p === null || p === undefined) return 'NULL';
      if (typeof p === 'number') return String(p);
      if (typeof p === 'boolean') return p ? '1' : '0';
      return `'${String(p).replace(/'/g, "''")}'`;
    });
  };

  // The Node analogue is child_process.spawn('sqlite3', ...) + stdin.write.
  const exec = async (sql: string): Promise<string> => {
    const child = new Deno.Command('sqlite3', {
      args: ['-json', dbPath],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(sql));
    await writer.close();
    const { stdout, stderr, code } = await child.output();
    if (code !== 0) {
      throw new Error(`sqlite3 exit ${code}: ${new TextDecoder().decode(stderr)}`);
    }
    return new TextDecoder().decode(stdout);
  };

  const query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
    calls.push('query');
    const out = await exec(bind(sql, params ?? []));
    return out.trim() ? JSON.parse(out) : [];
  };

  return {
    calls,
    async initialize(p, _logger) {
      calls.push('initialize');
      dbPath = p;
      await exec('PRAGMA journal_mode=WAL;\nPRAGMA busy_timeout=5000;');
    },
    query,
    get: async <T>(sql: string, params?: unknown[]) => (await query<T>(sql, params))[0],
    run: async (sql, params) => {
      await query(sql, params);
    },
    transaction: async (statements) => {
      calls.push('transaction');
      const body = statements.map((s) => bind(s.sql, s.params ?? []) + ';').join('\n');
      await exec(`BEGIN TRANSACTION;\n${body}\nCOMMIT;`);
    },
    batch: async (statements) => {
      for (const s of statements) await query(s.sql, s.params ?? []);
    },
    checkpoint: async () => {
      await exec('PRAGMA wal_checkpoint(TRUNCATE);');
    },
    applySchema: async (sql) => {
      calls.push('applySchema');
      await exec(sql);
    },
    getPath: () => dbPath,
  };
}

Deno.test('a standalone (child_process-shaped) driver can be fully substituted', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'way-driver-standalone-' });
  try {
    const dbPath = join(dir, 'way.db');
    const driver = standaloneDriver();

    // Full pipeline run: schema resolution must hand the driver inline SQL
    // (never a file path — only the Deno driver tolerates paths), and the
    // sqlite3-CLI probe stage must be skipped for a non-default driver.
    const ctx = await initDatabase.process({ storageDir: dir, dbPath, driver });
    assertEquals(ctx.sqliteVersion, undefined, 'Deno CLI probe skipped for injected driver');
    assert(driver.calls.includes('applySchema'), 'schema applied by the standalone driver');

    // The whole capture → aggregate → render chain works with zero calls
    // into the Deno driver's module state. grep_meta carries the context
    // lines the markdown code block renders from — and its JSON is full of
    // quotes, so this also exercises the driver's own parameter binding.
    const saved = await saveMatch.process({
      match: {
        line: "it's quoted",
        file_path: '/tmp/q.ts',
        file_name: 'q.ts',
        line_no: 1,
        grep_meta: JSON.stringify({
          context_lines: ["it's quoted"],
          context_start_line: 1,
          matched_index_in_context: 0,
          language: 'typescript',
        }),
      },
    });
    const { markdown } = await exportMarkdown.process({ flowId: saved.flowId! });
    assert(markdown?.includes("it's quoted"), 'round-trip (incl. quote binding) works');
    assertEquals(driver.getPath(), dbPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

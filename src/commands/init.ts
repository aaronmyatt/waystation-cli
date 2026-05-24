// ──────────────────────────────────────────────────────────────────────────
// `way init` — bootstrap the SQLite database.
// ──────────────────────────────────────────────────────────────────────────

import { initDatabase } from '../pipelines/initDatabase.ts';

export async function initCommand(opts: { dbPath?: string; verbose?: boolean }): Promise<void> {
  const ctx = await initDatabase.process({
    homeDir: Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE'),
    dbPath: opts.dbPath,
    logger: opts.verbose
      ? { log: console.log, warn: console.warn, error: console.error }
      : undefined,
  });
  console.log(`Initialised at ${ctx.dbPath}`);
}

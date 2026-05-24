// ──────────────────────────────────────────────────────────────────────────
// Shared helpers for `way` subcommands. Resolves the default DB path so
// every command spells it the same way.
// ──────────────────────────────────────────────────────────────────────────

import { join } from '@std/path';

/** Mirrors the extension's storage location: $HOME/.waystation/way.db. */
export function defaultDbPath(): string {
  const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE');
  if (!home) {
    throw new Error('Cannot resolve default DB path: $HOME is unset. Pass --db <path>.');
  }
  return join(home, '.waystation', 'way.db');
}

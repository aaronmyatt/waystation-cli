// ──────────────────────────────────────────────────────────────────────────
// `way sync` — stub. Real push/pull lands in a follow-up.
// ──────────────────────────────────────────────────────────────────────────

export function syncCommand(): void {
  console.error(
    'sync is not yet implemented. Push/pull HTTP wiring lands in a follow-up — ' +
      'see src/pipelines/sync.ts for the shape of the future contexts.',
  );
  Deno.exit(2);
}

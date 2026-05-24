// ──────────────────────────────────────────────────────────────────────────
// `way show <flowId>` — display a single flow.
//
// Three output modes:
//   • default (--pretty): full markdown rendered through glow/bat/marked-terminal
//   • --json:             raw FlowAggregate JSON, suitable for piping into jq
//   • --raw:              structured field-by-field plain-text dump
// ──────────────────────────────────────────────────────────────────────────

import * as jp from '../vendor/jsonpointer.ts';
import { P } from '../pointers.ts';
import { initializeCli } from '../db/sqlite.ts';
import { buildFlowAggregate } from '../pipelines/buildFlowAggregate.ts';
import { exportMarkdown } from '../pipelines/exportMarkdown.ts';
import { prettyPrintMarkdown } from '../flows/renderTerminal.ts';
import { defaultDbPath } from './_common.ts';
import type { FlowMatchState } from '../types.ts';

export async function showCommand(
  flowId: string,
  opts: { dbPath?: string; json?: boolean; raw?: boolean },
): Promise<void> {
  if (!flowId) throw new Error('show: missing <flowId> argument');
  await initializeCli(opts.dbPath ?? defaultDbPath());

  if (opts.json) {
    const { aggregate } = await buildFlowAggregate.process({ flowId });
    console.log(JSON.stringify(aggregate, null, 2));
    return;
  }

  if (!opts.raw) {
    // Default path: render the flow as markdown via the export pipeline,
    // then push it through the glow/bat/marked-terminal chain. We re-use
    // the same renderer the `export` command uses to keep output
    // consistent across the two commands.
    // `noInlineLinks: true` strips the `[heading](file://...)` link so
    // glow/marked-terminal don't break the long URL across lines.
    const { markdown } = await exportMarkdown.process({
      flowId,
      render: { export: false, noInlineLinks: true },
    });
    await prettyPrintMarkdown(markdown ?? '');
    return;
  }

  // --raw: structured field-by-field dump (the original default).
  const { aggregate } = await buildFlowAggregate.process({ flowId });

  // Read every field through pointers so the print path matches what the
  // markdown renderer and external consumers see.
  console.log(`# ${jp.get(aggregate, P.flowName)}`);
  console.log(`  id: ${jp.get(aggregate, P.flowId)}`);
  const desc = jp.get(aggregate, P.flowDescription);
  if (desc) console.log(`  description: ${desc}`);
  console.log(`  updated_at: ${jp.get(aggregate, P.flowUpdatedAt)}`);
  console.log();
  const matches = (jp.get(aggregate, P.matches) as FlowMatchState[]) ?? [];
  console.log(`Steps (${matches.length}):`);
  matches.forEach((_m, i) => {
    const kind = jp.get(aggregate, P.matchKind(i));
    if (kind === 'match') {
      const file = jp.get(aggregate, P.matchFilePath(i));
      const line = jp.get(aggregate, P.matchLineNo(i));
      console.log(`  ${i + 1}. [${kind}] ${file}:${line}`);
    } else {
      const title = jp.get(aggregate, P.stepTitle(i)) || '(untitled)';
      console.log(`  ${i + 1}. [${kind}] ${title}`);
    }
  });
}

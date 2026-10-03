/**
 * Apply stage runbooks and completion requirements to a board.
 *
 * `PATCH /v1/boards/:id/stages/:key` one stage at a time, which is what that route is
 * for: a whole-pipeline PUT would discard a concurrent edit to a stage nobody here
 * touched.
 *
 * Dry run by default. Writing board configuration is the kind of thing that should be
 * read once before it happens.
 *
 *   bun scripts/apply-stage-config.ts <config.json...>          # show
 *   bun scripts/apply-stage-config.ts --write <config.json...>  # do
 *
 * The configs are NOT in this repository and should not be: a board's stage text and
 * its board ids are one deployment's data, and this repository is public. Keep them
 * wherever that deployment keeps its operations and pass the paths in.
 */
import { resolveCredential, baseUrl } from '../packages/cli/src/credential';

interface StageConfig {
  completion?: unknown;
  instructions?: string;
}
interface BoardConfig {
  boardId: string;
  board: string;
  stages: Record<string, StageConfig>;
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const files = args.filter((a) => a !== '--write');
if (files.length === 0) {
  console.error('usage: apply.ts [--write] <config.json...>');
  process.exit(1);
}

const cred = await resolveCredential();
if (!cred) {
  console.error('no credential — run `supi login` first');
  process.exit(1);
}
const base = baseUrl().replace(/\/+$/, '');

let changed = 0;
let failed = 0;

for (const file of files) {
  const cfg = (await Bun.file(file).json()) as BoardConfig;
  console.log(`\n=== ${cfg.board} (${cfg.boardId}) — ${Object.keys(cfg.stages).length} stages`);

  for (const [key, stage] of Object.entries(cfg.stages)) {
    const body: Record<string, unknown> = {};
    if (stage.completion !== undefined) body.completion = stage.completion;
    if (stage.instructions !== undefined) body.instructions = stage.instructions;

    const words = (stage.instructions ?? '').split(/\s+/).filter(Boolean).length;
    const summary = `${key.padEnd(14)} completion=${JSON.stringify(stage.completion ?? null)} instructions=${words}w`;

    if (!write) {
      console.log(`  would patch  ${summary}`);
      continue;
    }

    const res = await fetch(
      `${base}/v1/boards/${encodeURIComponent(cfg.boardId)}/stages/${encodeURIComponent(key)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${cred.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (res.ok) {
      changed += 1;
      console.log(`  patched      ${summary}`);
    } else {
      failed += 1;
      console.log(`  FAILED ${res.status} ${key}: ${(await res.text()).slice(0, 200)}`);
    }
  }
}

console.log(write ? `\npatched ${changed}, failed ${failed}` : '\ndry run — pass --write to apply');
if (failed > 0) process.exit(1);

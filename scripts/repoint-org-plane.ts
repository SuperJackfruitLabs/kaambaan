/**
 * Re-point this catalog's tenant and user mappings from the hub's ids to the Organization plane's
 * (P4 cutover; plan docs/superpowers/plans/2026-10-06-p3-org-plane-consumer.md Task 10).
 *
 * Dry run by default. The mapping file is a deployment's data and never lives in this repository.
 * The target is never defaulted: name `--local` (the dev D1) or `--remote` (production) every time.
 *
 *   bun scripts/repoint-org-plane.ts --mapping map.json --remote                    # show the plan
 *   bun scripts/repoint-org-plane.ts --mapping map.json --remote --write            # apply, then verify
 *   bun scripts/repoint-org-plane.ts --mapping map.json --remote --reverse --write  # rollback
 *
 * Mapping file shape (`RepointMapping`):
 *   { "tenants": { "fleet_…": "org_…" }, "chosenTenants": { "org_…": "tnt_…" }, "users": { "<hub user id>": "prn_…" } }
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planRepoint, type CatalogSnapshot, type RepointMapping } from '../apps/api/src/db/repoint-org-plane';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const mappingPath = args[args.indexOf('--mapping') + 1];
const USAGE = 'usage: bun scripts/repoint-org-plane.ts --mapping <file> (--local | --remote) [--reverse] [--write]';
if (!flag('--mapping') || !mappingPath || mappingPath.startsWith('--')) {
  console.error(USAGE);
  process.exit(64);
}
// Production is one flag away from the dev database; make the choice explicit rather than a default.
if (flag('--local') === flag('--remote')) {
  console.error(`Name exactly one target, --local or --remote.\n${USAGE}`);
  process.exit(64);
}
const where = flag('--local') ? '--local' : '--remote';
const direction = flag('--reverse') ? 'reverse' : 'forward';

function d1(extra: string[]): string {
  return execFileSync('pnpm', ['--filter', '@superpipeline/api', 'exec', 'wrangler', 'd1', 'execute', 'superpipeline-catalog', where, ...extra], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}
function rows(sql: string): CatalogSnapshot['tenants'] {
  const out = JSON.parse(d1(['--json', '--command', sql])) as Array<{ results: CatalogSnapshot['tenants'] }>;
  return out[0]!.results;
}
function snapshot(): CatalogSnapshot {
  return {
    tenants: rows(`SELECT id, external_source, external_id FROM tenants ORDER BY id`),
    users: rows(`SELECT id, external_source, external_id FROM users ORDER BY id`),
  };
}

const mapping = JSON.parse(readFileSync(mappingPath, 'utf8')) as RepointMapping;
let plan: ReturnType<typeof planRepoint>;
try {
  plan = planRepoint(snapshot(), mapping, direction);
} catch (e) {
  // A malformed mapping file: say which entry, without a stack.
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(64);
}
console.log(JSON.stringify({ direction, target: where, tenants: plan.tenants, users: plan.users, unmapped: plan.unmapped, conflicts: plan.conflicts, statements: plan.statements.length }, null, 2));

if (!flag('--write')) {
  console.log('\nDry run. Nothing was written. Re-run with --write to apply.');
  process.exit(plan.conflicts.length > 0 ? 2 : 0);
}
if (plan.conflicts.length > 0) {
  console.error('Refusing to write while conflicts remain. Resolve them in the mapping file (chosenTenants) first.');
  process.exit(2);
}
if (plan.statements.length > 0) {
  const file = join(mkdtempSync(join(tmpdir(), 'repoint-')), 'repoint.sql');
  writeFileSync(file, plan.statements.join('\n') + '\n');
  d1(['--file', file, '--yes']);
  rmSync(dirname(file), { recursive: true, force: true });
}
// Verify the outcome, not the trigger: a fresh snapshot must plan nothing.
const residue = planRepoint(snapshot(), mapping, direction);
if (residue.statements.length > 0) {
  console.error(`Applied, but ${residue.statements.length} statement(s) still pending — inspect before switching ORG_PLANE_*.`);
  process.exit(1);
}
console.log(`Applied ${plan.statements.length} statement(s); a fresh snapshot plans nothing.`);

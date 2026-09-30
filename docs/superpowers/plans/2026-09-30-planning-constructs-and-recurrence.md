# Planning constructs & recurrence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give superpipeline boards labels, due dates, dependencies, sub-tasks, projects, milestones and recurring cards, so that "repeated tasks" and "planning" stop being names without machinery.

**Architecture:** One consistency line. Cards live in per-board Durable Objects, so everything that may **refuse** a claim or an advance is stored in the board DO (strong), and everything merely **informational** is stored in D1 and may span boards (eventual). The claim hot path never leaves the DO. Dependencies and sub-tasks are one table with a `kind` column; recurrence rides the worker cron that already walks every board.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite) + D1; TypeScript; vitest with `cloudflare:test`; SvelteKit 5 (runes) for `apps/web`; zod in `packages/contract`; `supi` in `packages/cli`.

**Spec:** `docs/superpowers/specs/2026-09-30-planning-constructs-and-recurrence-design.md`

## Global Constraints

- **TDD.** Failing test first, watched to fail, then minimal code. Every bug fix gets a regression test.
- **Superpipeline only.** No change to agentpod, supermessage or estate is permitted by this plan. If a task appears to need one, stop and report — see spec §5b.
- **Every DO column uses the guarded-ALTER pattern** (`apps/api/src/board/board-do.ts:919-923`). There is no schema-version table; idempotent DDL *is* the migration:
  ```ts
  try {
    this.sql.exec(`ALTER TABLE cards ADD COLUMN due_at TEXT`);
  } catch {
    // column already exists
  }
  ```
- **A new `cards` column is not done until it is in three places:** the guarded ALTER, the `CardView` interface (`board-do.ts:265-287`), and the row mapper (`board-do.ts:3256`). A column absent from the mapper reads back `undefined` with no error.
- **D1 modules follow `apps/api/src/db/capabilities.ts` exactly:** hand-written SQL, and `tenant_id = ?` is **always** the first predicate. Principle 8 — a tenant boundary is "never a filter you could forget to apply". Do **not** register new tables in `TENANT_SCOPED_TABLES` unless you read them through `tenantScopedSelect`; `capabilities` is not registered and does not use it.
- **Ids** come from `newId()` (`apps/api/src/ids.ts`). New prefixes, matching the existing 14: `lbl`, `prj`, `mls`, `sch`.
- **Ordering must be portable:** write `(col IS NULL), col ASC`, never `NULLS LAST`.
- **Never use `isTerminal()` to decide whether a blocker is resolved.** `TERMINAL_STATES` (`packages/contract/src/primitives.ts:20`) includes `failed` and `rejected`. Resolved means state ∈ `{'completed', 'canceled'}` and nothing else. This is the single most likely silent bug in the plan.
- **Required CI checks** must pass before any PR merges; the branch must be up to date (`strict`).
- **Commit after every task.** Branch per phase; PR per phase.
- **Each phase ends with a live-run check on a real board**, listed in the phase's final task. Unit tests posting to a permissive fake missed bug #625 entirely; only a live run found it.

## File Structure

**`apps/api/src/board/board-do.ts`** — the board Durable Object. Gains: `labels`, `archived_at`, `due_at`, `overdue_notified_at`, `project_id`, `milestone_id` columns on `cards`; the `card_links` and `schedules` tables; `fireDueSchedules`, `notifyOverdue`, link CRUD, the claim exclusion, the advance refusal, `splitCard`. It is already ~3400 lines; **new cohesive logic goes in a sibling module and is called from here** rather than growing it further.

- **`apps/api/src/board/links.ts`** *(new)* — pure predicates and the cycle check over `card_links` rows. Pure so it is testable without a DO.
- **`apps/api/src/board/recurrence.ts`** *(new)* — the recurrence-rule grammar: parse, validate, and `nextFireAt(rule, tz, after)`. Pure, no DO, no clock.
- **`apps/api/src/db/labels.ts`** *(new)* — D1 label catalogue.
- **`apps/api/src/db/projects.ts`** *(new)* — D1 projects + milestones + the rollup cache.
- **`apps/api/migrations/0010_labels.sql`** (Task 4), **`0011_card_links_external.sql`** (Task 16), **`0012_projects_and_milestones.sql`** (Task 18) *(new)* — numbered in the order the phases run.
- **`apps/api/src/index.ts`** — new routes; the `scheduled()` handler gains the board sweep.
- **`packages/contract/src/entities.ts`** — `Stage.completion` added; `Card.currentTaskId` removed; `Card.labels`/`archivedAt` become real.
- **`apps/web/src/lib/`** — `api.ts` types + calls; `CardTile.svelte` (label chips, due from column, blocker badge); `FilterBar.svelte`; `plan/ListView.svelte`; `CardDrawer.svelte` (labels, due, sub-tasks, blockers); new `components/plan/ProjectView.svelte`; new `components/board/ScheduleList.svelte` under settings.
- **`packages/cli/src/index.ts`** — `supi label`, `supi schedule`, `supi link`, `supi project`.

---

## Task 1: Verify `Intl` timezone support in workerd

This gates **Phase 2 only** and is cheap, so it runs first: if `workerd`'s ICU build has no zone data, recurrence becomes UTC-plus-fixed-offset and Task 12's UI changes shape.

**Files:**
- Test: `apps/api/test/intl-timezone-support.test.ts` (create; **delete in Task 13** once `recurrence.ts` covers it)

**Interfaces:**
- Produces: a recorded answer, in the PR body, to "may `nextFireAt` use IANA zones?"

- [ ] **Step 1: Write the probe as a test**

```ts
import { describe, it, expect } from 'vitest';

describe('workerd Intl', () => {
  it('formats a wall-clock time in a named IANA zone', () => {
    const f = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    // 2026-01-15T00:00:00Z is 05:30 in Asia/Kolkata (UTC+5:30).
    expect(f.format(new Date('2026-01-15T00:00:00Z'))).toBe('05:30');
  });

  it('recognises the zone rather than silently falling back to UTC', () => {
    const resolved = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata' }).resolvedOptions();
    // ICU canonicalises Asia/Kolkata to its older alias Asia/Calcutta, so the string that comes
    // back is NOT the string that went in. Asserting equality here fails on a runtime that
    // supports zones perfectly well. What matters is that a REAL zone came back: a runtime with no
    // zone data answers 'UTC'.
    expect(resolved.timeZone).not.toBe('UTC');
    // …and that the spelling it returned denotes the same zone as the one we asked for.
    const at = new Date('2026-01-15T00:00:00Z');
    const hhmm = (tz: string): string =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(at);
    expect(hhmm(resolved.timeZone)).toBe(hhmm('Asia/Kolkata'));
  });

  it('throws RangeError on an unknown zone — which is how a schedule validates one', () => {
    // Task 9 uses this: a zone is validated by trying to construct a formatter, never by
    // comparing strings, because the canonical spelling differs from the input.
    expect(() => new Intl.DateTimeFormat('en-GB', { timeZone: 'Mars/Olympus' })).toThrow(RangeError);
  });
});
```

> **Carry this into Phase 2.** Two consequences of the aliasing, both cheap to get wrong:
> 1. `createSchedule` validates a `timezone` by **constructing an `Intl.DateTimeFormat` and catching
>    `RangeError`**, never by comparing against a list or against `resolvedOptions().timeZone`.
> 2. Store and display the **operator's own spelling**. Echoing `resolvedOptions().timeZone` back
>    would show someone who typed `Asia/Kolkata` a schedule that says `Asia/Calcutta`, which reads
>    as a bug. `recurrence.ts` must never compare zone strings for equality.

- [ ] **Step 2: Run it**

Run: `cd apps/api && pnpm vitest run test/intl-timezone-support.test.ts`

Two possible outcomes, and **both are a result, not a failure**:
- **PASS** → Phase 2 uses IANA zones as specced. Record it and continue.
- **FAIL** — specifically `05:30` coming back as `00:00`, or a `RangeError` on `Asia/Kolkata` → zone data is absent. Record the exact failure, then **amend the spec's §3.7** to a `utc_offset_minutes INTEGER` column in place of `timezone TEXT`, and note that the Task 12 UI collects an offset rather than a zone. Do not work around it in code.

A mismatch in the *spelling* of the resolved zone is neither of those — it is ICU canonicalisation and is expected. All three tests must be green before this task is complete; a committed red test takes CI down.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/intl-timezone-support.test.ts
git commit -m "test: record whether workerd Intl supports IANA time zones"
```

---

# Phase 1 — contract cleanup, labels, due dates

Branch: `feat/planning-phase1-labels-and-dates`

## Task 2: Close the contract drift

`docs/01` warns that this drift is design intent, so this closes a known gap.

**Files:**
- Modify: `packages/contract/src/entities.ts:79-107` (Stage), `:166-181` (Card)
- Modify: `packages/contract/test/entities.test.ts` — its `entity schemas` describe already covers Stage defaults (`:5`) and Card defaults *including* `labels` (`:31`), so these cases extend it. Do **not** create a second test file for one module, and do not re-assert the `labels` default that `:31` already owns.

**Interfaces:**
- Produces: `Stage.completion?: CompletionRequirement | null`; `Card` without `currentTaskId`; `Card.labels` and `Card.archivedAt` now backed by storage (Task 3).

- [ ] **Step 1: Write the failing tests**

Add `Stage` to the existing import in `test/entities.test.ts`:

```ts
import { Agent, Board, Card, Reference, Stage, Tenant } from '../src';
```

Then add these cases inside the existing `describe('entity schemas', ...)` block:

```ts
  it('carries the completion requirement the Board DO already enforces', () => {
    const parsed = Stage.parse({
      key: 'publish',
      name: 'Publish',
      order: 0,
      ownerKind: 'capability',
      owner: 'code',
      completion: { handoff: ['url'], reference: { provider: 'forge', sourceType: 'commit' } },
    });
    expect(parsed.completion).toEqual({
      handoff: ['url'],
      reference: { provider: 'forge', sourceType: 'commit' },
    });
  });

  it('leaves completion absent on a stage that declares no rule', () => {
    const parsed = Stage.parse({ key: 'draft', name: 'Draft', order: 0, ownerKind: 'human' });
    expect(parsed.completion).toBeUndefined();
  });

  it('no longer declares currentTaskId on a card, because Task is not implemented', () => {
    // docs/01 warns that Task has no table and no id is ever minted. A contract field for a
    // record that cannot exist is a trap for anyone writing a client against it.
    expect('currentTaskId' in Card.shape).toBe(false);
  });

  it('leaves archivedAt absent on a fresh card', () => {
    const card = Card.parse({
      id: 'card_0000000000000001',
      boardId: 'brd_0000000000000001',
      tenantId: 'tnt_0000000000000001',
      contextId: 'ctx_0000000000000001',
      title: 'A card',
      ownerUserId: 'usr_0000000000000001',
      currentStageKey: 'draft',
      createdAt: '2026-09-30T00:00:00.000Z',
    });
    expect(card.archivedAt).toBeUndefined();
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/contract && pnpm vitest run test/entities.test.ts`
Expected: FAIL on two of the four — `completion` is stripped by zod (so `toEqual` receives `undefined`), and `'currentTaskId' in Card.shape` is `true`. The other two pass immediately, which is fine: they are guards, not the change.

Baseline for comparison: the contract suite is **98 passing across 8 files** before this task.

- [ ] **Step 3: Make the changes**

In `packages/contract/src/entities.ts`, add to the `Stage` object (after `gate`), importing `CompletionRequirement` from `./completion`:

```ts
  /**
   * The stage's standing rule for what a completion must carry, enforced by `evaluateCompletion`.
   * It has been on the Board DO (`board-do.ts:115`) and absent here since it shipped; a contract
   * that omits a field the server enforces is a trap for anyone writing a client against it.
   */
  completion: CompletionRequirement.nullish(),
```

And delete this line from `Card`:

```ts
  currentTaskId: TaskId.optional(),
```

If `TaskId` becomes unused, leave the export in `ids.ts` — `docs/01` still documents Task as design intent and removing the id type would erase that.

- [ ] **Step 4: Run the test and the whole contract suite**

Run: `cd packages/contract && pnpm vitest run`
Expected: PASS, and no other contract test breaks. If one does, it was reading `currentTaskId` — fix the test, not the contract.

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src/entities.ts packages/contract/test/entities.test.ts
git commit -m "fix(contract): carry Stage.completion, drop the unimplemented Card.currentTaskId"
```

---

## Task 3: The four new card columns

**Files:**
- Modify: `apps/api/src/board/board-do.ts` — guarded ALTERs beside the existing ones (~`:948`), `CardView` (`:258-287`), `rowToCard` (`:3240`)
- Test: `apps/api/test/card-planning-columns.test.ts` (create)

**Interfaces:**
- Produces: `CardView.labels: string[]`, `CardView.dueAt: string | null`, `CardView.archivedAt: string | null`. `overdue_notified_at` is internal — deliberately **not** on `CardView`, because nothing outside the sweep may read it.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('BoardDO — planning columns', () => {
  it('a new card reads back with empty labels and no due or archived date', async () => {
    await runInDurableObject(stubFor('pc-defaults'), async (board: BoardDO) => {
      await board.init({ id: 'brd_pc', tenantId: 'tnt_a', name: 'PC', stages: STAGES });
      const created = await board.createCard({ title: 'A card', ownerUserId: 'usr_a' });
      if (!created.ok) throw new Error(created.message);
      expect(created.value.labels).toEqual([]);
      expect(created.value.dueAt).toBeNull();
      expect(created.value.archivedAt).toBeNull();
    });
  });

  it('migrates an existing spec.due onto the column and clears it from the spec', async () => {
    await runInDurableObject(stubFor('pc-backfill'), async (board: BoardDO) => {
      await board.init({ id: 'brd_pc2', tenantId: 'tnt_a', name: 'PC2', stages: STAGES });
      const created = await board.createCard({
        title: 'Legacy card',
        ownerUserId: 'usr_a',
        spec: { due: '2026-10-05', description: 'kept' },
      });
      if (!created.ok) throw new Error(created.message);
      // Simulate the pre-migration world: the column is cleared, the blob keeps the value.
      await board.__testResetDueToSpec(created.value.id);

      await board.backfillDueDates();

      const card = (await board.getState()).cards[0]!;
      expect(card.dueAt).toBe('2026-10-05');
      expect((card.spec as Record<string, unknown>).due).toBeUndefined();
      expect((card.spec as Record<string, unknown>).description).toBe('kept');
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/api && pnpm vitest run test/card-planning-columns.test.ts`
Expected: FAIL — `labels`/`dueAt`/`archivedAt` are `undefined`, and `backfillDueDates` does not exist.

- [ ] **Step 3: Add the columns, the view fields and the mapper entries**

Beside the existing guarded ALTERs in `board-do.ts` (after the `queued_grant` block, ~`:948`):

```ts
    /** Applied label ids (D1 catalogue, migration 0010). JSON array; ids, not names. */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      // column already exists
    }
    /**
     * A due date, promoted out of `spec.due`.
     *
     * A date, not a timestamp — that is what the UI has always written, and inventing a time of
     * day would make every existing value wrong by up to a day.
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN due_at TEXT`);
    } catch {
      // column already exists
    }
    /**
     * When the owner was last told this card is overdue. Internal to the sweep and deliberately
     * absent from `CardView`: a five-minute cron tick with nothing to remember would notify on
     * every tick forever.
     */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN overdue_notified_at TEXT`);
    } catch {
      // column already exists
    }
    /** Archived cards stay on the board's record and leave its working set. */
    try {
      this.sql.exec(`ALTER TABLE cards ADD COLUMN archived_at TEXT`);
    } catch {
      // column already exists
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_cards_due_at ON cards(due_at)`);
```

The accumulator locals in `updateCard` are `sets` and **`vals`** (`board-do.ts:1220-1221`) — not `params`. Every task below that extends `updateCard` uses `vals`.

Add to `CardView`:

```ts
  /** Applied label ids; the catalogue lives in D1 (`src/db/labels.ts`). */
  labels: string[];
  /** ISO date (no time), or null. */
  dueAt: string | null;
  archivedAt: string | null;
```

Add to `rowToCard`'s returned object:

```ts
      labels: row.labels ? (JSON.parse(row.labels as string) as string[]) : [],
      dueAt: (row.due_at as string | null) ?? null,
      archivedAt: (row.archived_at as string | null) ?? null,
```

- [ ] **Step 4: Write the backfill, in TypeScript rather than SQL**

Also in `board-do.ts`. Done in TS on purpose: it does not assume the JSON1 extension is present in the DO's SQLite build, and it is a handful of rows per board.

```ts
  /**
   * Move `spec.due` onto the `due_at` column, once per board.
   *
   * Idempotent, and it *removes* the key from the spec rather than leaving a copy: two sources of
   * truth for one date is the condition this column exists to end. See the spec's §3.3 note — this
   * also takes the due date out of the agent prompt, which is intended, not a regression.
   */
  async backfillDueDates(): Promise<{ migrated: number }> {
    const rows = this.sql.exec(`SELECT id, spec_json FROM cards WHERE due_at IS NULL`).toArray();
    let migrated = 0;
    for (const row of rows) {
      let spec: Record<string, unknown>;
      try {
        spec = JSON.parse(row.spec_json as string) as Record<string, unknown>;
      } catch {
        continue; // an unparseable spec is not this migration's problem to fix
      }
      const due = spec.due;
      if (typeof due !== 'string' || due.trim() === '') continue;
      delete spec.due;
      this.sql.exec(
        `UPDATE cards SET due_at = ?, spec_json = ?, updated_at = ? WHERE id = ?`,
        due.trim(),
        JSON.stringify(spec),
        new Date().toISOString(),
        row.id as string,
      );
      migrated += 1;
    }
    return { migrated };
  }

  /** Test-only: put a due date back in the spec and clear the column, to rehearse the migration. */
  async __testResetDueToSpec(cardId: string): Promise<void> {
    const row = this.sql.exec(`SELECT spec_json, due_at FROM cards WHERE id = ?`, cardId).one();
    const spec = JSON.parse(row.spec_json as string) as Record<string, unknown>;
    if (row.due_at) spec.due = row.due_at as string;
    this.sql.exec(`UPDATE cards SET due_at = NULL, spec_json = ? WHERE id = ?`, JSON.stringify(spec), cardId);
  }
```

- [ ] **Step 5: Run the test**

Run: `cd apps/api && pnpm vitest run test/card-planning-columns.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole api suite**

Run: `cd apps/api && pnpm test`
Expected: PASS. A test asserting an exact `CardView` object shape will now fail — add the three fields to its expectation; do not weaken the assertion to `objectContaining`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/board/board-do.ts apps/api/test/card-planning-columns.test.ts
git commit -m "feat(board): labels, due_at, archived_at columns with a spec.due backfill"
```

---

## Task 4: Labels, end to end

One task because one deliverable: a label can be created, applied, filtered and deleted. Splitting the catalogue from its use would leave a table nothing writes.

**Files:**
- Create: `apps/api/migrations/0010_labels.sql`, `apps/api/src/db/labels.ts`
- Modify: `apps/api/src/index.ts` (routes), `apps/api/src/board/board-do.ts` (`updateCard` accepts `labels`)
- Test: `apps/api/test/labels.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export interface LabelRecord { id: string; tenantId: string; name: string; colour: string; createdAt: string }
  export async function listLabels(db: D1Database, tenantId: string): Promise<LabelRecord[]>
  export async function createLabel(db: D1Database, tenantId: string, input: { name: string; colour: string }): Promise<LabelRecord>
  export async function updateLabel(db: D1Database, tenantId: string, id: string, patch: { name?: string; colour?: string }): Promise<LabelRecord | null>
  export async function deleteLabel(db: D1Database, tenantId: string, id: string): Promise<boolean>
  export async function unknownLabelIds(db: D1Database, tenantId: string, ids: string[]): Promise<string[]>
  ```
- Consumes: `newId` from `../ids`; `CardView.labels` from Task 3.

- [ ] **Step 1: Write the migration**

`apps/api/migrations/0010_labels.sql`:

```sql
-- Labels: the one Card field that docs/01 has declared since the beginning and no table stored.
--
-- `packages/contract/src/entities.ts` has carried `labels: z.array(z.string()).default([])` for as
-- long as the Card schema has existed, and there were zero occurrences of `labels` in the Board DO.
-- docs/01 flags it, so this closes a documented gap rather than fixing a surprise.
--
-- The catalogue is tenant-scoped and lives here, not in a board's Durable Object, because a label
-- that means one thing on the Press board and another on Releases is not a label. Cards store
-- applied label IDS (not names) so renaming a label cannot orphan a card.
CREATE TABLE labels (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  -- A CSS colour token or hex. Not constrained: the UI owns its palette, and a CHECK here would
  -- be a migration every time the palette gains a shade.
  colour     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- One spelling per workspace, for the same reason `capabilities` has it (migration 0006): it is
  -- what makes a label impossible to misspell into existence twice.
  UNIQUE (tenant_id, name)
);
CREATE INDEX idx_labels_tenant ON labels(tenant_id);
```

- [ ] **Step 2: Write the failing test**

```ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { createLabel, listLabels, deleteLabel, unknownLabelIds } from '../src/db/labels';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_lbl', 'labels', 'Labels')`).run();
});

describe('label catalogue', () => {
  it('refuses a second label with the same name in one tenant', async () => {
    await createLabel(env.DB, 'tnt_lbl', { name: 'urgent', colour: '#f00' });
    await expect(createLabel(env.DB, 'tnt_lbl', { name: 'urgent', colour: '#0f0' })).rejects.toThrow();
  });

  it('is tenant-scoped', async () => {
    await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_other', 'other', 'Other')`).run();
    await createLabel(env.DB, 'tnt_other', { name: 'urgent', colour: '#00f' });
    const mine = await listLabels(env.DB, 'tnt_lbl');
    expect(mine.filter((l) => l.name === 'urgent')).toHaveLength(1);
  });

  it('reports unknown ids, so a card cannot carry a label that does not exist', async () => {
    const live = await createLabel(env.DB, 'tnt_lbl', { name: 'chore', colour: '#888' });
    expect(await unknownLabelIds(env.DB, 'tnt_lbl', [live.id, 'lbl_deadbeefdeadbeef'])).toEqual([
      'lbl_deadbeefdeadbeef',
    ]);
  });
});

describe('applying labels to a card', () => {
  it('stores ids and reads them back', async () => {
    const label = await createLabel(env.DB, 'tnt_lbl', { name: 'blog', colour: '#ff0' });
    await runInDurableObject(stubFor('lbl-apply'), async (board: BoardDO) => {
      await board.init({ id: 'brd_lbl', tenantId: 'tnt_lbl', name: 'L', stages: STAGES });
      const created = await board.createCard({ title: 'Post', ownerUserId: 'usr_a' });
      if (!created.ok) throw new Error(created.message);
      const updated = await board.updateCard(created.value.id, { labels: [label.id] });
      if (!updated.ok) throw new Error(updated.message);
      expect(updated.value.labels).toEqual([label.id]);
    });
  });

  it('ignores an id whose label was deleted, rather than failing to render the card', async () => {
    const doomed = await createLabel(env.DB, 'tnt_lbl', { name: 'temporary', colour: '#ccc' });
    await runInDurableObject(stubFor('lbl-stale'), async (board: BoardDO) => {
      await board.init({ id: 'brd_lbl2', tenantId: 'tnt_lbl', name: 'L2', stages: STAGES });
      const created = await board.createCard({ title: 'Post', ownerUserId: 'usr_a' });
      if (!created.ok) throw new Error(created.message);
      await board.updateCard(created.value.id, { labels: [doomed.id] });
      expect(await deleteLabel(env.DB, 'tnt_lbl', doomed.id)).toBe(true);
      // The card still reads: a stale id is a cosmetic condition, not a broken card.
      const card = (await board.getState()).cards[0]!;
      expect(card.labels).toEqual([doomed.id]);
    });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd apps/api && pnpm vitest run test/labels.test.ts`
Expected: FAIL — `../src/db/labels` does not resolve.

- [ ] **Step 4: Write `apps/api/src/db/labels.ts`**

Follow `capabilities.ts` exactly: hand-written SQL with `tenant_id = ?` as the first predicate, always (Principle 8).

```ts
/**
 * The label catalogue (migration 0010).
 *
 * `Card.labels` has been in the contract since the Card schema existed and in `docs/01`'s entity
 * list just as long, with no column and no table behind it. This is the table.
 *
 * Applied labels are stored on the card as **ids**, in the board's Durable Object. Ids rather than
 * names so that renaming a label does not orphan every card carrying it, and in the DO rather than
 * here because a card's own fields belong with the card.
 */
import { newId } from '../ids';

const COLUMNS = 'id, tenant_id AS tenantId, name, colour, created_at AS createdAt';

export interface LabelRecord {
  id: string;
  tenantId: string;
  name: string;
  colour: string;
  createdAt: string;
}

export async function listLabels(db: D1Database, tenantId: string): Promise<LabelRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM labels WHERE tenant_id = ? ORDER BY name ASC`)
    .bind(tenantId)
    .all<LabelRecord>();
  return results ?? [];
}

export async function createLabel(
  db: D1Database,
  tenantId: string,
  input: { name: string; colour: string },
): Promise<LabelRecord> {
  const name = input.name.trim();
  if (name === '') throw new Error('a label needs a name');
  const id = newId('lbl');
  await db
    .prepare(`INSERT INTO labels (id, tenant_id, name, colour) VALUES (?, ?, ?, ?)`)
    .bind(id, tenantId, name, input.colour)
    .run();
  const row = await labelById(db, tenantId, id);
  if (!row) throw new Error('label vanished immediately after insert');
  return row;
}

export async function labelById(db: D1Database, tenantId: string, id: string): Promise<LabelRecord | null> {
  return (
    (await db
      .prepare(`SELECT ${COLUMNS} FROM labels WHERE tenant_id = ? AND id = ?`)
      .bind(tenantId, id)
      .first<LabelRecord>()) ?? null
  );
}

export async function updateLabel(
  db: D1Database,
  tenantId: string,
  id: string,
  patch: { name?: string; colour?: string },
): Promise<LabelRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === '') throw new Error('a label needs a name');
    sets.push('name = ?');
    params.push(name);
  }
  if (patch.colour !== undefined) {
    sets.push('colour = ?');
    params.push(patch.colour);
  }
  if (sets.length === 0) return labelById(db, tenantId, id);
  await db
    .prepare(`UPDATE labels SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`)
    .bind(...params, tenantId, id)
    .run();
  return labelById(db, tenantId, id);
}

/**
 * Deletion is permissive: cards may keep a dead id.
 *
 * Refusing to delete a label in use would mean a fan-out read across every board's Durable Object
 * to answer "is it in use?" — a great deal of machinery to prevent a stale chip. Readers ignore
 * unknown ids instead.
 */
export async function deleteLabel(db: D1Database, tenantId: string, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM labels WHERE tenant_id = ? AND id = ?`).bind(tenantId, id).run();
  return (res.meta.changes ?? 0) > 0;
}

/** Which of these ids do not exist in this tenant — so a card write can be refused before it lands. */
export async function unknownLabelIds(db: D1Database, tenantId: string, ids: string[]): Promise<string[]> {
  const wanted = [...new Set(ids)].filter((id) => id.trim() !== '');
  if (wanted.length === 0) return [];
  const placeholders = wanted.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT id FROM labels WHERE tenant_id = ? AND id IN (${placeholders})`)
    .bind(tenantId, ...wanted)
    .all<{ id: string }>();
  const live = new Set((results ?? []).map((r) => r.id));
  return wanted.filter((id) => !live.has(id));
}
```

- [ ] **Step 5: Accept `labels` in `updateCard`**

In `board-do.ts`, extend `updateCard`'s patch type with `labels?: string[]` and persist it:

```ts
    if (patch.labels !== undefined) {
      sets.push('labels = ?');
      vals.push(JSON.stringify([...new Set(patch.labels)]));
    }
```

The DO does **not** validate the ids — it cannot reach D1 usefully on a hot path, and the route above it can. Validation belongs in Step 6.

- [ ] **Step 6: Add the routes**

In `apps/api/src/index.ts`, beside the existing `/v1/capabilities` routes:

- `GET /v1/labels` → `listLabels(env.DB, tenantId)`
- `POST /v1/labels` `{ name, colour }` → `createLabel`, 201
- `PATCH /v1/labels/:id` `{ name?, colour? }` → `updateLabel`, 404 when null
- `DELETE /v1/labels/:id` → `deleteLabel`, 204, or 404

And in the existing `PATCH /v1/boards/:id/cards/:cardId` handler, before calling the DO:

```ts
      if (body.labels !== undefined) {
        // The type guard is not decoration. Without it, `labels: "urgent"` skips this whole check
        // and reaches `[...new Set(patch.labels)]` in the DO, where a string is iterable and spreads
        // into ['u','r','g','e','n','t'] — written to storage, no error raised. A plain object
        // throws an unhandled TypeError inside the DO instead. Neither answers 400.
        if (!Array.isArray(body.labels) || body.labels.some((l) => typeof l !== 'string')) {
          return Response.json(
            { error: { code: 'INVALID_LABELS', message: 'labels must be an array of label ids' } },
            { status: 400 },
          );
        }
        const unknown = await unknownLabelIds(env.DB, tenantId, body.labels as string[]);
        if (unknown.length > 0) {
          return Response.json(
            { error: { code: 'UNKNOWN_LABEL', message: `no such label in this workspace: ${unknown.join(', ')}` } },
            { status: 400 },
          );
        }
      }
```

> **Any route that forwards a client value into the DO needs this shape**, not just this one. The DO
> trusts its callers by design — it cannot reach D1 to validate on a hot path — so the route is the
> only place a malformed payload is stopped. Later tasks adding `projectId`, `milestoneId` and link
> ids to a PATCH body carry the same obligation.

- [ ] **Step 6b: Teach the test catalog about migration 0010 — without this, nothing passes**

The test D1 does **not** get migrations applied by wrangler. `apps/api/test/setup.ts` runs
`setupCatalog()` (`test/helpers/catalog.ts`) in a `beforeAll` for every test file, and that helper
builds the schema itself. A new table is invisible to the suite until it is added there, and the
failure is `no such table: labels` in every single labels test.

Follow the file's existing shape exactly — import the real migration `?raw` and guard it with the
`tableExists` helper that is already defined (`catalog.ts:61`):

```ts
import labels from '../../migrations/0010_labels.sql?raw';
```

and inside `setupCatalog()`, beside the other guarded migration blocks:

```ts
  if (!(await tableExists('labels'))) {
    for (const s of statementsOf(labels)) await env.DB.prepare(s).run();
  }
```

**Run the real migration file, do not mirror it into `STATEMENTS`.** The helper's own comment says
why: a hand-copied mirror is how its schema drifted from `0001_catalog.sql` in the first place, and
running the real file keeps the `UNIQUE (tenant_id, name)` constraint byte-identical to what ships.

⚠️ **One consequence to know about.** Every table the helper mirrors deliberately **omits**
`REFERENCES tenants(id)`, because the suite drives the API with dev-header tenants that have no row
in `tenants` — a faithful FK there "would fail every request rather than test anything"
(`catalog.ts:16-20`). Migration 0010 *does* carry that FK, and running the real file keeps it. That
is fine for this task because its tests insert real `tenants` rows first. But **a test that reaches
labels through the Worker with a dev-header tenant will fail on the foreign key**, and the fix is to
insert a `tenants` row in that test — not to strip the FK from the migration.

- [ ] **Step 7: Run the tests**

Run: `cd apps/api && pnpm vitest run test/labels.test.ts` then `pnpm test`
Expected: PASS. Note the suite builds its own D1 schema via `setupCatalog` (Step 6b) — you do
**not** need `pnpm db:migrate:local` for tests. That command is for a local `wrangler dev` session.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/0010_labels.sql apps/api/src/db/labels.ts apps/api/src/index.ts apps/api/src/board/board-do.ts apps/api/test/labels.test.ts apps/api/test/helpers/catalog.ts
git commit -m "feat(labels): a tenant label catalogue, applied to cards by id"
```

---

## Task 5: Give the due date teeth

A due date that changes nothing is worse than no due date — it looks like a commitment and is not one. Three consequences, and the first is the riskiest change in the plan.

**Files:**
- Modify: `apps/api/src/board/board-do.ts` — the claim query (`:2218-2224`), the all-cards read (`:3235`), a new `sweepBoard`
- Modify: `apps/api/src/index.ts` — `scheduled()` (`:1598`)
- Test: `apps/api/test/due-dates.test.ts` (create)

**Interfaces:**
- Produces: `sweepBoard(nowIso: string): Promise<{ overdueNotified: number; schedulesFired: number }>` — Phase 2 fills in `schedulesFired`, which is why it is in the return type now rather than being added later.

- [ ] **Step 1: Write the failing test**

Note the last case: it pins the claim query and the discovery count together, which is the whole
reason Step 4 extracts a shared predicate.

```ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit, type CardView } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

// `ClaimResult` is `{ claimed: true; runId; leaseEpoch; card: CardView; stage; handoff } | { claimed: false }`
// — the claimed card is `claim.card.id`. There is no `claim.cardId`.
async function make(board: BoardDO, title: string, patch: { priority?: number; dueAt?: string }): Promise<CardView> {
  const r = await board.createCard({ title, ownerUserId: 'usr_a', priority: patch.priority ?? 0 });
  if (!r.ok) throw new Error(r.message);
  if (patch.dueAt) {
    const u = await board.updateCard(r.value.id, { dueAt: patch.dueAt });
    if (!u.ok) throw new Error(u.message);
    return u.value;
  }
  return r.value;
}

describe('due dates in claim order', () => {
  it('prefers the sooner due date at equal priority', async () => {
    await runInDurableObject(stubFor('due-order'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due', tenantId: 'tnt_a', name: 'D', stages: STAGES });
      const later = await make(board, 'Later', { dueAt: '2026-12-01' });
      const sooner = await make(board, 'Sooner', { dueAt: '2026-10-01' });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(sooner.id);
      expect(claim.card.id).not.toBe(later.id);
    });
  });

  it('never lets a due date outrank priority', async () => {
    await runInDurableObject(stubFor('due-vs-pri'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due2', tenantId: 'tnt_a', name: 'D2', stages: STAGES });
      await make(board, 'Due tomorrow, low priority', { priority: 0, dueAt: '2026-10-01' });
      const urgent = await make(board, 'No due date, high priority', { priority: 5 });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(urgent.id);
    });
  });

  it('puts undated cards last, not first', async () => {
    await runInDurableObject(stubFor('due-nulls'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due3', tenantId: 'tnt_a', name: 'D3', stages: STAGES });
      await make(board, 'Undated', {});
      const dated = await make(board, 'Dated', { dueAt: '2027-01-01' });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(dated.id);
    });
  });

  it('does not hand out an archived card', async () => {
    await runInDurableObject(stubFor('due-archived'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due4', tenantId: 'tnt_a', name: 'D4', stages: STAGES });
      const card = await make(board, 'Archived', {});
      await board.updateCard(card.id, { archivedAt: '2026-09-30T00:00:00.000Z' });
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(false);
    });
  });

  it('does not ADVERTISE an archived card either — discovery and claim must agree', async () => {
    await runInDurableObject(stubFor('due-archived-count'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due4b', tenantId: 'tnt_a', name: 'D4b', stages: STAGES });
      const card = await make(board, 'Archived', {});
      expect(await board.countReadyForCapabilities('agt_w', ['writing'])).toBe(1);

      await board.updateCard(card.id, { archivedAt: '2026-09-30T00:00:00.000Z' });

      // `countReadyForCapabilities` is what `superpipeline_list_work` reports as `readyForYou`.
      // If it still says 1 while claim says nothing is claimable, an agent polls, sees work, claims
      // nothing, and polls again — forever.
      expect(await board.countReadyForCapabilities('agt_w', ['writing'])).toBe(0);
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(false);
    });
  });
});

describe('overdue notification', () => {
  it('notifies the owner once, not once per tick', async () => {
    await runInDurableObject(stubFor('due-notify'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due5', tenantId: 'tnt_a', name: 'D5', stages: STAGES });
      await make(board, 'Overdue', { dueAt: '2026-09-01' });

      const first = await board.sweepBoard('2026-09-30T10:00:00.000Z');
      expect(first.overdueNotified).toBe(1);

      const second = await board.sweepBoard('2026-09-30T10:05:00.000Z');
      expect(second.overdueNotified).toBe(0);

      const notes = (await board.getNotifications()).filter((n) => n.kind === 'overdue');
      expect(notes).toHaveLength(1);
    });
  });

  it('says nothing about a card that is not yet due', async () => {
    await runInDurableObject(stubFor('due-future'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due6', tenantId: 'tnt_a', name: 'D6', stages: STAGES });
      await make(board, 'Future', { dueAt: '2027-01-01' });
      expect((await board.sweepBoard('2026-09-30T10:00:00.000Z')).overdueNotified).toBe(0);
    });
  });

  it('says nothing about an overdue card that is already finished', async () => {
    await runInDurableObject(stubFor('due-done'), async (board: BoardDO) => {
      await board.init({ id: 'brd_due7', tenantId: 'tnt_a', name: 'D7', stages: STAGES });
      const card = await make(board, 'Done but late', { dueAt: '2026-09-01' });
      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected a claim');
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'late but done' } });
      expect(card.id).toBeDefined();
      expect((await board.sweepBoard('2026-09-30T10:00:00.000Z')).overdueNotified).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/api && pnpm vitest run test/due-dates.test.ts`
Expected: FAIL — `updateCard` rejects `dueAt`/`archivedAt`, and `sweepBoard` does not exist.

- [ ] **Step 3: Accept `dueAt` and `archivedAt` in `updateCard`**

```ts
    if (patch.dueAt !== undefined) {
      sets.push('due_at = ?');
      vals.push(patch.dueAt === null ? null : patch.dueAt.trim());
      // A changed date is a new chance to be told about it. No placeholder, so no `vals` entry.
      sets.push('overdue_notified_at = NULL');
    }
    if (patch.archivedAt !== undefined) {
      sets.push('archived_at = ?');
      vals.push(patch.archivedAt);
    }
```

- [ ] **Step 4: Express card eligibility ONCE, then use it in all three places**

⚠️ **Locate these by content, not by the line numbers in this plan.** Task 3 added ~82 lines to
`board-do.ts`, so every line reference here is stale. Search for the quoted SQL instead.

There are **two** independent queries asking "which cards may be handed out", not one:

| where | what it does | find it by |
|---|---|---|
| `claim` | picks the single next card | `SELECT * FROM cards WHERE state = 'submitted'` |
| `countReadyForCapabilities` | counts them for **work discovery** — this is `list_work`'s `readyForYou` | `SELECT COUNT(*) AS n FROM cards WHERE state = 'submitted'` |

**They must never disagree.** The moment `claim` grows a condition the count does not, `list_work`
advertises work `claim_card` then refuses: an agent polls, reads `readyForYou: 3`, claims, gets
`{claimed:false}`, and polls again forever. It looks like a broken agent and it is a broken query.

So extract the predicate rather than editing two copies. Add beside them:

```ts
  /**
   * The WHERE fragment deciding whether a card may be handed out, shared by the claim query and the
   * work-discovery count so the two cannot drift apart.
   *
   * They were independent copies of `state = 'submitted' AND current_stage_key IN (…)`. Every
   * condition added to claim from here on — archived here, blocked and parent-with-open-children in
   * Task 13 — has to be invisible to `list_work` as well, or the board advertises work it will not
   * hand out. The table is aliased `c` in both callers so this fragment can qualify its columns.
   */
  private claimableWhere(placeholders: string): string {
    return `c.state = 'submitted' AND c.archived_at IS NULL AND c.current_stage_key IN (${placeholders})`;
  }
```

Then the claim query becomes — note `(c.due_at IS NULL)` rather than `NULLS LAST`:

```ts
        `SELECT * FROM cards c WHERE ${this.claimableWhere(placeholders)}
         ORDER BY c.priority DESC, (c.due_at IS NULL), c.due_at ASC, c.created_at ASC LIMIT 1`,
```

and the count becomes:

```ts
        `SELECT COUNT(*) AS n FROM cards c WHERE ${this.claimableWhere(placeholders)}`,
```

And separately, the all-cards read (find it by `SELECT * FROM cards ORDER BY priority`) gains the
same ordering, but **not** the eligibility predicate — it lists every card, including archived ones,
because the UI filters archived on its own side:

```ts
      .exec(`SELECT * FROM cards ORDER BY priority DESC, (due_at IS NULL), due_at ASC, created_at ASC`)
```

> ⚠️ **This is a live behaviour change.** It alters which card the Press board's agents claim next. It is the smallest diff in this plan and its largest risk. Task 7's live check exists for this.

- [ ] **Step 5: Write `sweepBoard`**

```ts
  /**
   * The per-board cron arm, called from the Worker's `scheduled()` every five minutes.
   *
   * It is here rather than on the DO alarm deliberately: a Durable Object has exactly one alarm and
   * this one already serves two jobs (lease reclaim and push drain — see `scheduleReclaim`). The
   * Worker cron already iterates every board, so this costs no new infrastructure.
   *
   * `schedulesFired` is always 0 until Phase 2 fills it in; it is in the shape now so the caller
   * does not change twice.
   */
  async sweepBoard(nowIso: string): Promise<{ overdueNotified: number; schedulesFired: number }> {
    const today = nowIso.slice(0, 10); // the column is a date, so compare dates
    const rows = this.sql
      .exec(
        `SELECT id, title, due_at FROM cards
          WHERE due_at IS NOT NULL AND due_at < ?
            AND archived_at IS NULL
            AND overdue_notified_at IS NULL
            AND state NOT IN ('completed', 'canceled', 'rejected', 'failed')`,
        today,
      )
      .toArray();

    for (const row of rows) {
      this.notify('overdue', row.id as string, `"${row.title as string}" was due ${row.due_at as string}`);
      this.sql.exec(`UPDATE cards SET overdue_notified_at = ? WHERE id = ?`, nowIso, row.id as string);
    }

    return { overdueNotified: rows.length, schedulesFired: 0 };
  }
```

Note the state exclusion lists all four terminal states by name. It is **not** `isTerminal()` and it is not the blocker-resolution rule from Task 9 — an overdue card that `failed` needs no nag, whereas a *blocker* that failed still blocks. The two rules are different on purpose; do not unify them.

- [ ] **Step 6: Run the test**

Run: `cd apps/api && pnpm vitest run test/due-dates.test.ts`
Expected: PASS.

- [ ] **Step 7: Wire the sweep into the cron**

In `apps/api/src/index.ts`, inside `scheduled()`'s existing per-board loop (`:1601-1607`), beside `dispatchPushDeliveries()`:

```ts
          try {
            await boardStub(env, board.tenantId, board.id).sweepBoard(new Date().toISOString());
          } catch {
            /* one board's failure is not the sweep's */
          }
```

Keep it in its **own** try/catch. Sharing one with the push dispatch would mean a failing sweep silently stopped push delivery for that board.

- [ ] **Step 8: Run the whole suite and commit**

Run: `cd apps/api && pnpm test`

```bash
git add apps/api/src/board/board-do.ts apps/api/src/index.ts apps/api/test/due-dates.test.ts
git commit -m "feat(due dates): claim order, an overdue notification, and a per-board cron sweep"
```

---

## Task 6: Make the due date real, end to end

Two gaps found after Task 5, which together mean due dates would pass every test and do nothing in
production. Both are fixed here because "a due date set in the UI actually works" is one deliverable.

- **`backfillDueDates` has no production caller.** Task 3 wrote it; only a test calls it. Every card
  created before this work keeps its date in `spec.due` where nothing reads it.
- **`ComposeSheet` still writes `spec.due`** (`app.svelte.ts:370`). So every *new* card would get a
  due date in the blob that claim ordering, the sweep and the tile all ignore.

- [ ] **Step 0a: Give the backfill a caller — once per board, not per tick**

In `sweepBoard`, before the overdue scan, guarded by a `meta` flag so it runs once ever per board:

```ts
    // The backfill is a migration, not a sweep job. Guarded by a meta flag because its query
    // (`WHERE due_at IS NULL`) matches every card that never had a due date — i.e. most of them,
    // forever — so running it on each five-minute tick would be a full table scan for nothing.
    if (!this.getMeta('dueBackfillDone')) {
      const { migrated } = await this.backfillDueDates();
      this.setMeta('dueBackfillDone', '1');
      if (migrated > 0) this.emit('cards.due_backfilled', { migrated });
    }
```

Check the exact `getMeta`/`setMeta` signatures in the file before using them; if `setMeta` does not
exist, follow however `boardId` is persisted in `meta`. Off the request path and once per board is
the shape that matters — do not call it from the DO constructor.

Test it: a board with a card carrying `spec.due` gets it migrated by the first `sweepBoard`, a second
`sweepBoard` migrates nothing, and the flag survives.

- [ ] **Step 0b: Let `createCard` accept a due date**

`createCard` does not accept `dueAt`, so the compose form would have to create-then-patch — two round
trips, and a failure between them leaves a card whose due date silently vanished. Add `dueAt?: string`
to `createCard`'s input and its INSERT, validated at the route with the **same** `^\d{4}-\d{2}-\d{2}$`
rule Task 5 added to the card PATCH. Reuse that validator rather than writing a second one.

## Task 6 (continued): Phase 1 in the UI

**Files:**
- Modify: `apps/web/src/lib/api.ts` — `Card` gains `labels`, `dueAt`, `archivedAt`; add `listLabels`/`createLabel`/`updateLabel`/`deleteLabel`
- Modify: `apps/web/src/lib/components/board/CardTile.svelte` — read `card.dueAt`, render label chips
- Modify: `apps/web/src/lib/components/CardDrawer.svelte` — edit labels; due date reads/writes `dueAt`
- Modify: `apps/web/src/lib/components/shell/ComposeSheet.svelte` — send `dueAt`, not `spec.due`
- Modify: `apps/web/src/lib/stores/app.svelte.ts` — `labels` and `showArchived` filters
- Modify: `apps/web/src/lib/components/plan/FilterBar.svelte`, `plan/ListView.svelte`
- Test: `apps/web/src/lib/components/board/CardTile.test.ts` (extend or create)

**Interfaces:**
- Consumes: `CardView.labels` / `.dueAt` / `.archivedAt` (Task 3); `/v1/labels` (Task 4).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { overdue } from './card-due';

describe('overdue', () => {
  it('is true for a past date on an unfinished card', () => {
    expect(overdue('2026-09-01', 'working', '2026-09-30')).toBe(true);
  });
  it('is false once the card is completed, however late', () => {
    expect(overdue('2026-09-01', 'completed', '2026-09-30')).toBe(false);
  });
  it('is false on the due date itself — a card is due at end of day', () => {
    expect(overdue('2026-09-30', 'working', '2026-09-30')).toBe(false);
  });
  it('is false with no due date', () => {
    expect(overdue(null, 'working', '2026-09-30')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && pnpm vitest run src/lib/components/board/CardTile.test.ts`
Expected: FAIL — `./card-due` does not exist.

- [ ] **Step 3: Extract the predicate, then use it**

`CardTile.svelte:105-109` computes overdue inline against `spec.due`, which is why it cannot be tested. Extract it to `apps/web/src/lib/components/board/card-due.ts`:

```ts
/**
 * A card is overdue the day AFTER its due date, and never once it is finished.
 *
 * Extracted from CardTile so it can be tested: it used to be an inline `$derived` comparing a
 * `spec.due` blob value against `Date.now()`, which no test could reach and no test covered.
 *
 * `today` is a parameter rather than read from the clock — the same reason the DO's sweep takes
 * `nowIso`. A test that cannot choose the date can only assert against whatever day it runs on.
 */
export function overdue(dueAt: string | null, state: string, today: string): boolean {
  if (!dueAt) return false;
  if (state === 'completed' || state === 'canceled' || state === 'rejected' || state === 'failed') return false;
  return dueAt < today;
}
```

Then in `CardTile.svelte` replace the inline block with:

```svelte
  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = $derived(overdue(card.dueAt, card.state, today));
```

and render `card.dueAt` where it rendered `due`. Delete the `spec?.due` read entirely — the field is gone from `spec` after Task 3's backfill, and leaving the fallback would hide a regression.

- [ ] **Step 3b: Stop writing `spec.due`**

`app.svelte.ts:365-372` puts the date into `spec.due`. Change `dispatchCard` to send `dueAt` as a
first-class field via Step 0b's widened `createCard`, and **delete** the `spec.due` write. Leaving
both would recreate the two-sources-of-truth problem this column exists to end.

- [ ] **Step 4: Label chips on the tile**

`app.svelte.ts` fetches the tenant's labels once and exposes `labelById: Map<string, {name, colour}>`. `CardTile` renders at most three chips plus "+N"; a tile is scanned, not read. Unknown ids render nothing (Task 4, Step 4's permissive deletion).

- [ ] **Step 5: Filters**

In `app.svelte.ts`, extend the filter object with `labels: string[]` (a card matches if it carries **all** selected — narrowing is what a filter is for) and `showArchived: boolean` defaulting `false`. Add to the existing predicate beside `f.minPriority` (`:142`):

```ts
      if (!f.showArchived && c.archivedAt !== null) return false;
      if (f.labels.length > 0 && !f.labels.every((l) => c.labels.includes(l))) return false;
```

Add `'due'` to `ListGroupBy`? **No** — grouping by a date makes one group per day. `ListView` already sorts by `due` (`:19`); point that sort at `dueAt`.

- [ ] **Step 6: Run the web suite**

Run: `cd apps/web && pnpm check && pnpm test`
Expected: PASS. `pnpm check` runs `svelte-kit sync` first; a missing generated type is that, not your change.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): label chips, a filter, and the due date read off its own column"
```

---

## Task 7: `supi` verbs, and the Phase 1 live check

**Files:**
- Modify: `packages/cli/src/index.ts` (verb table ~`:299-494`), `packages/cli/src/verbs.test.ts`
- Test: `packages/cli/src/verbs.test.ts`

**Interfaces:**
- Produces: `supi label list|add|rm`, and `--due` / `--label` / `--priority` on `supi create-card`.

- [ ] **Step 1: Add the verbs to the table test first**

`verbs.test.ts` asserts the registered verb list. Add `label` to the expectation and watch it fail:

Run: `cd packages/cli && pnpm vitest run src/verbs.test.ts`
Expected: FAIL — `label` is not registered.

- [ ] **Step 2: Register the verb**

Follow the shape of the existing `capabilities` verb exactly (`:490`). `supi label list`, `supi label add <name> <colour>`, `supi label rm <id>`, hitting the Task 4 routes.

- [ ] **Step 3: Extend `create-card`**

Add `--due YYYY-MM-DD`, `--label <id>` (repeatable) and confirm `--priority` already exists. Reject a malformed `--due` in the CLI rather than sending it: a 400 from the API is a worse error message than the one we can write here.

- [ ] **Step 4: Run and commit**

Run: `cd packages/cli && pnpm test`

```bash
git add packages/cli/src
git commit -m "feat(supi): label verbs, and --due/--label on create-card"
```

- [ ] **Step 5: Open the Phase 1 PR**

```bash
git push -u origin feat/planning-phase1-labels-and-dates
gh pr create --title "feat: labels, due dates, and the contract drift they closed" --body "<see plan>"
```

- [ ] **Step 6: THE LIVE CHECK — do not skip this**

Unit tests post to a board that accepts everything; bug #625 was invisible to all of them and only a live run found it. After the PR merges and deploys:

1. On the **Press board** (`brd_6a899b0f0d054046`), create two cards at equal priority with different due dates, the sooner one created **second**.
2. Watch which one an agent claims. It must be the sooner-due card — that is the claim-order change working, and the one thing in Phase 1 that alters live agent behaviour.
3. Set a due date in the past on a scratch card and confirm **one** overdue notification arrives, and that a second cron tick five minutes later adds none.
4. Confirm an agent's prompt no longer contains the due date (expected — spec §3.3), and that nothing in the run fails because of it.

Record the result in the PR. **If the claim order did not change, stop** — the query edit did not reach production and everything downstream assumes it did.

---

# Phase 2 — recurrence

Branch: `feat/planning-phase2-recurrence`

**Depends on Task 1's answer.** If `workerd` has no IANA zone data, replace `timezone: string` with `utcOffsetMinutes: number` throughout this phase and say so in the PR.

## Task 8: The recurrence rule — a pure module

Restricted grammar, not cron. A cron parser is a dependency and a surface; these four forms cover maintenance cadence, and the field can hold a cron expression later without a schema change.

**Files:**
- Create: `apps/api/src/board/recurrence.ts`, `apps/api/test/recurrence.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Rule =
    | { kind: 'interval'; every: number; unit: 'minutes' | 'hours' | 'days' }
    | { kind: 'daily'; hour: number; minute: number }
    | { kind: 'weekly'; dow: number; hour: number; minute: number }   // dow 0=Sunday
    | { kind: 'monthly'; day: number; hour: number; minute: number };
  export function parseRule(text: string): { ok: true; rule: Rule } | { ok: false; error: string };
  export function nextFireAt(rule: Rule, timezone: string, afterIso: string): string;
  ```
- Consumes: nothing. No DO, no clock, no I/O — which is why it can be tested exhaustively.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { parseRule, nextFireAt, type Rule } from '../src/board/recurrence';

function mustParse(text: string): Rule {
  const r = parseRule(text);
  if (!r.ok) throw new Error(`expected "${text}" to parse: ${r.error}`);
  return r.rule;
}

describe('parseRule', () => {
  it('reads the four forms', () => {
    expect(mustParse('every 30 minutes')).toEqual({ kind: 'interval', every: 30, unit: 'minutes' });
    expect(mustParse('daily at 09:00')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
    expect(mustParse('weekly on mon at 08:30')).toEqual({ kind: 'weekly', dow: 1, hour: 8, minute: 30 });
    expect(mustParse('monthly on 1 at 00:00')).toEqual({ kind: 'monthly', day: 1, hour: 0, minute: 0 });
  });

  it('is case- and space-insensitive', () => {
    expect(mustParse('  DAILY  AT  09:00 ')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
  });

  it('refuses an interval below the cron tick, because it cannot be honoured', () => {
    const r = parseRule('every 2 minutes');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('5');
  });

  it('refuses a monthly day above 28, rather than silently skipping February', () => {
    const r = parseRule('monthly on 31 at 09:00');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('28');
  });

  it('refuses nonsense with a message naming the accepted forms', () => {
    const r = parseRule('when I feel like it');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('every');
  });

  it('refuses an impossible clock time', () => {
    expect(parseRule('daily at 25:00').ok).toBe(false);
    expect(parseRule('daily at 09:60').ok).toBe(false);
  });
});

describe('nextFireAt', () => {
  it('advances an interval from the given instant', () => {
    expect(nextFireAt(mustParse('every 30 minutes'), 'UTC', '2026-09-30T10:00:00.000Z')).toBe(
      '2026-09-30T10:30:00.000Z',
    );
  });

  it('finds today’s daily time when it is still ahead', () => {
    expect(nextFireAt(mustParse('daily at 09:00'), 'UTC', '2026-09-30T08:00:00.000Z')).toBe(
      '2026-09-30T09:00:00.000Z',
    );
  });

  it('rolls to tomorrow when the daily time has passed', () => {
    expect(nextFireAt(mustParse('daily at 09:00'), 'UTC', '2026-09-30T09:00:00.000Z')).toBe(
      '2026-10-01T09:00:00.000Z',
    );
  });

  it('resolves a wall-clock time in a named zone, not in UTC', () => {
    // 09:00 in Asia/Kolkata (UTC+5:30) is 03:30Z.
    expect(nextFireAt(mustParse('daily at 09:00'), 'Asia/Kolkata', '2026-09-30T00:00:00.000Z')).toBe(
      '2026-09-30T03:30:00.000Z',
    );
  });

  it('finds the next named weekday', () => {
    // 2026-09-30 is a Wednesday; the next Monday is 2026-10-05.
    expect(nextFireAt(mustParse('weekly on mon at 08:30'), 'UTC', '2026-09-30T12:00:00.000Z')).toBe(
      '2026-10-05T08:30:00.000Z',
    );
  });

  it('rolls a monthly rule into the next month', () => {
    expect(nextFireAt(mustParse('monthly on 1 at 00:00'), 'UTC', '2026-09-30T12:00:00.000Z')).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('is strictly forward: firing never returns the instant it was given', () => {
    const exact = '2026-09-30T09:00:00.000Z';
    expect(nextFireAt(mustParse('daily at 09:00'), 'UTC', exact)).not.toBe(exact);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/api && pnpm vitest run test/recurrence.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `apps/api/src/board/recurrence.ts`**

```ts
/**
 * Recurrence rules for scheduled cards.
 *
 * A restricted grammar rather than cron, deliberately. Cron is a dependency, a parsing surface and
 * a support burden, and "every 15 minutes / daily at 09:00 / weekly on mon / monthly on 1" is the
 * whole of what maintenance cadence needs. The stored field is free text, so a cron expression can
 * be accepted later without touching the schema.
 *
 * Pure: no clock, no I/O, no Durable Object. `nextFireAt` takes the instant to search from, which
 * is what makes every case below testable.
 */

export type Rule =
  | { kind: 'interval'; every: number; unit: 'minutes' | 'hours' | 'days' }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; dow: number; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number };

/** The Worker cron ticks every 5 minutes, so a shorter interval is a promise we cannot keep. */
const MIN_INTERVAL_MINUTES = 5;

const DOW: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const FORMS =
  'accepted forms: "every <n> minutes|hours|days", "daily at HH:MM", ' +
  '"weekly on <mon-sun> at HH:MM", "monthly on <1-28> at HH:MM"';

function clock(h: string, m: string): { hour: number; minute: number } | null {
  const hour = Number(h);
  const minute = Number(m);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function parseRule(text: string): { ok: true; rule: Rule } | { ok: false; error: string } {
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ');

  const interval = s.match(/^every (\d+) (minutes?|hours?|days?)$/);
  if (interval) {
    const every = Number(interval[1]);
    const unit = (interval[2]!.endsWith('s') ? interval[2]! : `${interval[2]!}s`) as
      | 'minutes' | 'hours' | 'days';
    if (every <= 0) return { ok: false, error: 'an interval must be at least 1' };
    const asMinutes = unit === 'minutes' ? every : unit === 'hours' ? every * 60 : every * 1440;
    if (asMinutes < MIN_INTERVAL_MINUTES) {
      return {
        ok: false,
        error: `the shortest interval is ${MIN_INTERVAL_MINUTES} minutes — the sweep runs every ${MIN_INTERVAL_MINUTES} minutes, so anything shorter would not be honoured`,
      };
    }
    return { ok: true, rule: { kind: 'interval', every, unit } };
  }

  const daily = s.match(/^daily at (\d{1,2}):(\d{2})$/);
  if (daily) {
    const t = clock(daily[1]!, daily[2]!);
    if (!t) return { ok: false, error: 'that is not a time of day' };
    return { ok: true, rule: { kind: 'daily', ...t } };
  }

  const weekly = s.match(/^weekly on ([a-z]{3}) at (\d{1,2}):(\d{2})$/);
  if (weekly) {
    const dow = DOW[weekly[1]!];
    if (dow === undefined) return { ok: false, error: `"${weekly[1]}" is not a day — use mon, tue, wed, thu, fri, sat or sun` };
    const t = clock(weekly[2]!, weekly[3]!);
    if (!t) return { ok: false, error: 'that is not a time of day' };
    return { ok: true, rule: { kind: 'weekly', dow, ...t } };
  }

  const monthly = s.match(/^monthly on (\d{1,2}) at (\d{1,2}):(\d{2})$/);
  if (monthly) {
    const day = Number(monthly[1]);
    // 29-31 are refused rather than clamped. Clamping makes "monthly on 31" mean the 28th in
    // February and the 31st elsewhere, which is two different rules wearing one name; skipping
    // makes it silently not fire. Refusing says so at the only moment anyone is listening.
    if (day < 1 || day > 28) {
      return { ok: false, error: 'a monthly day must be between 1 and 28, so it exists in every month' };
    }
    const t = clock(monthly[2]!, monthly[3]!);
    if (!t) return { ok: false, error: 'that is not a time of day' };
    return { ok: true, rule: { kind: 'monthly', day, ...t } };
  }

  return { ok: false, error: `could not read "${text.trim()}" — ${FORMS}` };
}

/** The wall-clock fields of an instant, as seen in a named zone. */
function zonedParts(at: Date, timezone: string): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short',
  }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '0';
  const weekday = (parts.find((p) => p.type === 'weekday')?.value ?? 'Sun').slice(0, 3).toLowerCase();
  return {
    y: Number(get('year')), mo: Number(get('month')), d: Number(get('day')),
    // Intl renders midnight as "24" in some locales; normalise it.
    h: Number(get('hour')) % 24, mi: Number(get('minute')),
    dow: DOW[weekday] ?? 0,
  };
}

/** How far the named zone is from UTC at this instant, in minutes. */
function offsetMinutes(at: Date, timezone: string): number {
  const p = zonedParts(at, timezone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  // Seconds and milliseconds are not in `p`, so compare on the minute.
  return (asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000;
}

/**
 * The instant at which a given wall clock occurs in a zone.
 *
 * Two passes: guess by treating the wall clock as UTC, measure the zone's offset at that guess,
 * then correct. The second pass matters across a DST boundary, where the offset at the guess is not
 * the offset at the answer. A wall clock that does not exist (the spring-forward hour) lands on the
 * next instant that does, which is the conventional behaviour and is not worth more code here.
 */
function fromZonedWallClock(
  y: number, mo: number, d: number, h: number, mi: number, timezone: string,
): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const corrected = new Date(guess.getTime() - offsetMinutes(guess, timezone) * 60000);
  return new Date(corrected.getTime() - (offsetMinutes(corrected, timezone) - offsetMinutes(guess, timezone)) * 60000);
}

export function nextFireAt(rule: Rule, timezone: string, afterIso: string): string {
  const after = new Date(afterIso);

  if (rule.kind === 'interval') {
    const ms = rule.unit === 'minutes' ? 60000 : rule.unit === 'hours' ? 3600000 : 86400000;
    return new Date(after.getTime() + rule.every * ms).toISOString();
  }

  const p = zonedParts(after, timezone);

  // Walk candidate days forward until one lands strictly after `after`. At most 40 iterations,
  // which covers the longest monthly gap plus a DST shift; a loop that cannot terminate is worse
  // than one with a stated bound.
  for (let i = 0; i < 40; i += 1) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + i));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();

    if (rule.kind === 'weekly' && day.getUTCDay() !== rule.dow) continue;
    if (rule.kind === 'monthly' && d !== rule.day) continue;

    const candidate = fromZonedWallClock(y, mo, d, rule.hour, rule.minute, timezone);
    if (candidate.getTime() > after.getTime()) return candidate.toISOString();
  }

  throw new Error(`no next occurrence found for ${JSON.stringify(rule)} in ${timezone} after ${afterIso}`);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && pnpm vitest run test/recurrence.test.ts`
Expected: PASS, all 14.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/board/recurrence.ts apps/api/test/recurrence.test.ts
git commit -m "feat(recurrence): a restricted rule grammar with zone-aware next-fire"
```

---

## Task 9: Schedules in the board, and firing them

**Files:**
- Modify: `apps/api/src/board/board-do.ts` — the `schedules` table, CRUD, `fireDueSchedules`, and `sweepBoard` calling it
- Test: `apps/api/test/schedules.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  interface ScheduleView { id: string; enabled: boolean; title: string; spec: JsonValue; priority: number;
    labels: string[]; stageKey: string | null; rule: string; timezone: string;
    overlap: 'skip' | 'allow'; nextFireAt: string; lastFiredAt: string | null;
    lastCardId: string | null; skipCount: number }
  createSchedule(input): Promise<Result<ScheduleView>>
  updateSchedule(id, patch): Promise<Result<ScheduleView>>
  deleteSchedule(id): Promise<Result<{ id: string }>>
  listSchedules(): Promise<ScheduleView[]>
  fireDueSchedules(nowIso: string): Promise<{ fired: string[]; skipped: string[] }>
  ```
- Consumes: `parseRule`/`nextFireAt` (Task 8); `createCardFromTrigger` (`board-do.ts:1094`); `sweepBoard` (Task 5).

- [ ] **Step 1: Write the failing tests**

```ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function boardWithSchedule(board: BoardDO, name: string, patch: Record<string, unknown> = {}) {
  await board.init({ id: `brd_${name}`, tenantId: 'tnt_a', name, stages: STAGES });
  const r = await board.createSchedule({
    title: 'Sweep the logs',
    rule: 'daily at 09:00',
    timezone: 'UTC',
    overlap: 'skip',
    createdBy: 'usr_a',
    ...patch,
  });
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe('schedules', () => {
  it('refuses an unreadable rule at creation, with the parser’s own message', async () => {
    await runInDurableObject(stubFor('sch-bad'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sb', tenantId: 'tnt_a', name: 'SB', stages: STAGES });
      const r = await board.createSchedule({
        title: 'x', rule: 'every 2 minutes', timezone: 'UTC', overlap: 'skip', createdBy: 'usr_a',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain('5');
    });
  });

  it('computes the first fire time at creation', async () => {
    await runInDurableObject(stubFor('sch-first'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schfirst');
      expect(s.nextFireAt).toMatch(/T09:00:00\.000Z$/);
    });
  });

  it('creates a card when due, and advances next_fire_at past it', async () => {
    await runInDurableObject(stubFor('sch-fire'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schfire');
      const result = await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      expect(result.fired).toEqual([s.id]);

      const cards = (await board.getState()).cards;
      expect(cards).toHaveLength(1);
      expect(cards[0]!.title).toBe('Sweep the logs');

      const after = (await board.listSchedules())[0]!;
      expect(new Date(after.nextFireAt).getTime()).toBeGreaterThan(new Date('2099-01-01T10:00:00.000Z').getTime());
      expect(after.lastCardId).toBe(cards[0]!.id);
    });
  });

  it('does not fire twice for one due time', async () => {
    await runInDurableObject(stubFor('sch-once'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schonce');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      const second = await board.fireDueSchedules('2099-01-01T10:01:00.000Z');
      expect(second.fired).toEqual([]);
      expect((await board.getState()).cards).toHaveLength(1);
    });
  });

  it('skips while the previous card is still open, and records the skip visibly', async () => {
    await runInDurableObject(stubFor('sch-skip'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schskip');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      const skipped = await board.fireDueSchedules('2099-01-03T10:00:00.000Z');

      expect(skipped.skipped).toEqual([s.id]);
      expect((await board.getState()).cards).toHaveLength(1);
      expect((await board.listSchedules())[0]!.skipCount).toBe(1);

      // A silent skip is the failure mode this guards against: it must be on the audit log.
      const events = await board.getEvents(50);
      expect(events.some((e) => e.type === 'schedule.skipped')).toBe(true);
    });
  });

  it('fires again once the previous card is finished', async () => {
    await runInDurableObject(stubFor('sch-resume'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schresume');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected a claim');
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'swept' } });

      const again = await board.fireDueSchedules('2099-01-03T10:00:00.000Z');
      expect(again.fired).toHaveLength(1);
      expect((await board.getState()).cards).toHaveLength(2);
    });
  });

  it('fires regardless of an open card when overlap is allow', async () => {
    await runInDurableObject(stubFor('sch-allow'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schallow', { overlap: 'allow' });
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      await board.fireDueSchedules('2099-01-03T10:00:00.000Z');
      expect((await board.getState()).cards).toHaveLength(2);
    });
  });

  it('a disabled schedule never fires', async () => {
    await runInDurableObject(stubFor('sch-off'), async (board: BoardDO) => {
      const s = await boardWithSchedule(board, 'schoff');
      await board.updateSchedule(s.id, { enabled: false });
      expect((await board.fireDueSchedules('2099-01-01T10:00:00.000Z')).fired).toEqual([]);
      expect((await board.getState()).cards).toHaveLength(0);
    });
  });

  it('a scheduled card is claimable — the grant fallback is not optional', async () => {
    await runInDurableObject(stubFor('sch-claimable'), async (board: BoardDO) => {
      await boardWithSchedule(board, 'schclaim');
      await board.fireDueSchedules('2099-01-01T10:00:00.000Z');
      // Without createCardFromTrigger's queuedGrant fallback this is false under enforcement, and
      // every scheduled card would sit on the board forever. That is the whole reason this path
      // goes through the trigger helper rather than createCard.
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/api && pnpm vitest run test/schedules.test.ts`
Expected: FAIL — no `createSchedule`.

- [ ] **Step 3: Add the table**

Beside the other `CREATE TABLE IF NOT EXISTS` statements in `board-do.ts`:

```ts
    // Recurring cards (spec §3.7). In the board rather than D1 because a schedule is a property of
    // one board's pipeline, and firing it is a write to this DO.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS schedules (
        id            TEXT PRIMARY KEY,
        enabled       INTEGER NOT NULL DEFAULT 1,
        title         TEXT NOT NULL,
        spec_json     TEXT NOT NULL DEFAULT '{}',
        priority      INTEGER NOT NULL DEFAULT 0,
        labels        TEXT NOT NULL DEFAULT '[]',
        stage_key     TEXT,
        rule          TEXT NOT NULL,
        timezone      TEXT NOT NULL,
        overlap       TEXT NOT NULL DEFAULT 'skip',
        next_fire_at  TEXT NOT NULL,
        last_fired_at TEXT,
        last_card_id  TEXT,
        skip_count    INTEGER NOT NULL DEFAULT 0,
        created_by    TEXT,
        created_at    TEXT NOT NULL
      )`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(next_fire_at)`);
```

- [ ] **Step 4: Write CRUD**

`createSchedule` takes a **required** `createdBy` (the route supplies the authenticated user) — a schedule mints cards, and Principle 3 says every card has a human owner, so a schedule without one is not creatable. It validates through `parseRule` and **returns the parser's own error message** — a rule is typed by a human and the parser's message is the only useful one. It then sets `next_fire_at = nextFireAt(rule, timezone, now)`. `updateSchedule` re-parses and recomputes `next_fire_at` whenever `rule` or `timezone` changes; it must not silently keep a fire time computed from the old rule.

- [ ] **Step 5: Write `fireDueSchedules`**

```ts
  /**
   * Create cards for every schedule whose time has come.
   *
   * Called from `sweepBoard`, which the Worker cron calls every five minutes — so a schedule may
   * fire up to five minutes late, and the UI says so next to the field.
   *
   * Idempotent by construction: `next_fire_at` advances in the same call that creates the card, so
   * a double tick finds nothing due. If the create throws, `next_fire_at` is left alone and the next
   * tick retries — at-least-once, which for a maintenance card is the right way round.
   */
  async fireDueSchedules(nowIso: string): Promise<{ fired: string[]; skipped: string[] }> {
    const due = this.sql
      .exec(`SELECT * FROM schedules WHERE enabled = 1 AND next_fire_at <= ? ORDER BY next_fire_at ASC`, nowIso)
      .toArray();

    const fired: string[] = [];
    const skipped: string[] = [];

    for (const row of due) {
      const id = row.id as string;
      // Principle 3: every card has a human owner. A schedule with no recorded creator cannot
      // produce one, so it is disabled rather than allowed to mint ownerless cards. `createdBy` is
      // required at creation, so this can only be a row predating that — it is not a normal state.
      if (!row.created_by) {
        this.sql.exec(`UPDATE schedules SET enabled = 0 WHERE id = ?`, id);
        this.emit('schedule.disabled', { scheduleId: id, reason: 'no creator recorded; cannot own a card' });
        continue;
      }
      const parsed = parseRule(row.rule as string);
      if (!parsed.ok) {
        // A rule that no longer parses cannot fire and must not be retried every five minutes
        // forever. Disable it and say so, loudly, on the event log.
        this.sql.exec(`UPDATE schedules SET enabled = 0 WHERE id = ?`, id);
        this.emit('schedule.disabled', { scheduleId: id, reason: parsed.error });
        continue;
      }

      if ((row.overlap as string) === 'skip' && this.scheduleInstanceOpen(row.last_card_id as string | null)) {
        this.sql.exec(
          `UPDATE schedules SET skip_count = skip_count + 1, next_fire_at = ? WHERE id = ?`,
          nextFireAt(parsed.rule, row.timezone as string, nowIso),
          id,
        );
        // Visible, not silent. A schedule quietly skipping for a month is the failure this guards.
        this.emit('schedule.skipped', { scheduleId: id, openCardId: row.last_card_id, at: nowIso });
        skipped.push(id);
        continue;
      }

      const created = await this.createCardFromTrigger({
        title: row.title as string,
        ownerUserId: row.created_by as string,
        spec: { ...(JSON.parse(row.spec_json as string) as Record<string, unknown>), scheduleId: id },
      });
      if (!created.ok) {
        // next_fire_at is deliberately NOT advanced: the next tick tries again.
        this.emit('schedule.failed', { scheduleId: id, reason: created.code });
        continue;
      }

      const cardId = created.value.card.id;
      if (row.stage_key) await this.moveCard(cardId, row.stage_key as string, row.created_by as string);
      if (Number(row.priority) !== 0 || (row.labels as string) !== '[]') {
        await this.updateCard(cardId, {
          priority: Number(row.priority),
          labels: JSON.parse(row.labels as string) as string[],
        });
      }

      this.sql.exec(
        `UPDATE schedules SET next_fire_at = ?, last_fired_at = ?, last_card_id = ? WHERE id = ?`,
        nextFireAt(parsed.rule, row.timezone as string, nowIso),
        nowIso,
        cardId,
        id,
      );
      this.emit('schedule.fired', { scheduleId: id, cardId, at: nowIso });
      fired.push(id);
    }

    return { fired, skipped };
  }

  /** Is the previous instance of a schedule still open? Absent or resolved both mean "go ahead". */
  private scheduleInstanceOpen(lastCardId: string | null): boolean {
    if (!lastCardId) return false;
    const row = this.sql.exec(`SELECT state, archived_at FROM cards WHERE id = ?`, lastCardId).toArray()[0];
    if (!row) return false; // the card was deleted; nothing to wait for
    if (row.archived_at) return false;
    const state = row.state as string;
    return state !== 'completed' && state !== 'canceled' && state !== 'rejected' && state !== 'failed';
  }
```

Note `scheduleInstanceOpen` treats **all four** terminal states as closed. An instance that `failed` should not wedge the schedule forever — that is the opposite of a *blocker* that failed (Task 11), and the two must not share a helper.

- [ ] **Step 6: Call it from `sweepBoard`**

```ts
    const schedules = await this.fireDueSchedules(nowIso);
    return { overdueNotified: rows.length, schedulesFired: schedules.fired.length };
```

- [ ] **Step 7: Run everything**

Run: `cd apps/api && pnpm vitest run test/schedules.test.ts` then `pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/board/board-do.ts apps/api/test/schedules.test.ts
git commit -m "feat(schedules): recurring cards, fired from the worker cron with a visible skip"
```

---

## Task 10: Schedules in the UI and in `supi`

**Files:**
- Modify: `apps/api/src/index.ts` — `GET|POST /v1/boards/:id/schedules`, `PATCH|DELETE /v1/boards/:id/schedules/:scheduleId`
- Create: `apps/web/src/lib/components/board/ScheduleList.svelte`
- Modify: `apps/web/src/routes/b/[boardId]/settings/+page.svelte`, `apps/web/src/lib/api.ts`
- Modify: `packages/cli/src/index.ts` — `supi schedule list|add|rm|pause|resume`

- [ ] **Step 1: Routes, following the existing board-subroute shape**

Mirror how `/v1/boards/:id/cards` is matched in `index.ts` (`:1118`). Return the parser's message verbatim on a 400 — it is the only message that tells the author what to type instead.

- [ ] **Step 2: The settings section**

A list plus an add form. The rule field's helper text must state the accepted forms **and** the five-minute granularity:

> Runs are checked every five minutes, so a schedule may fire up to five minutes after its time.

Show `nextFireAt` in the board's timezone, `lastFiredAt`, and `skipCount` when non-zero — a skip count is the signal that a schedule is fighting an open card, and it is invisible if not shown.

- [ ] **Step 3: `supi schedule`**

`supi schedule list <boardId>`, `add <boardId> --title --rule --tz [--stage] [--priority] [--overlap]`, `rm`, `pause`, `resume`. Validate the rule client-side by shape only; the server owns the grammar.

- [ ] **Step 4: Run, then commit**

Run: `cd apps/web && pnpm check && pnpm test` and `cd packages/cli && pnpm test`

```bash
git add apps/api/src/index.ts apps/web/src packages/cli/src
git commit -m "feat(schedules): board settings UI and supi schedule verbs"
```

---

## Task 11: The Phase 2 live check

- [ ] **Step 1: Open the PR and merge**

```bash
git push -u origin feat/planning-phase2-recurrence
gh pr create --title "feat: recurring cards" --body "<see plan; include Task 1's Intl answer>"
```

- [ ] **Step 2: Prove it on the board that was named for it**

On **Recurring Maintenance** (`brd_24280cb0c7614d36`) — a board with bare stages, no instructions and zero cards, named after a capability that until now did not exist:

1. Give its stages an owner capability and instructions, or the scheduled card will be created and never claimed. The board has none today.
2. Add a schedule at `every 5 minutes`, overlap `skip`.
3. Confirm a card appears within five minutes, and that **an agent claims it** — this is the `queuedGrant` fallback working, and it is the failure that would otherwise look like "the schedule is broken".
4. Leave the card open through the next tick. Confirm `skipCount` becomes 1 and a `schedule.skipped` event is on the log.
5. Complete the card; confirm the next tick fires again.
6. Delete the schedule.

Record it in the PR. **If the scheduled card is created but never claimed, stop** — that is the grant fallback, and it makes every schedule useless.

---

# Phase 3 — dependencies and sub-tasks

Branch: `feat/planning-phase3-links`

Both constructs are one table with a `kind` column, which is why they are one phase.

## Task 12: `card_links`, and the two predicates

**Files:**
- Create: `apps/api/src/board/links.ts`, `apps/api/test/links.test.ts`
- Modify: `apps/api/src/board/board-do.ts` — the table and `addLink`/`removeLink`/`listLinks`

**Interfaces:**
- Produces:
  ```ts
  export type LinkKind = 'blocks' | 'relates' | 'parent';
  export interface LinkRow { fromCardId: string; toCardId: string; kind: LinkKind }
  /** RESOLVED = completed | canceled. NOT the same as terminal. */
  export function isResolved(state: string): boolean;
  export function wouldCycle(links: LinkRow[], candidate: LinkRow): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { isResolved, wouldCycle, type LinkRow } from '../src/board/links';
import { TERMINAL_STATES, isTerminal } from '@superpipeline/contract';

describe('isResolved', () => {
  it('treats completed and canceled as resolved', () => {
    expect(isResolved('completed')).toBe(true);
    expect(isResolved('canceled')).toBe(true);
  });

  it('does NOT treat failed or rejected as resolved — a blocker that failed still blocks', () => {
    expect(isResolved('failed')).toBe(false);
    expect(isResolved('rejected')).toBe(false);
  });

  it('is deliberately not isTerminal — this test exists to stop someone "simplifying" it', () => {
    const disagreements = TERMINAL_STATES.filter((s) => isTerminal(s) !== isResolved(s));
    expect(disagreements).toEqual(['rejected', 'failed']);
  });

  it('treats work in progress as unresolved', () => {
    for (const s of ['submitted', 'working', 'input-required', 'auth-required']) {
      expect(isResolved(s)).toBe(false);
    }
  });
});

describe('wouldCycle', () => {
  const link = (from: string, to: string, kind: LinkRow['kind'] = 'blocks'): LinkRow => ({
    fromCardId: from, toCardId: to, kind,
  });

  it('catches the direct case', () => {
    expect(wouldCycle([link('a', 'b')], link('b', 'a'))).toBe(true);
  });

  it('catches a long chain', () => {
    expect(wouldCycle([link('a', 'b'), link('b', 'c'), link('c', 'd')], link('d', 'a'))).toBe(true);
  });

  it('catches a self-link', () => {
    expect(wouldCycle([], link('a', 'a'))).toBe(true);
  });

  it('allows a diamond, which is not a cycle', () => {
    expect(wouldCycle([link('a', 'b'), link('a', 'c'), link('b', 'd')], link('c', 'd'))).toBe(false);
  });

  it('ignores `relates`, which orders nothing', () => {
    expect(wouldCycle([link('a', 'b', 'relates')], link('b', 'a', 'relates'))).toBe(false);
  });

  it('sees blocks and parent as one graph — mixing them can still deadlock', () => {
    expect(wouldCycle([link('a', 'b', 'parent')], link('b', 'a', 'blocks'))).toBe(true);
  });

  it('terminates on an existing cycle instead of hanging', () => {
    expect(wouldCycle([link('a', 'b'), link('b', 'a')], link('c', 'd'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd apps/api && pnpm vitest run test/links.test.ts`

- [ ] **Step 3: Write `apps/api/src/board/links.ts`**

```ts
/**
 * Card-to-card edges: pure predicates, kept out of the Durable Object so they can be tested.
 */

export type LinkKind = 'blocks' | 'relates' | 'parent';

export interface LinkRow {
  fromCardId: string;
  toCardId: string;
  kind: LinkKind;
}

/** The kinds that impose an order, and can therefore deadlock. `relates` is decoration. */
const ORDERING: ReadonlySet<LinkKind> = new Set<LinkKind>(['blocks', 'parent']);

/**
 * Whether a blocker has been dealt with.
 *
 * **This is not `isTerminal()` and must never be replaced by it.** `TERMINAL_STATES` also contains
 * `rejected` and `failed`, and a blocker that failed is precisely the case where the dependent card
 * must stay blocked — otherwise the edge does nothing in the only situation anyone added it for.
 * There is a test asserting the two disagree, on purpose.
 */
export function isResolved(state: string): boolean {
  return state === 'completed' || state === 'canceled';
}

/**
 * Would adding `candidate` close a loop among the ordering kinds?
 *
 * Breadth-first from the candidate's target back to its source, with a seen-set so an existing cycle
 * terminates the walk rather than hanging it — the same shape as `db/implications.ts`.
 */
export function wouldCycle(links: LinkRow[], candidate: LinkRow): boolean {
  if (!ORDERING.has(candidate.kind)) return false;
  if (candidate.fromCardId === candidate.toCardId) return true;

  const out = new Map<string, string[]>();
  for (const l of links) {
    if (!ORDERING.has(l.kind)) continue;
    const list = out.get(l.fromCardId);
    if (list) list.push(l.toCardId);
    else out.set(l.fromCardId, [l.toCardId]);
  }

  const seen = new Set<string>();
  const queue = [candidate.toCardId];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === candidate.fromCardId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of out.get(node) ?? []) queue.push(next);
  }
  return false;
}
```

- [ ] **Step 4: Add the table and CRUD to the DO**

```ts
    // Dependencies AND sub-task containment, in one table (spec §3.4). Same-board only: an edge
    // that may refuse a claim has to be strongly consistent, which means inside this DO.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS card_links (
        from_card_id TEXT NOT NULL,
        to_card_id   TEXT NOT NULL,
        kind         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        created_by   TEXT,
        PRIMARY KEY (from_card_id, to_card_id, kind)
      )`,
    );
    // A card has at most one parent.
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS card_links_one_parent ON card_links (to_card_id) WHERE kind = 'parent'`,
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_card_links_to ON card_links(to_card_id, kind)`);
```

- [ ] **Step 4b: Make `deleteCard` remove a card's edges — both directions**

`deleteCard` (`board-do.ts:1252`) clears card-scoped rows from a fixed list of tables, every one of
which keys on `card_id`. `card_links` keys on **two** columns, so it cannot join that list:

```ts
    // Both directions. A deleted card's edges must go with it: a lingering `blocks` row points at a
    // card that no longer exists, and the drawer would render a blocker nobody can open or resolve.
    this.sql.exec(`DELETE FROM card_links WHERE from_card_id = ? OR to_card_id = ?`, cardId, cardId);
```

Add a test for it:

```ts
  it('takes a card\u2019s links with it when the card is deleted', async () => {
    await runInDurableObject(stubFor('link-delete'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'linkdelete');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      await board.deleteCard(a.id);
      expect(await board.listLinks(b.id)).toEqual([]);
      // And b is claimable again, rather than blocked forever by a card that is gone.
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(true);
    });
  });
```

The claim exclusion in Task 13 JOINs `cards` on the blocker, so a dangling edge already fails to
block — it degrades safely. The row still has to go: the UI reads links directly and would show a
blocker that cannot be opened.

`addLink` refuses, with a distinct code each: a card that does not exist (`NO_SUCH_CARD`), a cycle (`LINK_WOULD_CYCLE`), a second parent (`ALREADY_HAS_PARENT`). One code per reason — "invalid link" tells the caller nothing about what to do next.

- [ ] **Step 5: Run and commit**

Run: `cd apps/api && pnpm vitest run test/links.test.ts && pnpm test`

```bash
git add apps/api/src/board/links.ts apps/api/src/board/board-do.ts apps/api/test/links.test.ts
git commit -m "feat(links): card_links with a cycle check and a resolution rule that is not isTerminal"
```

---

## Task 13: Enforce it — exclusion on claim, refusal on advance

**Files:**
- Modify: `apps/api/src/board/board-do.ts` — the claim query, `advance`/`moveCard`
- Test: `apps/api/test/links-enforcement.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

```ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
  { key: 'ship', name: 'Ship', order: 1, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function two(board: BoardDO, name: string) {
  await board.init({ id: `brd_${name}`, tenantId: 'tnt_a', name, stages: STAGES });
  const a = await board.createCard({ title: 'Blocker', ownerUserId: 'usr_a' });
  const b = await board.createCard({ title: 'Blocked', ownerUserId: 'usr_a' });
  if (!a.ok || !b.ok) throw new Error('setup failed');
  return { a: a.value, b: b.value };
}

describe('a blocked card is not handed out', () => {
  it('is skipped in favour of a claimable one', async () => {
    await runInDurableObject(stubFor('enf-skip'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'enfskip');
      // b is blocked by a. Give b the higher priority so only the block can explain the outcome.
      await board.updateCard(b.id, { priority: 9 });
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(a.id);
    });
  });

  it('reports no work when the ONLY card is blocked — not an error', async () => {
    await runInDurableObject(stubFor('enf-none'), async (board: BoardDO) => {
      await board.init({ id: 'brd_enfnone', tenantId: 'tnt_a', name: 'EN', stages: STAGES });
      const a = await board.createCard({ title: 'Blocker', ownerUserId: 'usr_a' });
      const b = await board.createCard({ title: 'Blocked', ownerUserId: 'usr_a' });
      if (!a.ok || !b.ok) throw new Error('setup failed');
      await board.updateCard(a.id, { archivedAt: '2026-09-30T00:00:00.000Z' });
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      // An archived blocker is still unresolved. `{claimed:false}` is correct and is what the
      // bridge already handles — there is no new refusal code on this path.
      expect((await board.claim({ agentId: 'agt_w', capabilities: ['writing'] })).claimed).toBe(false);
    });
  });

  it('unblocks once the blocker completes', async () => {
    await runInDurableObject(stubFor('enf-unblock'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'enfunblock');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected a claim');
      expect(c.card.id).toBe(a.id);
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'done' } });
      const next = await board.claim({ agentId: 'agt_w2', capabilities: ['writing'] });
      if (!next.claimed) throw new Error('expected b to be claimable now');
      expect(next.card.id).toBe(b.id);
    });
  });

  it('STAYS blocked when the blocker fails — the whole point of the edge', async () => {
    await runInDurableObject(stubFor('enf-failed'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'enffailed');
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected a claim');
      await board.fail({ runId: c.runId, leaseEpoch: c.leaseEpoch, reason: 'could not do it' });
      expect((await board.claim({ agentId: 'agt_w2', capabilities: ['writing'] })).claimed).toBe(false);
    });
  });

  it('`relates` blocks nothing', async () => {
    await runInDurableObject(stubFor('enf-relates'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'enfrelates');
      await board.updateCard(b.id, { priority: 9 });
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'relates' });
      const claim = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!claim.claimed) throw new Error('expected a claim');
      expect(claim.card.id).toBe(b.id);
    });
  });
});

describe('a parent does not advance past an open child', () => {
  it('refuses with CARD_BLOCKED, and allows it once the child is resolved', async () => {
    await runInDurableObject(stubFor('enf-parent'), async (board: BoardDO) => {
      const { a: parent, b: child } = await two(board, 'enfparent');
      await board.addLink({ fromCardId: parent.id, toCardId: child.id, kind: 'parent' });

      const refused = await board.moveCard(parent.id, 'ship', 'usr_a');
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe('CARD_BLOCKED');

      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected the child to be claimable');
      expect(c.card.id).toBe(child.id);
      await board.complete({ runId: c.runId, leaseEpoch: c.leaseEpoch, handoff: { summary: 'child done' } });

      const allowed = await board.moveCard(parent.id, 'ship', 'usr_a');
      expect(allowed.ok).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd apps/api && pnpm vitest run test/links-enforcement.test.ts`

- [ ] **Step 3: Extend the shared eligibility predicate — do not edit the claim query directly**

Task 5 extracted `claimableWhere(placeholders)` precisely so this task has one place to change.
Editing the claim query alone would leave `countReadyForCapabilities` advertising blocked cards that
`claim_card` refuses, and Task 5's `due-archived-count` test does not cover the blocked case.

This is an **exclusion, not a refusal**: `claim` takes no `cardId` (`apps/api/src/mcp/tools.ts:131`),
so the server chooses and a blocked card is simply never chosen. Nothing outside this repo changes,
and it cannot claim/refuse hot-loop.

```ts
  private claimableWhere(placeholders: string): string {
    return `c.state = 'submitted' AND c.archived_at IS NULL
      AND c.current_stage_key IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM card_links l
          JOIN cards b ON b.id = l.from_card_id
         WHERE l.to_card_id = c.id AND l.kind = 'blocks'
           AND b.state NOT IN ('completed', 'canceled')
      )
      AND NOT EXISTS (
        SELECT 1 FROM card_links l
          JOIN cards ch ON ch.id = l.to_card_id
         WHERE l.from_card_id = c.id AND l.kind = 'parent'
           AND ch.state NOT IN ('completed', 'canceled')
      )`;
  }
```

Both callers pick the change up unchanged. **Add a test asserting the count agrees**, mirroring Task
5's `due-archived-count`:

```ts
  it('does not advertise a blocked card either', async () => {
    await runInDurableObject(stubFor('enf-count'), async (board: BoardDO) => {
      const { a, b } = await two(board, 'enfcount');
      expect(await board.countReadyForCapabilities('agt_w', ['writing'])).toBe(2);
      await board.addLink({ fromCardId: a.id, toCardId: b.id, kind: 'blocks' });
      // One claimable (the blocker), one excluded (the blocked card).
      expect(await board.countReadyForCapabilities('agt_w', ['writing'])).toBe(1);
    });
  });
```

`NOT IN ('completed', 'canceled')` is `isResolved` inverted, inline. **Do not widen it to the four terminal states** — the `enf-failed` test exists to catch exactly that edit.

The second clause also stops a *parent* being claimed while a child is open: a parent whose children are unfinished is not work an agent should pick up.

- [ ] **Step 4: Refuse the advance**

In `moveCard` and in the automatic advance, before changing the stage:

```ts
    const openChildren = this.sql
      .exec(
        `SELECT COUNT(*) AS n FROM card_links l JOIN cards ch ON ch.id = l.to_card_id
          WHERE l.from_card_id = ? AND l.kind = 'parent' AND ch.state NOT IN ('completed', 'canceled')`,
        cardId,
      )
      .one().n;
    if (Number(openChildren) > 0) {
      return {
        ok: false,
        code: 'CARD_BLOCKED',
        message: `${openChildren} sub-task${Number(openChildren) === 1 ? '' : 's'} still open`,
      };
    }
```

This one **is** a refusal, because advancing is an explicit act by a named caller rather than a selection from a set.

A human moving a *blocked* card is **allowed** — record an activity saying so and let it through. Principle 3: a human owns the card and is accountable, and a human can see the badge. This is the one place Linear's advisory model is right.

- [ ] **Step 5: Run and commit**

Run: `cd apps/api && pnpm vitest run test/links-enforcement.test.ts && pnpm test`

```bash
git add apps/api/src/board/board-do.ts apps/api/test/links-enforcement.test.ts
git commit -m "feat(links): exclude blocked cards from claim, refuse a parent advance with open children"
```

---

## Task 14: Child cards — creation, inheritance, cost rollup

**Files:**
- Modify: `apps/api/src/board/board-do.ts` — `createChildCard`, `CardView.costUsdRollup`, `CardView.parentCardId`, `CardView.openChildCount`
- Test: `apps/api/test/sub-cards.test.ts` (create)

**Interfaces:**
- Produces: `createChildCard(parentCardId, input): Promise<Result<CardView>>`; `CardView` gains `parentCardId: string | null`, `openChildCount: number`, `costUsdRollup: number`.

- [ ] **Step 1: Write the failing tests**

```ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

describe('child cards', () => {
  it('inherits priority but NOT labels, matching Linear', async () => {
    await runInDurableObject(stubFor('sub-inherit'), async (board: BoardDO) => {
      await board.init({ id: 'brd_si', tenantId: 'tnt_a', name: 'SI', stages: STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a', priority: 7 });
      if (!p.ok) throw new Error(p.message);
      await board.updateCard(p.value.id, { labels: ['lbl_aaaaaaaaaaaaaaaa'] });

      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error(child.message);
      expect(child.value.priority).toBe(7);
      expect(child.value.labels).toEqual([]);
      expect(child.value.parentCardId).toBe(p.value.id);
    });
  });

  it('reports the parent’s open child count', async () => {
    await runInDurableObject(stubFor('sub-count'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sc', tenantId: 'tnt_a', name: 'SC', stages: STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      if (!p.ok) throw new Error(p.message);
      await board.createChildCard(p.value.id, { title: 'One', ownerUserId: 'usr_a' });
      await board.createChildCard(p.value.id, { title: 'Two', ownerUserId: 'usr_a' });
      const parent = (await board.getState()).cards.find((c) => c.id === p.value.id)!;
      expect(parent.openChildCount).toBe(2);
    });
  });

  it('rolls cost up WITHOUT changing costUsd, which feeds the budget gate', async () => {
    await runInDurableObject(stubFor('sub-cost'), async (board: BoardDO) => {
      await board.init({ id: 'brd_scost', tenantId: 'tnt_a', name: 'SCost', stages: STAGES });
      const p = await board.createCard({ title: 'Parent', ownerUserId: 'usr_a' });
      if (!p.ok) throw new Error(p.message);
      const child = await board.createChildCard(p.value.id, { title: 'Child', ownerUserId: 'usr_a' });
      if (!child.ok) throw new Error(child.message);

      const c = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!c.claimed) throw new Error('expected a claim');
      // `UsageInput` is `{ model?, inputTokens?, outputTokens?, costUsd? }` (board-do.ts:385) —
      // NOT ACP's `{ used, size, cost }`. The two are easy to confuse because the bridge translates
      // between them; the DO only ever sees this shape.
      await board.postActivity({
        runId: c.runId, leaseEpoch: c.leaseEpoch, type: 'thought', body: 'working',
        usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.25 },
      });

      const cards = (await board.getState()).cards;
      const parent = cards.find((x) => x.id === p.value.id)!;
      const kid = cards.find((x) => x.id === child.value.id)!;
      expect(kid.costUsd).toBeCloseTo(0.25, 5);
      // The parent spent nothing itself. costUsd must stay 0 or `overBudget` moves.
      expect(parent.costUsd).toBe(0);
      expect(parent.costUsdRollup).toBeCloseTo(0.25, 5);
    });
  });

  it('refuses a child of a card that does not exist', async () => {
    await runInDurableObject(stubFor('sub-missing'), async (board: BoardDO) => {
      await board.init({ id: 'brd_sm', tenantId: 'tnt_a', name: 'SM', stages: STAGES });
      const r = await board.createChildCard('card_nope', { title: 'Orphan', ownerUserId: 'usr_a' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('NO_SUCH_CARD');
    });
  });
});
```

- [ ] **Step 2: Run to see it fail**, then implement

Run: `cd apps/api && pnpm vitest run test/sub-cards.test.ts`

`createChildCard` calls the existing `createCard` (so the child gets a `queuedGrant` and is claimable), then `addLink({ kind: 'parent' })`. Inherit `priority`, `project_id`, `milestone_id`. Do **not** inherit `labels` or `due_at`: a sub-task's deadline is not its parent's, and Linear does not inherit labels either.

In `rowToCard`, add:

```ts
      parentCardId: (this.sql
        .exec(`SELECT from_card_id FROM card_links WHERE to_card_id = ? AND kind = 'parent'`, id)
        .toArray()[0]?.from_card_id as string | undefined) ?? null,
      openChildCount: Number(
        this.sql
          .exec(
            `SELECT COUNT(*) AS n FROM card_links l JOIN cards ch ON ch.id = l.to_card_id
              WHERE l.from_card_id = ? AND l.kind = 'parent' AND ch.state NOT IN ('completed', 'canceled')`,
            id,
          )
          .one().n,
      ),
      // Own cost plus one level of children. One level, not recursive: nesting deeper than one is
      // not a shape this board model encourages, and an unbounded walk inside rowToCard would run
      // on every card of every board read.
      costUsdRollup: costUsd + this.childrenCost(id),
```

`childrenCost` is new; define it beside the existing `cardCost` (`board-do.ts:3301`) and in its
style — one query, `COALESCE(SUM(...), 0)`:

```ts
  /**
   * The summed cost of a card's direct children.
   *
   * One level deep, matching `costUsdRollup`. Deliberately a sibling of `cardCost` rather than a
   * parameter to it: `cardCost` feeds the budget gate (`board-do.ts:2320`) and must keep meaning
   * "what this card itself spent".
   */
  private childrenCost(cardId: string): number {
    return Number(
      this.sql
        .exec(
          `SELECT COALESCE(SUM(u.cost_usd), 0) AS c FROM usage_records u
             WHERE u.card_id IN (SELECT to_card_id FROM card_links WHERE from_card_id = ? AND kind = 'parent')`,
          cardId,
        )
        .one().c,
    );
  }
```

> ⚠️ `rowToCard` runs for **every card on every board read**. These are three extra queries per card. If a board read gets slow, batch them in `getState` and pass them through the existing `pre?` parameter — which is exactly why that parameter exists for `costUsd` already.
>
> ⚠️ **Do not route the rollup through `cardCost`.** `cardCost` is what the budget gate reads at
> `board-do.ts:2320` to decide whether to stop handing out work; widening it to include children
> would silently move that gate. The two functions stay separate for that reason.

- [ ] **Step 3: Run and commit**

Run: `cd apps/api && pnpm vitest run test/sub-cards.test.ts && pnpm test`

```bash
git add apps/api/src/board/board-do.ts apps/api/test/sub-cards.test.ts
git commit -m "feat(sub-tasks): child cards with inheritance and a non-destructive cost rollup"
```

---

## Task 15: The converter, and the tool that makes it worth having

A checklist a human ticks is worth little. A card an agent can **decompose into claimable children mid-run** is the reason this construct exists.

**Files:**
- Modify: `apps/api/src/index.ts` — `POST /v1/boards/:id/cards/:cardId/split`
- Modify: `apps/api/src/mcp/tools.ts` — `superpipeline_split_card`; `apps/api/src/mcp/auth.ts` scope table
- Test: `apps/api/test/card-split.test.ts`, `apps/api/test/mcp-split-scope.test.ts` (create)

**Interfaces:**
- Produces: `splitCard(cardId, titles: string[], actor): Promise<Result<{ children: CardView[] }>>`; MCP tool `superpipeline_split_card` at scope **`run`**.

- [ ] **Step 1: Write the failing tests**

```ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

async function parentOn(board: BoardDO, name: string): Promise<string> {
  await board.init({ id: `brd_${name}`, tenantId: 'tnt_a', name, stages: STAGES });
  const p = await board.createCard({ title: 'Ship supermd v1', ownerUserId: 'usr_a' });
  if (!p.ok) throw new Error(p.message);
  return p.value.id;
}

describe('splitCard', () => {
  it('creates one child per line and links them all to the parent', async () => {
    await runInDurableObject(stubFor('split-basic'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitbasic');
      const r = await board.splitCard(parentId, ['Write the spec', 'Build the parser'], 'usr_a');
      if (!r.ok) throw new Error(r.message);
      expect(r.value.children.map((c) => c.title)).toEqual(['Write the spec', 'Build the parser']);
      expect(r.value.children.every((c) => c.parentCardId === parentId)).toBe(true);

      const parent = (await board.getState()).cards.find((c) => c.id === parentId)!;
      expect(parent.openChildCount).toBe(2);
    });
  });

  it('strips markdown checkbox syntax, so "- [ ] Foo" becomes "Foo"', async () => {
    await runInDurableObject(stubFor('split-md'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitmd');
      const r = await board.splitCard(
        parentId,
        ['- [ ] Write the spec', '- [x] Build the parser', '* Draft the post', '2. Review it'],
        'usr_a',
      );
      if (!r.ok) throw new Error(r.message);
      expect(r.value.children.map((c) => c.title)).toEqual([
        'Write the spec',
        'Build the parser',
        'Draft the post',
        'Review it',
      ]);
    });
  });

  it('ignores blank lines rather than creating untitled cards', async () => {
    await runInDurableObject(stubFor('split-blank'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitblank');
      const r = await board.splitCard(parentId, ['One', '', '   ', '- [ ] ', 'Two'], 'usr_a');
      if (!r.ok) throw new Error(r.message);
      expect(r.value.children.map((c) => c.title)).toEqual(['One', 'Two']);
    });
  });

  it('refuses more than 20 in one call, and creates none of them', async () => {
    await runInDurableObject(stubFor('split-limit'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitlimit');
      const many = Array.from({ length: 21 }, (_, i) => `Item ${i + 1}`);
      const r = await board.splitCard(parentId, many, 'usr_a');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('TOO_MANY_CHILDREN');
        expect(r.message).toContain('20');
      }
      // A refused split leaves nothing behind: partially creating 20 of 21 would be worse than
      // refusing, because the caller cannot tell which succeeded.
      expect((await board.getState()).cards).toHaveLength(1);
    });
  });

  it('refuses when every line is blank, rather than succeeding with nothing', async () => {
    await runInDurableObject(stubFor('split-empty'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splitempty');
      const r = await board.splitCard(parentId, ['', '- [ ] '], 'usr_a');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('NOTHING_TO_SPLIT');
    });
  });

  it('is not idempotent, deliberately: calling twice creates two sets', async () => {
    await runInDurableObject(stubFor('split-twice'), async (board: BoardDO) => {
      const parentId = await parentOn(board, 'splittwice');
      await board.splitCard(parentId, ['One'], 'usr_a');
      await board.splitCard(parentId, ['One'], 'usr_a');
      // De-duplicating by title would silently drop a legitimately repeated sub-task. The tool
      // description tells the agent to call it once; the UI confirms before a second call.
      const parent = (await board.getState()).cards.find((c) => c.id === parentId)!;
      expect(parent.openChildCount).toBe(2);
    });
  });
});
```

The markdown case matters: the input is whatever a human or an agent pasted, and `- [ ] Write the spec` must not become a card titled `- [ ] Write the spec`. Strip in order: a leading `-`/`*`/`<digit>.` bullet, then a `[ ]`/`[x]` checkbox, then whitespace.

- [ ] **Step 2: Scope the MCP tool at `run`, and test that it is**

`superpipeline_split_card` goes in the scope table (`apps/api/src/mcp/tools.ts:48-57`) as `'run'`, not `'claim'`. A run-scoped token is what a dispatched agent holds; `claim` is the roster credential. Getting this wrong hands the decomposition tool to something that should only be claiming.

```ts
import { describe, it, expect } from 'vitest';
import { TOOL_SCOPE } from '../src/mcp/tools';

describe('superpipeline_split_card scope', () => {
  it('is run-scoped, not claim-scoped', () => {
    // `claim` is the roster credential the bridge holds; `run` is what a dispatched agent holds for
    // the one card it is working. Decomposition is something an agent does to ITS card mid-run, so
    // it belongs to `run`. Scoped to `claim` it would be handed to the thing that should only be
    // taking work, which is the separation #622 established with two credentials per agent.
    expect(TOOL_SCOPE.superpipeline_split_card).toBe('run');
  });

  it('leaves claim_card the only tool a run-only token cannot reach', () => {
    const runnable = Object.entries(TOOL_SCOPE)
      .filter(([, scope]) => scope !== 'run')
      .map(([name]) => name);
    // Verified live in #622: tools/list with a run-only token returned 11 tools and withheld
    // exactly superpipeline_claim_card. Adding split_card must not change that count by widening
    // anything else.
    expect(runnable).toEqual(['superpipeline_claim_card']);
  });
});
```

`TOOL_SCOPE` — **singular**, and currently `const TOOL_SCOPE`, not exported (`apps/api/src/mcp/tools.ts:47`). Export it as part of this task. Note that read-only tools are deliberately absent from the table (the comment above it says reads are unscoped), so `Object.entries` sees only the mutating tools. The second test is the one that keeps its value over time — it fails if *any* future tool is given a scope other than `run`, which is the moment to think rather than the moment to discover it live.

- [ ] **Step 3: Implement, run, commit**

The tool description must tell the agent *when* to use it — a description that only says what it does gets ignored:

```
Split the card you are working on into sub-cards, one per line, when the work has independent
parts that different capabilities should pick up. Each becomes a real card that can be claimed
separately. Your card will not advance until all of them are resolved.
```

Run: `cd apps/api && pnpm test`

```bash
git add apps/api/src apps/api/test
git commit -m "feat(sub-tasks): split a card into children, over REST and over MCP"
```

---

## Task 16: Cross-board edges — advisory, in D1, and labelled as such

**Files:**
- Create: `apps/api/migrations/0011_card_links_external.sql`, `apps/api/src/db/card-links-external.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/test/card-links-external.test.ts` (create)

- [ ] **Step 1: The migration**

```sql
-- Migration 0011. Cross-board card edges. ADVISORY, always — read the design before extending this.
--
-- Cards live in per-board Durable Objects, so an edge whose ends are in different DOs cannot be
-- consulted on the claim path without a cross-DO read, and a stale cross-DO read either refuses a
-- card that just unblocked or admits one that just became blocked. Rather than an enforcement that
-- is wrong occasionally, these are informational and the UI says so.
--
-- `parent` is deliberately NOT an allowed kind: a parent edge carries a rule (a parent does not
-- advance while a child is open), and an advisory containment relationship is one that fails to
-- contain. Cross-board decomposition is a project (migration 0011).
CREATE TABLE card_links_external (
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  from_board_id TEXT NOT NULL,
  from_card_id  TEXT NOT NULL,
  to_board_id   TEXT NOT NULL,
  to_card_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('blocks', 'relates')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (from_card_id, to_card_id, kind)
);
CREATE INDEX idx_card_links_external_tenant ON card_links_external(tenant_id);
CREATE INDEX idx_card_links_external_to ON card_links_external(to_card_id);
```

- [ ] **Step 2: Test that the boundary holds**

```ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { addExternalLink, listExternalLinksFor } from '../src/db/card-links-external';

const A = { boardId: 'brd_press', cardId: 'card_aaaaaaaaaaaaaaaa' };
const B = { boardId: 'brd_releases', cardId: 'card_bbbbbbbbbbbbbbbb' };

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_x', 'x', 'X')`).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_y', 'y', 'Y')`).run();
});

describe('cross-board edges', () => {
  it('accepts an edge between two different boards', async () => {
    const r = await addExternalLink(env.DB, 'tnt_x', { from: A, to: B, kind: 'blocks' });
    expect(r.ok).toBe(true);
  });

  it('refuses a same-board edge — those belong in the DO, where they can be enforced', async () => {
    const r = await addExternalLink(env.DB, 'tnt_x', {
      from: A,
      to: { boardId: A.boardId, cardId: 'card_cccccccccccccccc' },
      kind: 'blocks',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SAME_BOARD_EDGE');
      expect(r.message).toContain('card_links');
    }
    // This is the important one. Two places to store the same edge — one enforced, one not — is
    // how an enforced rule quietly stops being enforced: someone writes the advisory row, the
    // claim path never reads it, and the UI shows a badge that does nothing.
  });

  it('refuses kind=parent, and says why rather than just rejecting', async () => {
    const r = await addExternalLink(env.DB, 'tnt_x', { from: A, to: B, kind: 'parent' as never });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('PARENT_MUST_BE_SAME_BOARD');
      expect(r.message).toContain('project');
    }
  });

  it('is tenant-scoped: another tenant cannot see the edge', async () => {
    await addExternalLink(env.DB, 'tnt_x', { from: A, to: B, kind: 'relates' });
    expect(await listExternalLinksFor(env.DB, 'tnt_x', B.cardId)).not.toHaveLength(0);
    expect(await listExternalLinksFor(env.DB, 'tnt_y', B.cardId)).toHaveLength(0);
  });

  it('is idempotent on the same triple, rather than duplicating the badge', async () => {
    await addExternalLink(env.DB, 'tnt_x', { from: A, to: B, kind: 'relates' });
    await addExternalLink(env.DB, 'tnt_x', { from: A, to: B, kind: 'relates' });
    const found = (await listExternalLinksFor(env.DB, 'tnt_x', B.cardId)).filter(
      (l) => l.kind === 'relates',
    );
    expect(found).toHaveLength(1);
  });
});
```

The `SAME_BOARD_EDGE` refusal is the one that protects the design: the enforced and advisory stores must never both be able to hold one edge.

- [ ] **Step 3: Implement, run, commit**

```bash
git add apps/api/migrations/0011_card_links_external.sql apps/api/src apps/api/test
git commit -m "feat(links): advisory cross-board edges, refused for same-board and for parent"
```

---

## Task 17: Phase 3 in the UI, and the live check

**Files:**
- Modify: `apps/web/src/lib/components/CardDrawer.svelte` — a Sub-tasks section (children with state and cost), a Blockers section, an "Add sub-task" action
- Modify: `apps/web/src/lib/components/board/CardTile.svelte` — a blocked badge, a `2/5` child counter
- Modify: `apps/web/src/lib/components/board/BoardKanban.svelte` — a per-stage blocked count
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Two badges, never one**

This is the part the design is most specific about. An enforced blocker and an advisory one must look different:

| | badge | tooltip |
|---|---|---|
| same-board `blocks`, unresolved | **`⛔ Blocked`** | "Blocked by *Title* — this card will not be claimed" |
| cross-board `blocks`, unresolved | `⚑ Blocked (advisory)` | "Blocked by *Title* on *Board* — not enforced across boards" |

A single badge covering both would sometimes lie, and a badge that sometimes lies is worse than two honest badges.

- [ ] **Step 2: The blocked count per stage**

Because a blocked card is *excluded* rather than refused, an agent reports "no work" and a human sees cards sitting in a column doing nothing. The stage header must show `3 blocked` or the board looks broken. **This is not optional polish** — it is the only place the exclusion is ever explained.

- [ ] **Step 3: Run, commit, PR**

Run: `cd apps/web && pnpm check && pnpm test`

```bash
git push -u origin feat/planning-phase3-links
gh pr create --title "feat: dependencies and sub-tasks" --body "<see plan>"
```

- [ ] **Step 4: THE LIVE CHECK**

On a scratch board:

1. Two cards, B blocked by A, B at higher priority. An agent must claim **A**. If it claims B, the `NOT EXISTS` clause is not live.
2. Let A **fail**. Confirm B is *still* not claimed. This is the `isResolved`-vs-`isTerminal` distinction, and it is the one bug in this plan that unit tests could pass while production is wrong.
3. Give a card two children. Confirm the parent cannot advance, and that the drawer says why.
4. From a real agent run, call `superpipeline_split_card` over MCP and confirm children appear and are claimed by the right capabilities. **This is the feature's actual purpose**; everything else is bookkeeping.
5. Confirm the stage header's blocked count is visible on a phone-width window.

---

# Phase 4 — projects and milestones

Branch: `feat/planning-phase4-projects`

The only phase with cross-DO reads, and the only one whose numbers are a snapshot rather than a fact.

## Task 18: Projects and milestones in D1

**Files:**
- Create: `apps/api/migrations/0012_projects_and_milestones.sql`, `apps/api/src/db/projects.ts`
- Test: `apps/api/test/projects.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export interface ProjectRecord { id: string; tenantId: string; name: string; description: string | null;
    targetDate: string | null; state: ProjectState; health: ProjectHealth | null;
    leadUserId: string | null; createdAt: string; updatedAt: string | null }
  export interface MilestoneRecord { id: string; projectId: string; tenantId: string; name: string;
    targetDate: string | null; sortOrder: number; createdAt: string }
  listProjects / createProject / updateProject / deleteProject / projectById
  listMilestones / createMilestone / updateMilestone / deleteMilestone
  ```

- [ ] **Step 1: The migration**

```sql
-- Migration 0012. Projects group work ACROSS boards; milestones are ordered checkpoints inside one project.
--
-- Here rather than in a board's Durable Object because that is the whole point: a project confined
-- to one board would be indistinguishable from a label, and labels already exist (migration 0010).
-- The cost is that a project's numbers are a fan-out read over many DOs and therefore a snapshot —
-- see project_rollups below, and note that the UI is required to show its "as of" time.
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  description  TEXT,
  target_date  TEXT,
  state        TEXT NOT NULL DEFAULT 'active'
                 CHECK (state IN ('planned', 'active', 'paused', 'completed', 'canceled')),
  -- Declared by a human, never computed. A health that a rollup calculated would be a second,
  -- quieter progress bar; this is someone's judgement and is allowed to disagree with the numbers.
  health       TEXT CHECK (health IN ('on-track', 'at-risk', 'off-track')),
  lead_user_id TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT,
  UNIQUE (tenant_id, name)
);
CREATE INDEX idx_projects_tenant ON projects(tenant_id);

CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  target_date TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_milestones_project ON milestones(project_id, sort_order);

-- The cached fan-out. `computed_at` is not bookkeeping: it is rendered in the UI, because a number
-- assembled from eleven Durable Objects at some past moment should not be presented as current.
CREATE TABLE project_rollups (
  project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  cards_total  INTEGER NOT NULL DEFAULT 0,
  cards_done   INTEGER NOT NULL DEFAULT 0,
  cards_overdue INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  computed_at  TEXT NOT NULL
);
```

- [ ] **Step 2: Tests, then the module**

```ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createProject, listProjects, deleteProject, projectById,
  createMilestone, listMilestones,
} from '../src/db/projects';

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_p1', 'p-one', 'One')`),
    env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_p2', 'p-two', 'Two')`),
  ]);
});

describe('projects', () => {
  it('refuses two projects with the same name in one tenant', async () => {
    await createProject(env.DB, 'tnt_p1', { name: 'supermd v1' });
    await expect(createProject(env.DB, 'tnt_p1', { name: 'supermd v1' })).rejects.toThrow();
  });

  it('lets another tenant use the same name, and never shows it across the boundary', async () => {
    await createProject(env.DB, 'tnt_p2', { name: 'supermd v1' });
    const one = await listProjects(env.DB, 'tnt_p1');
    const two = await listProjects(env.DB, 'tnt_p2');
    expect(one.filter((p) => p.name === 'supermd v1')).toHaveLength(1);
    expect(two.filter((p) => p.name === 'supermd v1')).toHaveLength(1);
    expect(one.find((p) => p.name === 'supermd v1')!.id).not.toBe(
      two.find((p) => p.name === 'supermd v1')!.id,
    );
  });

  it('cannot be read from the wrong tenant, even with a correct id', async () => {
    const mine = await createProject(env.DB, 'tnt_p1', { name: 'private plans' });
    expect(await projectById(env.DB, 'tnt_p1', mine.id)).not.toBeNull();
    expect(await projectById(env.DB, 'tnt_p2', mine.id)).toBeNull();
  });

  it('defaults state to active and leaves health unset, because health is a judgement', async () => {
    const p = await createProject(env.DB, 'tnt_p1', { name: 'fresh' });
    expect(p.state).toBe('active');
    expect(p.health).toBeNull();
  });

  it('refuses an unknown state rather than storing it', async () => {
    await expect(
      createProject(env.DB, 'tnt_p1', { name: 'bad state', state: 'nearly' as never }),
    ).rejects.toThrow();
  });
});

describe('milestones', () => {
  it('are deleted with their project, via the cascade', async () => {
    const p = await createProject(env.DB, 'tnt_p1', { name: 'cascade' });
    await createMilestone(env.DB, 'tnt_p1', p.id, { name: 'alpha' });
    expect(await listMilestones(env.DB, 'tnt_p1', p.id)).toHaveLength(1);
    expect(await deleteProject(env.DB, 'tnt_p1', p.id)).toBe(true);
    expect(await listMilestones(env.DB, 'tnt_p1', p.id)).toHaveLength(0);
  });

  it('cannot be attached to a project in another tenant', async () => {
    const theirs = await createProject(env.DB, 'tnt_p2', { name: 'theirs' });
    await expect(createMilestone(env.DB, 'tnt_p1', theirs.id, { name: 'sneaky' })).rejects.toThrow();
  });

  it('order by sortOrder, breaking ties by name so the list is stable between reads', async () => {
    const p = await createProject(env.DB, 'tnt_p1', { name: 'ordered' });
    await createMilestone(env.DB, 'tnt_p1', p.id, { name: 'beta', sortOrder: 1 });
    await createMilestone(env.DB, 'tnt_p1', p.id, { name: 'alpha', sortOrder: 1 });
    await createMilestone(env.DB, 'tnt_p1', p.id, { name: 'zero', sortOrder: 0 });
    expect((await listMilestones(env.DB, 'tnt_p1', p.id)).map((m) => m.name)).toEqual([
      'zero', 'alpha', 'beta',
    ]);
  });
});
```

Follow `capabilities.ts`: hand-written SQL, `tenant_id = ?` first, always. The last test earns its place — without a tie-break, two milestones sharing a `sortOrder` come back in whatever order SQLite chooses, and a list that reshuffles between reads looks like a bug in the UI.

- [ ] **Step 3: Run and commit**

```bash
git add apps/api/migrations/0012_projects_and_milestones.sql apps/api/src/db/projects.ts apps/api/test/projects.test.ts
git commit -m "feat(projects): projects, milestones and a rollup cache in D1"
```

---

## Task 19: Card membership, and the fan-out rollup

**Files:**
- Modify: `apps/api/src/board/board-do.ts` — `project_id` / `milestone_id` columns, `CardView` fields, `projectSummary()`
- Modify: `apps/api/src/db/projects.ts` — `computeRollup`
- Modify: `apps/api/src/index.ts` — `GET /v1/projects/:id/rollup`, and the `scheduled()` refresh
- Test: `apps/api/test/project-rollup.test.ts` (create)

**Interfaces:**
- Produces: `projectSummary(projectId): Promise<{ total: number; done: number; overdue: number; costUsd: number }>` on the DO; `computeRollup(db, env, tenantId, projectId)` in D1.
- Consumes: `listAllBoards(env.DB)` — the same helper `scheduled()` already uses (`apps/api/src/index.ts:1601`).

- [ ] **Step 1: The columns**

Guarded ALTERs for `project_id TEXT` and `milestone_id TEXT`, both into `CardView` and `rowToCard`, plus `CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(project_id)`. Membership is stored on the card in its own DO, so adding a card to a project is a single-DO write — there is no distributed transaction anywhere in this design.

- [ ] **Step 2: Validation, in the route**

`milestone_id` must belong to the card's `project_id`. The DO cannot check it; the route can, the same shape as Task 4's label check. Refuse with `MILESTONE_NOT_IN_PROJECT`.

- [ ] **Step 3: Tests for the rollup**

```ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { BoardDO, type BoardInit } from '../src/board/board-do';
import { createProject, computeRollup } from '../src/db/projects';

const STAGES: BoardInit['stages'] = [
  { key: 'draft', name: 'Draft', order: 0, ownerKind: 'capability', owner: 'writing' },
];

function stubFor(name: string): DurableObjectStub<BoardDO> {
  return env.BOARD_DO.get(env.BOARD_DO.idFromName(name)) as unknown as DurableObjectStub<BoardDO>;
}

/** Register a board in the catalog so `listAllBoards` finds it, then seed it into the project. */
async function seedBoard(name: string, projectId: string, titles: string[]): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json) VALUES (?, 'tnt_r', ?, '[]')`,
  )
    .bind(`brd_${name}`, name)
    .run();
  await runInDurableObject(stubFor(name), async (board: BoardDO) => {
    await board.init({ id: `brd_${name}`, tenantId: 'tnt_r', name, stages: STAGES });
    for (const title of titles) {
      const c = await board.createCard({ title, ownerUserId: 'usr_a' });
      if (!c.ok) throw new Error(c.message);
      await board.updateCard(c.value.id, { projectId });
    }
  });
}

beforeAll(async () => {
  await env.DB.prepare(`INSERT OR IGNORE INTO tenants (id, slug, name) VALUES ('tnt_r', 'rollup', 'Rollup')`).run();
});

describe('project rollup', () => {
  it('counts cards across two boards', async () => {
    const p = await createProject(env.DB, 'tnt_r', { name: 'across' });
    await seedBoard('rollA', p.id, ['One', 'Two']);
    await seedBoard('rollB', p.id, ['Three']);
    const r = await computeRollup(env.DB, env, 'tnt_r', p.id);
    expect(r.cardsTotal).toBe(3);
    expect(r.partial).toBe(false);
  });

  it('counts a card done only when RESOLVED, not merely terminal', async () => {
    const p = await createProject(env.DB, 'tnt_r', { name: 'resolved-only' });
    await seedBoard('rollC', p.id, ['Will fail', 'Will finish']);

    await runInDurableObject(stubFor('rollC'), async (board: BoardDO) => {
      const first = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!first.claimed) throw new Error('expected a claim');
      await board.fail({ runId: first.runId, leaseEpoch: first.leaseEpoch, reason: 'nope' });

      const second = await board.claim({ agentId: 'agt_w', capabilities: ['writing'] });
      if (!second.claimed) throw new Error('expected a second claim');
      await board.complete({
        runId: second.runId,
        leaseEpoch: second.leaseEpoch,
        handoff: { summary: 'ok' },
      });
    });

    const r = await computeRollup(env.DB, env, 'tnt_r', p.id);
    expect(r.cardsTotal).toBe(2);
    // The failed card is terminal but NOT done. Counting it as done would report a project
    // complete while half its work failed — the same trap as Task 12's isResolved/isTerminal.
    expect(r.cardsDone).toBe(1);
  });

  it('records computed_at, and caches it', async () => {
    const p = await createProject(env.DB, 'tnt_r', { name: 'stamped' });
    await seedBoard('rollD', p.id, ['One']);
    const before = Date.now();
    const r = await computeRollup(env.DB, env, 'tnt_r', p.id);
    expect(new Date(r.computedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const cached = await env.DB.prepare(
      `SELECT computed_at FROM project_rollups WHERE project_id = ?`,
    )
      .bind(p.id)
      .first<{ computed_at: string }>();
    expect(cached?.computed_at).toBe(r.computedAt);
  });

  it('survives one board failing to answer, and says the rollup is partial', async () => {
    const p = await createProject(env.DB, 'tnt_r', { name: 'partial' });
    await seedBoard('rollE', p.id, ['One']);
    // A catalog row whose Durable Object was never initialised: `projectSummary` throws on it.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO boards (id, tenant_id, name, stages_json)
         VALUES ('brd_ghost', 'tnt_r', 'ghost', '[]')`,
    ).run();

    const r = await computeRollup(env.DB, env, 'tnt_r', p.id);
    // It must NOT throw, and must NOT report a confident total.
    expect(r.partial).toBe(true);
    expect(r.boardsUnanswered).toBe(1);
    expect(r.cardsTotal).toBe(1);
  });
});
```

The last one is the one that matters. A fan-out over many DOs where one throws must not return a confidently wrong total: mark the rollup `partial`, count the boards that did not answer, and let the UI say so (Task 20, Step 2). Silently under-counting a project's cost is exactly the failure `overBudget` exists to prevent elsewhere.

- [ ] **Step 4: Implement**

`computeRollup` walks `listAllBoards`, calls `projectSummary(projectId)` on each board stub, sums, and writes `project_rollups`. `GET /v1/projects/:id/rollup` returns the cached row, recomputing when `computed_at` is older than 60s. `scheduled()` refreshes every project's rollup on the five-minute tick, in its own try/catch beside the other two arms.

- [ ] **Step 5: Run and commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(projects): card membership and a cached cross-board rollup that admits when it is partial"
```

---

## Task 20: Projects in the UI and in `supi`

**Files:**
- Create: `apps/web/src/lib/components/plan/ProjectView.svelte`
- Modify: `apps/web/src/lib/components/plan/PlanView.svelte` (a third view toggle beside Board and List), `FilterBar.svelte`, `CardDrawer.svelte`, `api.ts`
- Modify: `packages/cli/src/index.ts` — `supi project list|add|show|rm`, `supi milestone add|rm`

- [ ] **Step 1: The view**

`PlanView` currently toggles Board / List (`plan/PlanView.svelte:17-33`). Add **Projects**, following the exact markup of the two existing buttons so the control stays one component and one style.

Per project: name, state, health, target date, a progress bar from `cards_done / cards_total`, cost, and its milestones in `sortOrder`.

- [ ] **Step 2: Say when the numbers are from — required, not optional**

Under every rollup: `as of 14:32`, from `computed_at`. If the rollup is `partial`, say `as of 14:32 · incomplete (1 board did not answer)`. A cross-board number presented as live is the one dishonesty this design would otherwise introduce.

- [ ] **Step 3: Filter and assign**

A project filter in `FilterBar` (cards carry `projectId`), and a project + milestone picker in `CardDrawer`. The milestone picker lists only the chosen project's milestones — the server refuses the mismatch (Task 19) and the UI should not offer it.

- [ ] **Step 4: Run, commit**

Run: `cd apps/web && pnpm check && pnpm test` and `cd packages/cli && pnpm test`

```bash
git add apps/web/src packages/cli/src
git commit -m "feat(projects): a Projects view, filters, and supi project verbs"
```

---

## Task 21: Correct the documentation, then prove Phase 4

The docs are wrong in ways this work has now established. Leaving them wrong is how the next person repeats today's mistake of designing from a stale document.

**Files:**
- Modify: `docs/13-linear-parity-program.md`, `docs/01-domain-model-and-glossary.md`, `docs/03-card-lifecycle.md`

- [ ] **Step 1: Fix `docs/13`**

- `:83` — due dates are **not** `✗`. They ship, and after this plan they are a column with claim-order weight. Update the row.
- The RBAC line claiming roles "exist in the catalog but aren't enforced" — they are enforced. Correct it.
- P22 (Cycles) — mark **declined**, with the reason: a cycle is a commitment device for humans negotiating scope against their own week, and agents have no week. Close the open question rather than leaving it to be re-asked.
- Add rows for labels, dependencies, sub-tasks, projects and milestones, marked shipped.
- Add **recurrence** to the surface map. The word does not appear in the document at all today, which is why the gap was invisible.

- [ ] **Step 2: Fix `docs/01`**

- The Card entity lists `labels` and `archivedAt` — remove the ⚠️ implying they are unimplemented, and delete `currentTaskId` (Task 2 removed it from the contract).
- Add `Label`, `Project`, `Milestone`, `CardLink` and `Schedule` to the entity list and the glossary.
- Keep the Task ⚠️ exactly as it is. Task is still unimplemented and that warning is still load-bearing.

- [ ] **Step 3: Fix `docs/03`**

Add a short section on what stops a card advancing: an open child, and (for a claim) an unresolved blocker. State the resolution rule — `completed` or `canceled`, not merely terminal — in the normative state-transition table, so the next reader finds it there rather than in a comment.

- [ ] **Step 4: Commit, PR, and the live check**

```bash
git add docs/
git commit -m "docs: record what shipped, decline cycles, and correct two stale claims in 13"
git push -u origin feat/planning-phase4-projects
gh pr create --title "feat: projects and milestones" --body "<see plan>"
```

Then, live:

1. Create a project and put cards from **two different boards** in it.
2. Confirm the rollup counts both, and shows an "as of" time.
3. Add a milestone; confirm a card from the other board can join it, and that a card whose project differs is refused.
4. Leave it ten minutes and confirm the cron refresh moves `computed_at` without anyone opening the page.

- [ ] **Step 5: Station the three idle boards**

The boards this work was for — **Production Releases** (`brd_2441b5578f704b93`), **Recurring Maintenance** (`brd_24280cb0c7614d36`), **Guild Operations & Automation** (`brd_af3fde184dd84d90`) — have bare stages with an `owner` only: no instructions, no completion rules, no cards. A schedule firing onto a stage with no instructions produces a card no agent can usefully work.

Give each stage instructions and a completion rule before relying on any of it. That is configuration, not code, and it is the last thing standing between this plan and the boards doing real work.

---

## Self-review notes

Run before starting, and re-read at each phase boundary.

- **Spec coverage.** All seven constructs plus the contract cleanup have tasks: labels (4), due dates (3, 5), recurrence (8–11), dependencies (12, 13, 16), sub-tasks (14, 15), projects (18–20), milestones (18–20), cleanup (2). Spec §4's exclusions have no tasks, correctly.
- **The one thing most likely to go wrong** is `isResolved` being "simplified" into `isTerminal`. Task 12 has a test asserting they disagree and Task 13 has a live check for it. If a reviewer suggests unifying them, point at `enf-failed`.
- **The one thing most likely to break production** is Task 5's claim-order change. It ships alone, in the first phase, with a live check, and not bundled with anything else.
- **Types used before they are defined:** `LinkRow`/`isResolved` (Task 12) are consumed in 13, 14, 16; `Rule`/`nextFireAt` (Task 8) in 9; `LabelRecord` (Task 4) in 6 and 7; `ProjectRecord` (Task 18) in 19 and 20. Each is defined in an earlier task than its consumers.
- **`rowToCard` now runs up to five extra queries per card.** Task 14 flags it and names the fix (`pre?`). If a board read gets slow, that is the cause and it is not a mystery.
- **Phases 1 and 2 are shippable without 3 and 4**, and 3 without 4. Each phase is its own PR and its own live check.

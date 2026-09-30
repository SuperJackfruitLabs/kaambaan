# Planning constructs & recurrence — design

**Date:** 2026-09-30
**Scope:** seven constructs — labels, due dates, dependencies, sub-tasks, projects,
milestones, recurrence — plus the contract drift that blocks the first of them.
**Out of scope, deliberately:** the vocabulary rename. See §7.

## 0. Evidence basis

Every claim about current behaviour below was checked against code on 2026-09-30, not
against [13](../../13-linear-parity-program.md), which is stale in two places:

- `13:83` records due dates as `✗`. They exist — `spec.due`, written by `ComposeSheet`
  and `CardDrawer`, rendered with an overdue marker at `CardTile.svelte:105-109`.
- `13` says RBAC roles "exist in the catalog but aren't enforced". They are enforced.

`13` never uses the word *recurring*. The `Recurring Maintenance` board
(`brd_24280cb0c7614d36`) is therefore a board named after a capability that was never
specified, not a deferred item. Correcting `13` is a task in the plan, not this spec's job.

Linear's behaviour, checked against its docs rather than recalled:

- Issue relations are `blocks` / `blocked by` / `related` / `duplicate`, and are **purely
  informational**. Nothing prevents working or completing a blocked issue.
- A sub-issue **may live in a different team** than its parent. It inherits team, priority
  and project as defaults; labels are not inherited.
- Parent completion is not blocked by open sub-issues. The only automation is the reverse,
  an optional team setting: parent done ⇒ remaining sub-issues done.
- There is no standalone checklist feature. A markdown checklist in the description
  converts to sub-issues with one command.

## 1. The spine: one consistency line

Cards live in **per-board Durable Objects**. That forces a split, and naming it up front is
most of this design:

| | stored in | consistency | may refuse a claim or an advance? |
|---|---|---|---|
| dependencies, sub-task edges, due dates, applied labels, schedules | board DO | strong | **yes** |
| projects, milestones, label catalogue, cross-board edges | D1 | eventual (fan-out snapshot) | no |

**The claim hot path never leaves the DO.** That is the invariant the whole design protects.
A cross-DO read on the claim path would be both slower and untrustworthy: a stale read can
refuse a card that just unblocked, or admit one that just became blocked.

### Why not simply copy Linear

Linear's advisory edges work because a human reads a sidebar and exercises judgement. Our
claimants are poll loops. **For an agent, an advisory edge is not a weaker enforced edge; it
is a no-op** — `analyst-echo` will claim a card badged "blocked by card A" within one poll
cycle and work it to completion, because nothing in the claim path reads the badge. This is
[13](../../13-linear-parity-program.md) §0's own thesis: these constructs encode *human*
cadence and must be adapted, not copied.

So we take Linear's expressiveness and add teeth where teeth are possible.

## 2. Decisions

| # | decision | rationale |
|---|---|---|
| **D-1** | Enforced ⇒ inside one board DO. Informational ⇒ D1. | §1 |
| **D-2** | Projects are **cross-board**, stored in D1. | A project confined to one board is indistinguishable from a label, and we are building labels. |
| **D-3** | Edges may cross boards. **Same-board edges live in the DO and are enforced; cross-board edges live in D1 and are advisory, and the UI says which it is.** | Linear parity on expressiveness, teeth where the claim path can be trusted, and no badge that lies. |
| **D-4** | A sub-task is a **real child card**. The "checklist" is markdown in the description plus a converter — not a second first-class mechanism. | Linear's own shape. A checklist item cannot be claimed, so it buys the pipeline nothing; a child card can be created by a planner agent over MCP, which is the point. |
| **D-5** | Recurrence fires from the **existing worker cron**, not the DO alarm. | A DO has exactly one alarm and this one already serves two jobs (lease reclaim + push drain — `board-do.ts:3025-3055`). The cron at `wrangler.jsonc:56` already walks every board. |
| **D-6** | The rename is **not decided and not in scope**. | §7 |
| **D-7** | Cycles/sprints are **declined**, closing `13` P22's open question. | A cycle is a commitment device for humans negotiating scope against their own week. Agents have no week. |

## 3. Construct by construct

### 3.0 Contract drift cleanup — prerequisite

`docs/01` carries explicit ⚠️ warnings that this drift is design intent, not accident, so
this is closing a known gap rather than fixing a lie.

| declared | where | reality | action |
|---|---|---|---|
| `Card.labels` | `packages/contract/src/entities.ts:178` | zero occurrences of `labels` in `board-do.ts` and in the web `Card` type | **implement** (§3.2) |
| `Card.archivedAt` | `entities.ts:180` | no column | **implement** — a board fills up, and it is one column plus a filter |
| `Card.currentTaskId` | `entities.ts:177` | `Task` is unimplemented by documented design intent | **delete from the contract**; `docs/01` already warns readers off it |
| `Stage.completion` | on the DO at `board-do.ts:115`, absent from the contract `Stage` at `entities.ts:79-107` | shipped and enforced | **add to the contract** |

Because `Card.labels` already carries `.default([])`, adding storage is wire-compatible —
no consumer breaks.

### 3.1 The DO column-migration pattern

Every new DO column follows the established guard (`board-do.ts:919-923`):

```ts
try {
  this.sql.exec(`ALTER TABLE cards ADD COLUMN due_at TEXT`);
} catch {
  // column already exists
}
```

There is no schema-version table in the DO; idempotent DDL *is* the migration. New tables
use `CREATE TABLE IF NOT EXISTS`. This runs on DO construction, so it is exercised by every
test that opens a board.

### 3.2 Labels

**D1 catalogue**, following the precedent of capabilities (`apps/api/src/db/capabilities.ts`):

```sql
CREATE TABLE labels (
  id         TEXT PRIMARY KEY,      -- lbl_<16 hex>
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  colour     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);
```

**Applied labels** live on the card in the DO: `labels TEXT NOT NULL DEFAULT '[]'`, a JSON
array of label **ids**. Ids rather than names, so renaming a label does not orphan cards.

Validation on write is one D1 read against the tenant's catalogue. That is a cold path
(card create/update), never the claim path.

**Deletion is permissive:** a deleted label may leave stale ids on cards. Readers ignore
unknown ids and `GET /v1/labels` returns only live ones. Refusing deletion while a label is
in use would require a fan-out across every board DO to answer, which is a lot of machinery
to prevent a cosmetic condition.

- API: `GET|POST /v1/labels`, `PATCH|DELETE /v1/labels/:id`; card labels via the existing
  `PATCH …/cards/:cardId`.
- UI: chips on `CardTile`, a filter in `FilterBar`, management in `/workspace`.

### 3.3 Due dates

Promote `spec.due` to `due_at TEXT` (an ISO **date**, matching what the UI writes today),
with an index. Backfill from `spec.due` on migration; stop writing the blob.

Three consequences, because a field with no consequence is worse than no field:

1. **Claim order.** `board-do.ts:2224` becomes:

   ```sql
   ORDER BY priority DESC, (due_at IS NULL), due_at ASC, created_at ASC
   ```

   The `(due_at IS NULL)` term rather than `NULLS LAST` — portable across SQLite versions
   and unambiguous. The same ordering applies to the all-cards read at `board-do.ts:3235`.

   ⚠️ **This changes which card a live agent claims next.** It ships with the Press board's
   owner informed, and with a live-run check, not only a unit test.

2. **An overdue notification**, into the existing `notifications` table (`seq, kind,
   card_id, user_id, body, read, created_at` — `board-do.ts:954`), addressed to the card
   owner. Computed on the cron tick that §3.8 already introduces, so it costs one extra
   query per board and no new machinery. Fired once per card per crossing, guarded by a
   `overdue_notified_at` column so a five-minute tick cannot spam.

3. **Server-side sort and filter**, which a JSON blob could not support.

**⚠️ Promoting `due` out of `spec` removes it from every agent's prompt.** AgentPod builds the
prompt (`agentpod/packages/contract/src/card-prompt.ts`, `card-prompt/3`) and passes
`card.spec` through wholesale, so `spec.due` reaches agents today. Moving it to a column
takes it away.

**Decision: accept the removal, deliberately.** No agent has ever acted on a due date — it is
a dispatch concern, and by the time an agent holds the card the pipeline has already decided
to hand it over. Mirroring the value back into `spec` to preserve the prompt would create two
sources of truth for one fact, which is the condition we are removing. Recorded here so it is
an intended removal and not a silent regression; if an agent ever needs it, the fix is a
`card-prompt/4` field, in agentpod, as its own change (§9).

### 3.4 Dependencies and sub-tasks — one table

Both constructs are the same table in the board DO, which is why they are one task:

```sql
CREATE TABLE IF NOT EXISTS card_links (
  from_card_id TEXT NOT NULL,
  to_card_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,     -- 'blocks' | 'relates' | 'parent'
  created_at   TEXT NOT NULL,
  created_by   TEXT,              -- user or agent id
  PRIMARY KEY (from_card_id, to_card_id, kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS card_links_one_parent
  ON card_links (to_card_id) WHERE kind = 'parent';
```

Direction is always **from → to**: `blocks` means *from* blocks *to*, so *to* is the blocked
card; `parent` means *from* is the parent of *to*.

#### Resolution semantics — the detail that matters

A blocker is resolved when its state is **`completed` or `canceled`**, not merely terminal.
`TERMINAL_STATES` (`packages/contract/src/primitives.ts:20`) is `['completed', 'rejected',
'failed', 'canceled']` — a blocker that **`failed` or was `rejected` keeps the dependent
blocked**, which is the entire usefulness of the edge. `isTerminal()` is the wrong predicate
here and using it would be a silent bug.

#### Enforcement

- **Claim excludes, it does not refuse.** `claim` (`apps/api/src/mcp/tools.ts:131`) takes
  `boardId` + `maxConcurrency` and **no `cardId`** — the server picks the card
  (`board-do.ts:2218-2224`). So enforcement is one `AND NOT EXISTS (…)` clause on that
  `SELECT`, and a blocked card is simply never handed out. **No new refusal code reaches a
  claimant, and no caller outside this repo changes.** It also cannot produce a
  claim/refuse hot-loop, which a refusal code could.

  The cost is that an agent cannot distinguish "blocked" from "no work" — both are
  `{claimed:false}`. That is correct for the poll loop but means **the board UI carries the
  whole explanation**: a blocked card must show its blocker, and a stage's blocked count must
  be visible, or work will appear to have stalled for no reason.
- **Advance** past a stage is refused while any `parent`-linked child is unresolved. This
  one *is* a refusal, with a new code `CARD_BLOCKED`, because advancing is an explicit act by
  a named caller rather than a card being selected from a set.
- **A human move is allowed**, with a recorded activity. Principle 3 says a human owns and
  is accountable; refusing a human's move to protect them from an edge they can see is the
  advisory case, and here Linear is right.
- `relates` enforces nothing.

#### Cycle safety

An edge that would create a cycle among `blocks` + `parent` is refused at write time, by a
breadth-first walk with a seen-set — the pattern already in `apps/api/src/db/implications.ts:85`.

#### Child cards

A child is a card in every respect: its own stage, runs, cost, delegate, and claimability.
On creation it inherits **priority, `project_id`, `milestone_id`** and its board (forced —
same-board, per D-3). Labels are **not** inherited, matching Linear.

Cost rolls up as a **new** field `costUsdRollup = own + Σ children`. `costUsd` keeps its
current meaning untouched, because `overBudget` is computed from it against a per-card cap
and silently changing that number would move a budget gate.

#### The checklist, and the converter

A markdown checklist in the description costs nothing — it already renders. What we add is
the conversion:

- `POST /v1/boards/:id/cards/:cardId/split` with the chosen lines ⇒ child cards.
- An MCP tool so a **planner agent can decompose a card it is working on**. This is the
  construct's real value: decomposition becomes something the pipeline can do, not something
  a human does for it.

#### Cross-board edges (advisory)

Stored in D1, never consulted by the claim path:

```sql
CREATE TABLE card_links_external (
  tenant_id      TEXT NOT NULL,
  from_board_id  TEXT NOT NULL, from_card_id TEXT NOT NULL,
  to_board_id    TEXT NOT NULL, to_card_id   TEXT NOT NULL,
  kind           TEXT NOT NULL,   -- 'blocks' | 'relates'
  created_at     TEXT NOT NULL,
  PRIMARY KEY (from_card_id, to_card_id, kind)
);
```

The UI must render these **differently** from enforced edges — "blocked by X (advisory —
not enforced across boards)" — and must never show the two with one badge. A badge that
sometimes lies is worse than two honest badges.

**`parent` is deliberately absent from the cross-board kinds, and this diverges from Linear**,
which lets a sub-issue live in another team. The reason is that a parent edge carries a real
rule — a parent may not advance while a child is open — and an advisory parent edge would be
a containment relationship that silently fails to contain. A card decomposed across boards is
better expressed as a project (§3.5), which is honest about being a grouping. If this proves
too strict in use, the cheapest relaxation is to allow cross-board `parent` **for display and
rollup only**, with the advance rule still reading same-board children — but it should be
added on evidence, not in advance.

### 3.5 Projects

D1, cross-board (D-2):

```sql
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,   -- prj_<16 hex>
  tenant_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  target_date  TEXT,
  state        TEXT NOT NULL,      -- planned|active|paused|completed|canceled
  health       TEXT,               -- on-track|at-risk|off-track
  lead_user_id TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT
);
```

Membership is `project_id TEXT` **on the card, in its own DO**. That keeps adding a card to
a project a single-DO write — no distributed transaction, no cross-DO write anywhere in the
design.

**Rollups are a fan-out and are labelled as such.** Progress, cost and overdue counts are
computed by reading each board in the tenant, exactly as `listAllBoards(env.DB)` already
does on the cron tick (`apps/api/src/index.ts:1601`). Cached in D1 with a `computed_at`,
refreshed on the cron tick or on a read older than 60s. **The UI shows "as of HH:MM".** A
project rollup is a snapshot, and saying so is cheaper than pretending otherwise.

### 3.6 Milestones

D1, project-scoped, ordered:

```sql
CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,    -- mls_<16 hex>
  project_id  TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  target_date TEXT,
  sort_order  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
```

Cards carry `milestone_id`, validated to belong to the card's project. Project progress is
the fraction of milestones whose cards are all resolved.

### 3.7 Recurrence

A `schedules` table in the board DO:

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id             TEXT PRIMARY KEY,  -- sch_<16 hex>
  enabled        INTEGER NOT NULL DEFAULT 1,
  title          TEXT NOT NULL,     -- card template
  spec_json      TEXT,
  priority       INTEGER NOT NULL DEFAULT 0,
  labels         TEXT NOT NULL DEFAULT '[]',
  stage_key      TEXT,              -- target stage; NULL = first stage
  rule           TEXT NOT NULL,     -- see grammar below
  timezone       TEXT NOT NULL,     -- IANA
  overlap        TEXT NOT NULL,     -- 'skip' | 'allow'
  next_fire_at   TEXT NOT NULL,
  last_fired_at  TEXT,
  last_card_id   TEXT,
  skip_count     INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT,
  created_at     TEXT NOT NULL
);
```

**A restricted grammar, not full cron.** `every <n> minutes|hours|days`, `daily at HH:MM`,
`weekly on <dow> at HH:MM`, `monthly on <d> at HH:MM`. This covers maintenance cadence
without a cron-parsing dependency, and a full parser can be added later behind the same
field. Stating the YAGNI rather than smuggling it.

**Firing** extends the existing `scheduled()` handler (`apps/api/src/index.ts:1598`), which
already iterates every board; it gains one call per board, `fireDueSchedules(now)`. The cron
is `*/5 * * * *`, so a schedule may fire **up to five minutes late** — an accepted property
for maintenance work, and it must be written in the UI next to the field so nobody reads
"daily at 09:00" as a real-time trigger.

**Creation goes through `createCardFromTrigger`** (`board-do.ts:1094`), which already
supplies the provenance reference and — the part that matters — the `queuedGrant` fallback
that makes an automated card claimable under enforcement. Without it, every scheduled card
would be created, appear on the board, and park forever on first claim.

**Idempotency.** `next_fire_at` advances in the same transaction as the card create, so a
double tick cannot double-create; if the create fails, `next_fire_at` does not advance and
the next tick retries.

**Overlap.** `skip` is the default: if `last_card_id` is unresolved, skip, increment
`skip_count`, and append to the DO's `events` table (`seq, type, payload_json, ts` —
`board-do.ts:819`) so the skip is **visible on the audit log rather than silent**. A
schedule quietly skipping for a month is the failure mode to design against.

**Timezone** uses `Intl.DateTimeFormat` with an IANA zone. ⚠️ To verify in the plan's first
task: timezone support in `workerd`'s ICU build. If it is absent, the fallback is UTC-only
plus a fixed offset field, and that changes the UI.

UI: a Schedules section in the existing `/b/[boardId]/settings`.

## 4. Not included

- **Cycles / sprints** (D-7), closing `13` P22.
- Roadmap / timeline / calendar views (`13` P23).
- `13`'s two foundational decisions — D1 the Team container, D2 the status axis. Nothing
  here depends on either, which is deliberate: this spec is buildable while both stay open.
- A real `Task` record (the third hierarchy level). Untouched.
- Full cron grammar; cross-board enforcement; label-deletion integrity.

## 5. Risks

1. **The claim-order change is a live behaviour change** on a board that runs unattended.
   Highest-risk item here despite being the smallest diff.
2. **Fan-out rollups scale with board count.** Fine at a handful; a tenant with hundreds
   needs an index of which boards hold which project's cards.
3. **Applied labels as a JSON array** have no relational integrity. Accepted, with
   permissive reads.
4. **`Intl` timezone support in workerd** is assumed, not verified (§3.7).
5. **Two edge stores** (DO + D1) is a real cost, justified only by the claim-path invariant.
   If that invariant is ever abandoned, collapse them.

## 5b. Repository boundary

**Everything in this spec is superpipeline-only**, including the CLI — `supi` lives in
`packages/cli` of this repo, so new verbs are in-repo.

Verified, not assumed:

- **AgentPod's bridge needs no change.** `claim` (`apps/api/src/mcp/tools.ts:131`) takes
  `boardId` + `maxConcurrency` and no `cardId`, so dependency enforcement is a `WHERE` clause
  and the bridge keeps receiving `{claimed:false}` exactly as it does for "no work" (§3.4).
  The bridge only claims and reports; it neither creates cards nor reads card fields.
- **supermessage needs no change.** It renders gates and activities, neither of which changes
  shape here.

Two **optional, separate** follow-ons, neither a dependency of any phase:

1. **agentpod `card-prompt/4`** — if an agent should see labels, a due date, its parent, or
   its open children. Requires a coordinated contract change in agentpod and is the only
   reason this work would ever touch a second repository.
2. **estate** — a session document, per established practice.

## 6. Phasing

| phase | contents | why here |
|---|---|---|
| 1 | contract cleanup, labels, due dates, `archivedAt` | All DO-local column work; immediately visible; closes documented drift |
| 2 | recurrence | Makes three named boards real, and reuses two pieces that already exist |
| 3 | dependencies + sub-tasks + the converter | One table, one predicate, shared |
| 4 | projects + milestones | New D1 storage and the only fan-out reads; largest, least urgent |

## 7. The rename, parked

`board → pipeline` and `gate → valve` are **undecided**. Two findings for whenever that
conversation resumes:

- **`pipeline` is already taken.** `docs/01:134` — a Board *contains* one Pipeline, and
  Pipeline is its own entity (the ordered list of Stages). `board → pipeline` is therefore a
  **merge of two existing concepts**, not a substitution.
- Measured surface, excluding vendored and worktree directories, across superpipeline +
  agentpod + supermessage + estate: `board` 3,304 occurrences / 360 files; `card` 3,876 /
  569; `gate` 2,717 / 477; `stage` 1,180 / 190. An unread `docs/RENAME-PLAN.md` also exists.

Nothing in this spec depends on the outcome. It uses today's vocabulary throughout, so the
rename stays a separate mechanical change.

## 8. Testing

Per [09](../../09-testing-strategy.md), plus one rule this session earned the hard way:
**every phase ends with a live run on a real board, not only unit tests.** Bug #625 was
invisible to every unit test because they posted activities to a board still accepting them;
only a live run found it. Specifically:

- Phase 1: a card claimed in due-date order on a live board, observed.
- Phase 2: a schedule fires, and a second tick during an open instance records a visible skip.
- Phase 3: an agent's claim **refused** with `CARD_BLOCKED`, and a planner agent decomposing
  a card over MCP.
- Phase 4: a rollup crossing two boards, with its "as of" label.

# Audit remediation implementation plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every finding in the 2026-09-02 feature audit — the things built
that do not work, the fields written once with no way to change them, the
authority recorded and never checked, and the code with no caller.

**Architecture:** Three surfaces, in this order per wave — the Board Durable
Object (`apps/api/src/board/board-do.ts`) owns board state; the Worker
(`apps/api/src/index.ts`) owns routing and authentication; the SvelteKit SPA
(`apps/web`) owns the operator's view. Nothing new is introduced: every fix
either wires an existing field to a caller, or deletes it.

**Tech Stack:** Cloudflare Workers + D1 + Durable Objects, TypeScript,
SvelteKit/Svelte 5, vitest (`@cloudflare/vitest-pool-workers`).

**Source:** the audit at
https://claude.ai/code/artifact/be2a0e0d-0c78-48fa-b00a-906e034427fe

## Global constraints

- **Baseline:** `pnpm -r test` is green at 566 tests — contract 59, api 470,
  web 37. Run the full suite before every commit; never commit a red tree.
- **Fail closed.** Every authorization change must refuse on missing data, not
  admit. A missing grant, a missing role, a missing scope: all refusals.
- **`null` stays an ordinary answer.** A standalone kaambaan with no hub, no
  principal links and no grants must keep working exactly as it does today.
  No change here may make hub authority mandatory.
- **Comments explain WHY,** matching the density already in these files.
- **Migrations are append-only and numbered** — next free number is 0005.
- **Do not touch the database named `rehearsal`.**
- Deployment is a separate, explicit step. This plan ends at a green branch.

## Rulings taken before execution

The audit names findings; several admit more than one fix. These are settled
here so no task stalls on them.

1. **Trigger grants come from the board, not the request.** A GitHub webhook
   carries no human, so the grant must have been recorded earlier — by the
   person who wired the repository to the board. `PUT /v1/boards/:id/github`
   and `POST /v1/boards/:id/triggers` are already human-authenticated, so the
   grant is captured there and stored as board meta.
2. **Capabilities are offered from the board's own stages,** not a hardcoded
   list and not a new registry. The stages already name the capabilities they
   require (`stage.owner` where `ownerKind === 'capability'`); that union, plus
   free text, is the picker.
3. **Token scopes are enforced, not deleted** — with `claim` grandfathered to
   cover the run verbs that follow from a claim, because a claim an agent
   cannot finish is worse than no check at all. New tokens mint
   `['claim', 'run']`.
4. **Membership roles are enforced, and a workspace gets more than one
   person** — invite by email against the existing `users` table, no mail
   sending. `viewer` reads; `member` works cards; `admin` manages agents and
   boards; `owner` additionally manages members and the fleet link.
5. **Dead code is connected where a caller exists, and deleted where none can.**
   - `BoardDO.getEvents`, `gates.comment`/`decided_by`, the palette rows,
     `agents.icon_url`, `agents.concurrency`, `push/dispatch` → connected.
   - `webhooks` table, `agents.status`, `agents.connection_json`,
     `CatalogRepository`, `auth/principal.ts`,
     `references/github-graphql.ts` → deleted. `github-graphql` cannot be
     connected: reconciliation needs a GitHub App installation token and
     kaambaan stores no GitHub token at all (`auth/github.ts` discards it after
     reading the profile). Its encoded correctness traps move to `docs/06`
     before the code goes.
   - `adapters/claude-code.ts` moves to `packages/agent-sdk`, where the
     external bridges that would call it can actually import it.
   - `tenantScopedSelect` is kept and **adopted** — it is the isolation guard,
     and a guard nothing routes through guards nothing. `CatalogRepository`
     was only an unused wrapper around three of its calls.
6. **Stage keys are identity.** Stages become editable in every field except
   `key`; a stage may be added, reordered, retitled and retuned, and removed
   only when empty. Renaming a key is add-plus-remove, not an edit — a silent
   key change would orphan every card sitting in it.

---

## Wave 1 — The pipeline turns over

### Task 1: Trigger-born cards carry a grant

**Files:**
- Modify: `apps/api/src/board/board-do.ts` (`createCardFromTrigger`,
  `setGithubConfig`, the `TriggerGrant` meta, the `BoardDOApi` interface)
- Modify: `apps/api/src/index.ts` (`github` and `triggers` routes)
- Test: `apps/api/test/board-triggers.test.ts`,
  `apps/api/test/control-pair-claim.test.ts`

**Interfaces:**
- Produces: `setGithubConfig(input: { secret?, issueTrigger?, triggerGrant?: string[] | null })`;
  `createCardFromTrigger(input: { …, queuedGrant?: string[] | null })`.

- [ ] **Step 1: Failing test** — a card created by `createCardFromTrigger` with
      no grant, on a board whose `triggerGrant` meta is set, is claimable by an
      agent named in that grant under `ENFORCE_CONTROL_PAIR`.
- [ ] **Step 2:** `createCardFromTrigger` passes
      `input.queuedGrant ?? this.triggerGrant()` into `createCard`.
- [ ] **Step 3:** `setGithubConfig` accepts and stores `triggerGrant`;
      the `github` route sends `user?.mayDispatch ?? null`; the `triggers`
      route sends `user?.mayDispatch ?? null` as `queuedGrant`.
- [ ] **Step 4:** Board snapshot exposes `triggerGrantCount` so the UI can say
      whether automation is authorised, without leaking the principal ids.
- [ ] **Step 5:** Full suite, commit.

### Task 2: Capabilities are editable, and offered from the board

**Files:**
- Modify: `apps/api/src/db/catalog.ts` (`updateAgent`)
- Modify: `apps/api/src/index.ts` (`PATCH /v1/agents/:id` accepts
  `name`, `capabilities`, `iconUrl`, `concurrency`)
- Modify: `apps/web/src/lib/api.ts`, `apps/web/src/lib/components/BoardScreen.svelte`
- Test: `apps/api/test/agents-rest.test.ts`, `apps/web/src/lib/api.test.ts`

- [ ] **Step 1: Failing test** — `PATCH /v1/agents/:id` with
      `{ capabilities: ['code','test'] }` returns 200 and the next
      `GET /v1/agents` reflects it.
- [ ] **Step 2:** `updateAgent(db, tenantId, agentId, patch)` — tenant-scoped
      UPDATE, partial, returning the updated `AgentRecord`.
- [ ] **Step 3:** Route accepts the four fields alongside the existing
      `externalId`, each independently optional; validates `capabilities` is an
      array of non-empty strings and `concurrency` is a positive integer.
- [ ] **Step 4:** Web — the capability picker's options become the union of the
      board's stage capabilities plus the agent's current ones, with a free-text
      add. An "Edit" control on each agent row writes through `updateAgent`.
- [ ] **Step 5:** Full suite, commit.

### Task 3: A token can be minted for an existing agent

**Files:**
- Modify: `apps/api/src/index.ts` (`POST /v1/agents/:id/tokens`)
- Modify: `apps/web/src/lib/api.ts`, `BoardScreen.svelte`
- Test: `apps/api/test/agent-token-revocation.test.ts`

- [ ] **Step 1: Failing test** — revoke an agent's only token, then
      `POST /v1/agents/:id/tokens` returns 201 with a fresh `kbn_` that
      authenticates a claim.
- [ ] **Step 2:** Add the route inside the existing `agentsMatch` block,
      human-only (`resolveUser`), tenant-checked via `agentBelongsToTenant`,
      minting `['claim','run']`.
- [ ] **Step 3:** Web — "Issue a token" beside "Revoke", showing the plaintext
      once with the same copy affordance the create flow uses.
- [ ] **Step 4:** Full suite, commit.

## Wave 2 — Nothing is written once

### Task 4: Stages are mutable

**Files:**
- Modify: `apps/api/src/board/board-do.ts` (`setStages`)
- Modify: `apps/api/src/index.ts` (`PUT /v1/boards/:id/stages`)
- Modify: `apps/api/src/db/catalog.ts` (`updateBoardStages`)
- Modify: `apps/web/src/lib/components/BoardSettings.svelte`
- Test: `apps/api/test/board-settings.test.ts`

- [ ] **Step 1: Failing test** — renaming a stage's label, changing its WIP
      limit and adding a stage all persist; removing a stage that holds cards is
      refused with `STAGE_NOT_EMPTY`; a payload dropping a stage key that holds
      cards is refused whole.
- [ ] **Step 2:** `setStages(stages: StageDef[])` on the DO: validate keys are
      unique and non-empty, every removed key is empty, then replace the meta
      and emit `board.stages_changed`.
- [ ] **Step 3:** Add `STAGE_NOT_EMPTY` to `BoardErrorCode` → 409.
- [ ] **Step 4:** Route writes the DO first, then `updateBoardStages` on the
      catalog, mirroring the rename path.
- [ ] **Step 5:** Web — BoardSettings grows a stage editor reusing
      NewBoardDialog's row shape.
- [ ] **Step 6:** Full suite, commit.

### Task 5: Due dates, honest cost, assignment, and a real compose form

**Files:**
- Modify: `apps/api/src/board/board-do.ts` (`updateCard` accepts `ownerUserId`)
- Modify: `apps/api/src/index.ts` (card PATCH + POST body)
- Modify: `apps/web/src/lib/components/CardDrawer.svelte`,
  `board/CardTile.svelte`, `BoardScreen.svelte`, `lib/api.ts`
- Test: `apps/api/test/board-card-edit.test.ts`

- [ ] **Step 1: Failing test** — `PATCH` a card with `{ ownerUserId }`
      reassigns it and emits `card.updated`.
- [ ] **Step 2:** DO `updateCard` accepts `ownerUserId`; route passes it.
- [ ] **Step 3:** Web — CardDrawer gets a due-date input writing `spec.due`, an
      owner control with "Assign to me", and the compose form gains priority and
      description.
- [ ] **Step 4:** CardTile — `costBarPct` becomes cost against the card budget
      cap when one exists, and the bar is not rendered at all when none does; an
      overdue `spec.due` renders in the error state.
- [ ] **Step 5:** Full suite, commit.

## Wave 3 — Authority is checked

### Task 6: Token scopes are enforced

**Files:**
- Modify: `apps/api/src/auth/resolve.ts` (carry `scopes` on `AgentPrincipal`)
- Modify: `apps/api/src/index.ts` (scope gate on agent routes)
- Modify: `apps/api/src/db/catalog.ts` (`createAgentToken` default)
- Test: `apps/api/test/agent-token.test.ts`

- [ ] **Step 1: Failing test** — a token minted with `['run']` is refused at
      `POST …/claims` with 403; a legacy `['claim']` token still drives the run
      verbs; a `['claim','run']` token does both.
- [ ] **Step 2:** `AgentPrincipal.scopes` is populated from the token row.
- [ ] **Step 3:** `requiredScope(rest)` maps `claims` → `claim`, `runs/*` →
      `run`; a hub-issued agent token (no local scopes) is unaffected — its
      authority is the hub's, checked by the control pair.
- [ ] **Step 4:** New tokens mint `['claim','run']`.
- [ ] **Step 5:** Full suite, commit.

### Task 7: A workspace can have more than one person, and roles mean something

**Files:**
- Create: `apps/api/src/db/members.ts`
- Modify: `apps/api/src/auth/resolve.ts` (`UserPrincipal.role`),
  `apps/api/src/index.ts` (`/v1/members`, role gates)
- Modify: `apps/web/src/lib/api.ts`, `BoardScreen.svelte`
- Test: `apps/api/test/members-rest.test.ts` (new)

- [ ] **Step 1: Failing tests** — a `viewer` is refused card creation with 403;
      a `member` is refused agent creation; an `admin` is refused
      `PATCH /v1/tenant`; an `owner` may do all three. `GET /v1/members` lists
      them; `POST /v1/members` invites by email; `PATCH /v1/members/:id` changes
      a role; the last owner cannot be demoted or removed.
- [ ] **Step 2:** `listMembers`, `addMember`, `setMemberRole`, `removeMember`,
      `roleFor` in `db/members.ts`, all tenant-scoped.
- [ ] **Step 3:** `resolveUser`/`resolveHubUser` carry `role`; a hub-resolved
      user with no local membership is `viewer` — fail closed.
- [ ] **Step 4:** `requireRole(user, 'admin')` gates the mutating routes.
- [ ] **Step 5:** Web — a Members panel beside Agents.
- [ ] **Step 6:** Full suite, commit.

### Task 8: Notifications reach only their recipient

**Files:**
- Modify: `apps/api/src/board/board-do.ts` (`getNotifications`)
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/test/board-notifications.test.ts`

- [ ] **Step 1: Failing test** — a notification written for user A is absent
      from user B's feed; a notification with a null `user_id` reaches both.
- [ ] **Step 2:** `getNotifications({ unreadOnly, userId })` filters
      `user_id IS NULL OR user_id = ?`; an omitted `userId` keeps today's
      unfiltered behaviour for internal callers only.
- [ ] **Step 3:** Route passes `user.userId`.
- [ ] **Step 4:** Full suite, commit.

## Wave 4 — Connected, or gone

### Task 9: The board's event log becomes reachable

**Files:**
- Modify: `apps/api/src/index.ts` (`GET /v1/boards/:id/events`)
- Modify: `apps/web/src/lib/api.ts`, `Telemetry.svelte`
- Test: `apps/api/test/board-activities.test.ts`

- [ ] **Step 1: Failing test** — the route returns events newest-last with a
      `?limit=`.
- [ ] **Step 2:** Route + web activity feed.
- [ ] **Step 3:** Full suite, commit.

### Task 10: Gate decisions are readable

**Files:**
- Modify: `apps/api/src/board/board-do.ts` (gate read shape)
- Modify: `apps/web/src/lib/components/CardDrawer.svelte`
- Test: `apps/api/test/board-gates.test.ts`

- [ ] **Step 1: Failing test** — a resolved gate's `comment` and `decidedBy`
      appear in the card's gate view.
- [ ] **Step 2:** Add both to the gate row mapping and the `GateView` type.
- [ ] **Step 3:** CardDrawer renders "approved by X — comment".
- [ ] **Step 4:** Full suite, commit.

### Task 11: The palette's dead rows act

**Files:**
- Modify: `apps/web/src/lib/components/CommandPalette.svelte`
- Test: `apps/web/e2e/cmdk.spec.ts` (assertion only; e2e is not run in CI here)

- [ ] **Step 1:** An Agents row opens the agents panel focused on that agent;
      "Dispatch a card" focuses the compose field.
- [ ] **Step 2:** Full suite, commit.

### Task 12: The delivery queue drains on a schedule

**Files:**
- Modify: `apps/api/wrangler.jsonc` (`triggers.crons`)
- Modify: `apps/api/src/index.ts` (`scheduled` handler)
- Modify: `apps/api/src/db/catalog.ts` (`listAllBoards`)
- Test: `apps/api/test/board-push.test.ts`

- [ ] **Step 1: Failing test** — the scheduled handler drains every board's
      queue and reports totals.
- [ ] **Step 2:** `listAllBoards(db)` — deliberately unscoped, named so, with a
      comment saying a system cron has no tenant and must not fabricate one.
- [ ] **Step 3:** `scheduled()` iterates boards and calls
      `dispatchPushDeliveries()`; a failing board does not stop the sweep.
- [ ] **Step 4:** `"triggers": { "crons": ["*/5 * * * *"] }`.
- [ ] **Step 5:** Full suite, commit.

### Task 13: Dead columns and dead modules

**Files:**
- Create: `apps/api/migrations/0005_drop_unused.sql`
- Modify: `apps/api/src/db/tenant-scope.ts`, `apps/api/src/db/catalog.ts`
- Delete: `apps/api/src/auth/principal.ts` + test,
  `apps/api/src/references/github-graphql.ts` + test
- Move: `apps/api/src/adapters/claude-code.ts` → `packages/agent-sdk/src/claude-code.ts`
- Modify: `docs/06-*.md` (record the GraphQL traps before the code goes)
- Test: `apps/api/test/catalog.test.ts`, `apps/api/test/tenant-scope.test.ts`

- [ ] **Step 1:** Migration drops `webhooks`, `agents.status`,
      `agents.connection_json`; `webhooks` leaves `TENANT_SCOPED_TABLES`.
- [ ] **Step 2:** `listAgents`/`listBoards`/`agentBelongsToTenant` route their
      base select through `tenantScopedSelect`; `CatalogRepository` is deleted.
- [ ] **Step 3:** `icon_url` and `concurrency` join `AgentRecord`, are written
      by `updateAgent` (Task 2) and read by the claim default and the web avatar.
- [ ] **Step 4:** Deletions and the move, with the doc note.
- [ ] **Step 5:** Full suite, commit.

## Wave 5 — kaambaan's own standard

### Task 14: The board is operable from the keyboard

**Files:**
- Modify: `apps/web/src/lib/components/board/CardTile.svelte`,
  `BoardKanban.svelte`
- Test: `apps/web/e2e/board.spec.ts`

- [ ] **Step 1:** A focused card moves with `Alt+←`/`Alt+→`, and a "Move to…"
      menu offers every stage. Both announce via `aria-live`.
- [ ] **Step 2:** Full suite, commit.

### Task 15: Destructive actions are confirmed, and board delete cleans up

**Files:**
- Modify: `apps/api/src/board/board-do.ts` (`destroy`)
- Modify: `apps/api/src/index.ts` (board DELETE)
- Modify: `apps/web/src/lib/components/Topbar.svelte`, `BoardScreen.svelte`,
  `CardDrawer.svelte`
- Test: `apps/api/test/board-do.test.ts`

- [ ] **Step 1: Failing test** — after `DELETE /v1/boards/:id`, re-fetching the
      board's snapshot shows an uninitialised board with no cards.
- [ ] **Step 2:** `destroy()` clears every table and the meta, then
      `deleteAll()` on storage; the route calls it before `deleteBoard`.
- [ ] **Step 3:** Web confirmations for board, agent and card deletion, naming
      what is lost.
- [ ] **Step 4:** Full suite, commit.

### Task 16: The live connection recovers, and errors are actionable

**Files:**
- Modify: `apps/web/src/lib/stores/app.svelte.ts`,
  `apps/web/src/lib/components/Topbar.svelte`, `Telemetry.svelte`
- Test: `apps/web/src/lib/api.test.ts`

- [ ] **Step 1:** The socket reconnects with capped exponential backoff
      (1s → 30s), cancelled on board switch and on close.
- [ ] **Step 2:** A failed usage fetch sets `usageError` instead of zeroed
      figures; Telemetry says "couldn't load" rather than "$0.00".
- [ ] **Step 3:** The error banner gains Retry and Dismiss.
- [ ] **Step 4:** Full suite, commit.

---

## Self-review

- **Spec coverage:** every audit finding maps to a task — trigger grants (1),
  capabilities (2), token re-mint (3), stages (4), due/cost/assign/compose (5),
  scopes (6), roles + membership (7), notifications (8), events (9), gates (10),
  palette (11), cron (12), dead code and columns (13), keyboard (14),
  confirmations + orphaned DO state (15), reconnect + errors (16).
- **Ordering:** Task 2 adds `updateAgent`, which Task 13 depends on for the
  `icon_url`/`concurrency` writes. Task 7 adds `UserPrincipal.role`, which no
  earlier task reads. Task 6 changes `createAgentToken`'s default scopes, which
  Task 3 mints with — Task 3 therefore names `['claim','run']` explicitly rather
  than relying on the default it precedes.
- **Residual, recorded not fixed:** `findTenantByExternal` picks arbitrarily
  under a many-to-one fleet mapping (documented at `index.ts` `/v1/tenant`).
  Out of scope: it is a question about whether hub-token resolution is
  well-defined under that mapping, not a defect of any route here.

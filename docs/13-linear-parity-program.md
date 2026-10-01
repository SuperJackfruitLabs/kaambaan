# 13 — Linear Parity Program

How Superpipeline reaches **feature parity with Linear** — the issue tracker whose
interaction model specs [00](./00-vision-and-principles.md) and
[11](./11-prior-art-and-market-scan.md) already borrow. This doc is the program
plan for the work *after* [10 — Roadmap](./10-roadmap.md)'s P0→P7 (we shipped
through **P14 / v0.0.1**; see [`CHANGELOG.md`](../CHANGELOG.md)). It continues the
phase numbering at **P15**.

> 🖼 A clickable, high-fidelity **wireframe** realizing these patterns in the flight-deck identity
> lives at [`docs/wireframes/flight-deck.html`](./wireframes/flight-deck.html) (open in a browser).
> Design spec: [`superpowers/specs/2026-06-22-kaambaan-flight-deck-wireframe-design.md`](./superpowers/specs/2026-06-22-kaambaan-flight-deck-wireframe-design.md).

> **Scope decision (recorded).** The owner chose **literal full parity** —
> including the contested planning machinery (cycles, projects, roadmaps,
> insights, SSO) — accepting a **~9–15 month** envelope and that a few items get
> **adapted or stubbed** where they fight Superpipeline's thesis. This doc delivers
> that plan *and* marks every collision honestly.

## 0. The honesty section — parity vs. the locked vision

Superpipeline is **board-first and agent-first**, not an issue tracker that agents
visit. [00](./00-vision-and-principles.md) locks three things that literal Linear
parity presses on. We do **not** silently override them; each is an `⚠️ OPEN`
decision below, and where parity wins, the vision doc must be amended in the same
PR.

| Locked stance (00) | Linear feature that presses on it | Resolution path |
|---|---|---|
| "**Not a chat app**" — conversation is structured activity, not a thread | Threaded **comments**, @mentions, reactions | **Reconcilable:** model a comment as a new typed activity `comment` on the same append-only log. Discussion lives *on the card as activity*, state is still **derived** (Principle 4 holds). Amend 00 to say "not a *freeform* chat app." → **P16** |
| **Principle 4: state is derived, not declared** | Linear's human-**draggable status** (Todo→In Progress→Done) | **D2 below.** Either keep status fully derived (status = a *view* over stage+task-state) or admit a declared human-status axis as an explicit, audited exception. |
| "**Domain-agnostic**; not coding-only" | Cycles, velocity, sprint burndown (human-team planning) | **Decline, don't adapt.** These encode *human* cadence; agents have no velocity, and a cycle is a commitment device for humans negotiating scope against their own week. Reframe the *metrics* (P24 — cost/throughput, not velocity); Cycles themselves are **declined** (P22, closed — see §3). |

Everything else in Linear is either a **clean borrow** (✅) or a **reframe that
strengthens the agent thesis** (🟡). The genuinely contested items are marked 🔴.

## 1. Two foundational decisions — resolve before P15

Almost every Linear construct hangs off two containers Superpipeline doesn't yet have.
Settle these first or we rebuild twice.

### ⚠️ OPEN — D1: the Team container

Linear's top level is a **Team** (owns its issues, workflow states, cycles).
Superpipeline's nearest noun ([01](./01-domain-model-and-glossary.md)) is a **Board**,
but a Board is a *pipeline*, not a namespace.

- **Option A — Board = Team.** Cheapest. A Board grows team-like attributes
  (members, labels, states, cycles). Risk: a "team" with many pipelines doesn't fit.
- **Option B — Team over Boards** (a Team has many Boards). Truer to Linear and to
  real orgs (one team, several pipelines). Cost: a new top-level entity threaded
  through tenancy, auth, routing, and every view.
- **Recommendation:** **B.** It's the honest shape and unblocks projects/cycles
  that span boards. Pay it once, early.

### ⚠️ OPEN — D2: status axis vs. pipeline-stage axis

Linear issues carry a **workflow status** (5 categories: backlog / unstarted /
started / completed / canceled) a *human* drives. Superpipeline cards carry a
**pipeline stage** (an agent work-routing slot) plus an A2A **task-state**
([03](./03-card-lifecycle.md)) that is *derived*. Parity needs a human-facing
status; the question is whether it's a **second axis** or a **projection**.

- **Option A — projection (keep Principle 4).** Status is a deterministic *view*
  over `(stage category, task-state)`. No new declared field. Purest, but loses
  Linear's "drag an issue to In Progress" affordance.
- **Option B — declared status axis (audited exception).** Add a real status field
  humans can set, recorded as a typed activity so it stays attributable. Parity-true,
  but a deliberate dent in "state is derived."
- **Recommendation:** **A with a thin B affordance** — derive by default; allow an
  explicit human status *override* that is itself a logged activity (so derivation
  + override are both visible). Resolve in **P19**.

## 2. The Linear surface → Superpipeline map

Fit legend: ✅ clean borrow · 🟡 reframe for agents · 🔴 fights a locked non-goal.

| Area | Linear feature | Superpipeline today | Fit | Phase |
|---|---|---|---|---|
| **Card depth** | Sub-issues + progress rollup | ✓ **shipped** — child cards (`createChildCard`), a markdown-checklist splitter over both REST and MCP (`splitCard` / `superpipeline_split_card`), an enforced `parent` edge (a parent cannot advance while any child is open), open/total counter on the board tile | — | done |
| | Relations (blocks/blocked-by/related/duplicate) | ✓ **shipped**, as `blocks` / `relates` / `parent` — same-board edges live in the board DO and are enforced (claim/advance refuses on an unresolved `blocks` edge or an open `parent` child; adding an edge that would close a cycle is refused). Cross-board `blocks`/`relates` edges are stored in D1 and are advisory only, shown but never enforced. There is no `duplicate` kind and no stored reverse `blocked-by` kind — `blockedBy` is a *derived read*, not an edge | — | done |
| | Labels + label groups | ✓ labels **shipped** — a D1 catalogue with `declared`/`inferred` origin and a management UI; no label *groups* exist | — | done |
| | Due dates / target dates | ✓ **shipped** — a real `dueAt` column, ordered behind priority in claim order, feeding the overdue cron sweep | — | done |
| | Estimates (points) | cost estimate only | 🟡 (points vs $/tokens) | P15 |
| | Custom fields | opaque `spec` JSON | ✅ | P15 |
| **Collaboration** | Comments (threaded, markdown) | agent activity only | 🔴→✅ (as `comment` activity) | P16 |
| | @mentions, reactions, emoji | ✗ | ✅ | P16 |
| | Notifications: inbox / email / Slack / push | in-app only | ✅ | P16 |
| **Navigation** | Command palette (Cmd+K) | ✗ | ✅ (Linear's signature) | P17 |
| | Full-text search | ✗ | ✅ | P17 |
| | Keyboard-first everything | Esc only | ✅ | P17 |
| **Views** | Saved / shared / custom views, favorites | ephemeral filters | ✅ | P18 |
| | Filter / group / sort on every field | partial | ✅ | P18 |
| | Board, List | ✓ | — | done |
| | Calendar | ✗ | ✅ | P23 |
| | Timeline / Gantt | ✗ | 🔴 (low agent fit) | P23 |
| **Team & flow** | Teams | Boards only | 🟡 (D1) | P19 |
| | Customizable workflow states | pipeline stages | 🟡 (D2) | P19 |
| | Triage inbox | gates ≈ triage | 🟡 (generalize gates) | P19 |
| | Issue/card + project templates | board templates | ✅ | P20 |
| | Automation / workflow rules | ✗ | ✅ (also routes agents) | P20 |
| | Recurring / scheduled issue creation | ✓ **shipped** — schedules on a board; a restricted rule grammar, not cron (`every <n> minutes\|hours\|days`, `daily at HH:MM`, `weekly on <dow> at HH:MM`, `monthly on <1-28> at HH:MM`; shortest interval 5 minutes); IANA timezones, validated by construction and stored verbatim; fires from the Worker's 5-minute cron, not a per-board DO alarm | 🟡 (not a named Linear feature; superpipeline-native) | done |
| **Planning** | Projects + milestones + updates + docs | ✓ projects + milestones **shipped** — D1, spanning boards, card membership, a cached cross-board rollup (`cardsTotal`/`cardsDone`/`cardsOverdue`/`costUsd`, a `computedAt` "as of" time, marks itself `partial` when a board does not answer). Project **updates** and **docs** (Linear's per-project changelog/longform doc) are not shipped | 🟡 | P21 (updates/docs remain) |
| | Cycles (sprints, velocity, rollover) | ✗ | 🔴 **declined** — a cycle is a commitment device for humans negotiating scope against their own week, and agents have no week | declined |
| | Initiatives + Roadmap | ✗ | 🔴 (human strategy) | P23 |
| | Insights / analytics | cost metering | 🟡 (reframe → agent telemetry) | P24 |
| **Integrations** | GitHub deep (branch, auto-close, status) | refs + webhook sync | ✅ | P25 |
| | GitLab, Sentry, Zendesk/Intercom | ✗ | ✅ | P25 |
| | Slack two-way + Asks (message→card) | ✗ | ✅ (= an inbound trigger, [05](./05-integration-surfaces.md)) | P25 |
| | Importers (Jira/Asana/GitHub/CSV) | ✗ | ✅ | P26 |
| | Customer requests | ✗ | 🟡 | P26 |
| **Enterprise** | RBAC enforcement | ✓ **enforced** since 2026-09-02 — every route resolves the caller's `memberships.role` and refuses what `permits(role, capability)` does not allow; a caller with no membership is refused outright, not demoted to a reader | — | done |
| | Audit log | activity log ≈ audit | 🟡 (formalize) | P27 |
| | Guest / limited access | ✗ | ✅ | P27 |
| | SSO / SAML / SCIM | OAuth + tokens | ✅ | P28 |
| **Platform** | Mobile apps (iOS/Android) | responsive web | 🟡 (XL) | P29 |
| | Local-first sync engine (offline, instant) | DO + WebSocket | 🔴 (the moat-copy question) | P30 |
| | Dark/light theming | dark only | ✅ | P30 |

## 3. Phased delivery (P15+)

Same rule as [10](./10-roadmap.md): each phase is a **working, tested vertical
slice**, landing with the suites from [09](./09-testing-strategy.md). Phases
within a group are largely parallelizable; **P15 and P19 are the critical path**.

### Group 1 — Card depth & collaboration

**P15 — Card depth.** Sub-cards (parent/child + rollup), card↔card relations
(blocks/blocked-by/related/duplicate), labels-management UI, due dates, point
estimates, custom-field schemas. The data-model spine for half of Linear; extends
[01](./01-domain-model-and-glossary.md). *⚠️ OPEN: do sub-cards run their own
pipeline, or are they checklist items on the parent's pipeline?*

**P16 — Comments & notifications.** A `comment` typed activity on the existing
append-only log (state stays derived — Principle 4), @mentions, reactions,
markdown; notification fan-out to **inbox + email + Slack + push**. Amends 00's
"not a chat app" to "not a *freeform* chat app." Builds on
[07](./07-realtime-and-ui.md).

### Group 2 — Navigation & "the feel"

**P17 — Command palette + search.** Cmd+K (nav + actions + search), full-text
search across cards/activities/comments (DO SQLite FTS or per-tenant D1 index),
and the comprehensive keyboard layer. ~70% of what makes Linear *feel* like Linear.

**P18 — Views infrastructure.** Saved / named / shared views, favorites, and a
general filter/group/sort/order engine over every field. Generalizes today's
ephemeral filters.

### Group 3 — Team & workflow model

**P19 — Teams + states + triage.** Implements **D1** and **D2**: the Team
container, customizable workflow states living *alongside* pipeline stages, and a
**triage inbox** that generalizes gates / "needs you" into one queue. The second
critical-path phase.

**P20 — Templates & automation.** Card/project templates (reuse the board-template
machinery) + a **rule engine** ("when X → assign/move/notify") that doubles as
agent-routing automation. Ties to the `pipeline` vs `manager` routing in
[10/P7](./10-roadmap.md).

### Group 4 — Planning constructs (contested)

**P21 — Projects.** ✅ **Shipped** (2026-09-30 planning-constructs-and-recurrence plan, Phase 4).
Projects and milestones group cards toward a goal, spanning boards, in D1 — never on the claim or
advance path, since neither may ever refuse anything. A cached cross-board rollup
(`cardsTotal`/`cardsDone`/`cardsOverdue`/`costUsd`) fans out to every board on a 5-minute cron and
marks itself `partial`, with a `boardsUnanswered` count, whenever a board fails to answer — the
`computedAt` field is the reader's "as of" time. **Not shipped:** project updates (a per-project
changelog) and docs (longform text attached to a project). "Needs D1=B" (Team-over-Boards) turned
out not to be a real dependency — projects/milestones shipped tenant-scoped, spanning boards
directly, without a Team container.

**P22 — Cycles. DECLINED**, not deferred. A cycle is a commitment device for humans negotiating
scope against their own week — "we're behind, let's cut scope before Friday" — and agents have no
week. There is no agent-shaped version of that negotiation to ship a stub of. **Do not** build the
entity and **do not** alias it to a time-boxed view; a human team that wants sprint cadence on top
of superpipeline can build it as a *view* over existing due dates and milestones. The open question
below is closed, not re-asked.

**P23 — Roadmap & temporal views.** Initiatives, Roadmap, Timeline/Gantt, Calendar.
🟡 Calendar is cheap and useful — ship early. 🔴 Roadmap/Gantt are human-strategy
artifacts; treat as polish.

**P24 — Insights.** 🟡 **Reframe, don't copy.** Linear shows velocity/cycle-time;
Superpipeline's native equivalents are **cost-per-card, success/failure rate,
time-in-stage, agent throughput, gate-rejection rate** — we already meter cost
per activity ([07 §6](./07-realtime-and-ui.md)). This is parity *and* a
differentiator ([11 §5](./11-prior-art-and-market-scan.md)).

### Group 5 — Integrations & ingestion

**P25 — Integration breadth.** Deeper GitHub (branch naming, auto-close, status
sync), GitLab, **two-way Slack incl. Asks** (a message → a card — just another
inbound trigger, [05](./05-integration-surfaces.md)), Sentry, Zendesk/Intercom.
Parallelizable.

**P26 — Import & customer requests.** Jira/Asana/GitHub/CSV importers; customer-
request capture funneling to cards.

### Group 6 — Enterprise & platform

**P27 — RBAC + audit + guests.** Enforce owner/admin/member/viewer through API +
UI (today they exist in the catalog but aren't enforced); formalize the activity
log into an audit surface; guest/limited access.

**P28 — SSO/SAML + SCIM.** Enterprise auth + provisioning. Gate on having buyers.

**P29 — Mobile apps.** Native iOS/Android. XL; defer unless demanded.

**P30 — Sync engine + theming.** 🔴 Linear's offline-capable, instantly-optimistic
client is its real moat and a multi-quarter effort. **Recommendation: declare the
per-board DO + WebSocket the "good-enough" answer and skip true offline sync**
unless a customer requires it. Light/dark theming ships here cheaply regardless.
*⚠️ OPEN: attempt the local-first sync engine, or formally decline it?*

## 4. Effort & sequencing

| Phase | Theme | Effort | Depends on |
|---|---|---|---|
| P15 | Card depth | L | D1?, schema |
| P16 | Comments & notifications | L | P15 |
| P17 | Cmd+K + search | M–L | — |
| P18 | Views infra | M | P17 |
| P19 | Teams + states + triage | L | **D1, D2** |
| P20 | Templates + automation | L | P19 |
| P21 | Projects | ✅ done | — (shipped without D1; see §5) |
| P22 | Cycles | — | **declined**, see §3 |
| P23 | Roadmap/temporal views | L | P21 |
| P24 | Insights (agent telemetry) | M | metering |
| P25 | Integration breadth | L (parallel) | — |
| P26 | Import + customer requests | M–L | P21 |
| P27 | RBAC + audit + guests | M | D1 |
| P28 | SSO/SAML/SCIM | L | P27 |
| P29 | Mobile apps | XL | stable API |
| P30 | Sync engine + theming | XL / S | — |

**Critical path:** the two decisions (D1, D2) → **P15** (data model) → **P19**
(teams/states). Groups 1–3 (P15–P20) deliver the *felt* parity in ~4–5 months;
Groups 4–6 are the long, lower-ROI tail. The 🔴 items (P22 cycles, P23 roadmap/
Gantt, P30 sync engine) are where "literal parity" costs the most for the least
agent fit — recommended to stub/decline, included here because full parity was the
chosen scope.

## 5. Open decisions added by this program

Tracked the same way as [10's](./10-roadmap.md) closing list — resolved at their phase:

- **D1** — Board = Team vs. Team-over-Boards. *(blocks P19, P27 — **not P21**: projects/milestones
  shipped tenant-scoped, spanning boards directly, without a Team container; that dependency was
  wrong)*
- **D2** — status as derived projection vs. declared audited axis. *(blocks P19)*
- ~~Sub-card semantics — own pipeline vs. parent checklist.~~ **Closed (P15, shipped).** A sub-card
  is a real child card (`createChildCard`, built on `createCard` + an enforced `parent` edge) —
  "own pipeline," not a checklist item on the parent's. It runs its own stage progression and can
  be claimed independently.
- ~~Cycles — expose vs. alias to time-boxed views.~~ **Closed (P22). Declined** — see §3.
- Local-first sync engine — attempt vs. formally decline. *(P30)*
- Vision amendments — does parity change 00's "not a chat app" / Principle 4
  non-goals, and are we comfortable making that explicit? *(P16, P19)*

## 6. Patterns to borrow (June 2026 scan)

A re-scan of the field ([11 §6](./11-prior-art-and-market-scan.md)) surfaced concrete,
transferable patterns. Split into what **validates what we already have** (don't rebuild) and what
is **net-new to adopt**, each tagged with where it lands.

**Already validated — keep, don't rebuild.** Temporal's heartbeat-timeout reclaim +
progress-carrying heartbeats = our lease/epoch spine
([08](./08-reliability-and-durable-execution.md)); GitHub's requester-can't-approve gate = our
separation-of-duties ([03](./03-card-lifecycle.md)); Linear's delegate-not-owner = Principle 3;
board-as-MCP-server (Vibe Kanban) = our [05](./05-integration-surfaces.md) surface; Cloudflare
`waitForEvent` (parked = zero compute) = our durable gate. The field converged on our design —
these are confidence, not work.

### A. Into the parity program (board/UX — map to phases)

- **Agent-session card UI** (Linear) — a live status row + an agent **"plan" checklist** + the full
  typed stream, adding explicit **`elicitation`→awaiting-input** and **`error`** rendering (we ship
  `thought|action|response` today). → **P16** + [07](./07-realtime-and-ui.md).
- **Omni-channel Triage inbox** (Tegon, Linear Asks) — consolidated intake → AI metadata suggestion
  → routing, with accept / dismiss / **inspect-reasoning**. → **P19** (triage) + **P25/P26** (intake).
- **Run-as-artifact progress stream** (GitHub) — 👀-ack the instant a card is claimed; agent
  self-decomposes into a watchable checklist; draft-PR-as-progress-surface. → **P16**, ties to
  [06](./06-external-references.md).
- **Mid-run steering** (GitHub Agent HQ) — pause / refine / restart a *running* card, beyond
  approve/reject; extends our `stop` signal. → new verb in [04](./04-agent-contract.md); surface in **P16**.
- **Card-to-card dependency edges that auto-trigger downstream** (Cline, agent-kanban) — pipeline
  autopilot beyond linear stages. → **P15** (relations) + **P20** (automation).
- **Acceptance-criteria as a structured card field** + a dedicated **verifier stage** (Factory,
  Intent, Devin) — agents must satisfy explicit criteria; "verify against spec" becomes its own
  gated stage. → **P15** (custom fields) + [03](./03-card-lifecycle.md).
- **Plan-as-living-spec approval gate** (Intent, Devin, Magentic co-planning) — a human-approved
  plan stage *before* execution. → [03](./03-card-lifecycle.md) + **P20** templates.
- **Mobile approval companion** (GitHub, Nimbalyst, Factory) — a thin phone view to approve/steer.
  → **P29** (or an earlier thin slice).

### B. Evolve the gate & contract ([03](./03-card-lifecycle.md) / [04](./04-agent-contract.md) / [08](./08-reliability-and-durable-execution.md))

- **Gate response triad: approve / reject-with-feedback / modify** (HumanLayer + AG-UI) — we have
  approve/request-changes/reject; add **modify** (human edits the proposed handoff before it
  proceeds), and thread reject-feedback into the next claim's **handoff**. *Our single biggest
  gate-design call.*
- **Risk-/confidence-driven two-tier gating** (Magentic-UI Action Guards, AG-UI risk levels, Sema4
  fail-closed, Preloop) — gate only high-stakes/low-confidence actions; add a lightweight
  **`require-justification`** (agent logs a rationale, no human block) between "ungated" and "full
  gate"; promote trusted repeated patterns to ungated. Deepens [11 §2.7](./11-prior-art-and-market-scan.md).
- **Opaque state round-trip** (HumanLayer) — attach a context blob to `submit_for_review` returned
  verbatim on resolve, so a gate is reconstructable without server-side session state (fits our
  append-only log).
- **Dead-letter cap on reclaim** (DBOS `max_recovery_attempts`) — track a reclaim count and route a
  poison card to "needs human / dead-letter" after N, instead of re-dispatching forever. Closes a
  gap beside our circuit breaker.
- **`auth-required` vs `input-required` as distinct gate types** (A2A v1.0) — separate "needs a
  human decision" from "needs a credential" in the gate UX (both already in our state machine).
- **Per-gate timeout policy (skip / end / reassign) + collect structured inputs in the gate**
  (Relay.app, Windmill N-of-M) — the human-layer mirror of heartbeat/reclaim; a gate can request a
  *value*, not just a verdict. The design source for deferred **P3.1** (gate timeout/escalation/quorum).
- **Three-way idempotent gate completion** (Trigger.dev) — resolve a gate from the **UI, a webhook,
  or the SDK**, all idempotent, with a queryable "pending approvals" list.

### C. Observability & cost ([07](./07-realtime-and-ui.md))

- **Versioned pricing-table cost model** (LangSmith) — regex model match + **activation-dated
  prices** + per-token-type accounting (cache-read/reasoning) + `usage_metadata` injection. We meter
  cost already; activation-dated price versioning is the detail home-grown meters miss.
- **OTel GenAI semantic conventions** (MS Agent Framework, CrewAI, Google) — emit OTel spans
  alongside our typed activity log for free interop with external observability backends.
- **AG-UI state snapshot + JSON-Patch deltas** — adopt as the wire format for streaming card/activity
  state without resending full state (we already use AG-UI adapters).

### D. External-agent governance & onboarding ([04](./04-agent-contract.md) / [05](./05-integration-surfaces.md))

- **Identity + Registry + Gateway triad** (Google) + **signed A2A agent cards**
  (`/.well-known/agent-card.json`) — self-describing capability onboarding, an approved-agent
  registry, and a policy gateway on every external dispatch; **cryptographic per-agent identity**
  (agent-kanban) hardens trust beyond bearer tokens.
- **`auth.md` registration** (WorkOS) — a discoverable front door telling external agents which OAuth
  flows/scopes exist and how scoped tokens are issued/revoked (we already mint scoped agent tokens).
- **Selective MCP tool loading** (Task Master) — don't dump all verbs into every agent's context;
  load per-capability to cut tokens.

**Top 5 highest-leverage** (if we adopt nothing else): (1) the **approve/reject/modify** gate triad
with feedback-into-handoff; (2) the **agent-session card UI** with elicitation/error + plan checklist;
(3) the **omni-channel triage inbox**; (4) **risk-driven two-tier gating** + `require-justification`;
(5) the **versioned cost model**. The first two are parity-critical; the rest sharpen the agent thesis.

## 7. Parked findings from implementation (2026-09-30 planning-constructs-and-recurrence)

Nine items, found during review of Phases 3 and 4, each judged correctly out of scope at the time
it was found. Recorded here — not in a changelog, not in a code comment — so none of them is
rediscovered from scratch by whoever next reads this code. The standing rule three of them led to
is in [01](./01-domain-model-and-glossary.md), beside the entity list.

### Phase 3 (card dependencies, sub-tasks, cross-board advisory edges)

- **`listLinks` has no `NOT_INITIALIZED` guard**, unlike `addLink`/`removeLink` — confirmed in
  `apps/api/src/board/board-do.ts`, where every neighbouring write verb checks
  `this.getMeta('boardId')` first and `listLinks` does not. `GET …/cards/:cardId/links` on an
  uninitialised board answers `200` with an empty list while the write verbs answer `404`. Open:
  guard it, or document the asymmetry as intended.
- **`rowToCard` calls `budgetCap('budgetCardUsdCap')` per card, on every board read** — a `SELECT`
  per card in the hot read path. Pre-existing, unrelated to Phase 3, and cheap to hoist into the
  `pre` batch that already carries five other values (Task 14's own comment names the fix: `pre?`).
  Found while building a test that would otherwise have been meaningless because of it.
- **The advisory `⚑` badge appears in the card drawer but not on the board tile.** Confirmed live
  and in code: `CardTile.svelte`'s own comment says why — the board read does not carry external
  links, and showing the badge on the tile would mean a cross-board read on the board-list path.
  The badge renders instead in `CardDrawer.svelte`'s Links section, where `GET …/links` already
  resolves it. This is a deliberate cost, not an omission — worth saying plainly because nothing
  else does.

### Phase 4 (projects, milestones, cross-board rollup)

- **`computeRollup` would throw `D1_ERROR: FOREIGN KEY constraint failed` on a deleted project** —
  the cache upsert's `project_rollups.project_id REFERENCES projects(id)`. Unreachable today (the
  route 404s before `computeRollup` is ever called), so only a delete racing the route's check
  would 500.
- **`computeRollup` does not validate its `(tenantId, projectId)` pair**, and the cache row is keyed
  on `project_id` alone with a mutable `tenant_id`. Defence in depth only; unreachable through both
  callers today.
- **`cardsTotal`/`cardsDone` count archived cards; `cardsOverdue` does not.** Internally
  inconsistent. The inconsistency is the defect, not either answer — a product decision is needed
  on which is right, and it has not been made.
- **The cron's rollup arm is O(projects × boards-per-tenant) sequential DO calls**
  (`apps/api/src/index.ts`'s `scheduled()`, third arm), where the sweep and push-delivery arms are
  O(boards). May approach the subrequest ceiling on a large tenant.
- **`createCard` takes no `projectId` on its public surface**, so a card joins a project in a second
  round trip — the pattern `createCard`'s own `dueAt` comment argues against. Task 19 added an
  *internal* field for `createChildCard` and deliberately did not expose it on `createCard`, leaving
  this open on purpose.
- **Three more routes spread a cast request body into their callee**: `PUT …/github`,
  `POST …/push-configs`, `POST /v1/capabilities`. None leaks today, because each callee's accepted
  fields happen to coincide with the route's declared body type. That coincidence is the whole risk
  — it is exactly how `POST …/cards` broke after sitting harmless for months, the moment `createCard`
  gained a field (see the fix in commit `9f4789c`). Recommend one standalone PR applying the same
  whitelist treatment, not folded into a feature phase.

### The standing rule three separate tasks discovered independently

> A foreign key proves a row **exists**. It never proves the row is **yours**.

Recorded in full in [01](./01-domain-model-and-glossary.md), beside the entity list — three
independent discoveries of one fact belong in documentation, not in three separate code comments.

# 04 — Agent Contract

This is the contract every external agent speaks to participate in a Kaambaan board. It is
defined **once**, surface-agnostic, and projected onto two wire surfaces — an **MCP server**
and a **REST + webhook API** (detailed in [05 — Integration Surfaces](./05-integration-surfaces.md)). The contract is
A2A at its core, with Linear's activity/signal model for transparency and human-in-the-loop.

> **Conformance definition:** an agent that implements the verbs in §3 and emits the activity
> vocabulary in §4, honoring the SLAs in §5, is **Kaambaan-compatible** — regardless of harness,
> language, or where it runs.

## 1. Identity & accountability

- An agent is an **app-actor** registered to one tenant — *not* a human user. It is always
  badged as an agent in the UI (Principle 9).
- An agent is only ever a card's **delegate** (executor), never its **owner** (the accountable
  human). When an agent claims a card it becomes `card.delegateAgentId`; the human
  `ownerUserId` is untouched. *(Linear delegate model — Principle 3.)*
- **A run belongs to the agent that claimed it.** Every run verb (`heartbeat`, `activity`,
  `complete`, `submitForReview`, `block`, `fail`, `release`) and the run read compare the
  authenticated agent against `run.agentId` and refuse a mismatch with **403** — *in addition to*
  the lease check, never instead of it. The lease answers "is this write current?"; identity
  answers "is it yours?". Without both, any token in the tenant could drive any run, and the run's
  cost would still meter against the original agent — so "which agent did this" would not be a
  fact the platform can assert.
- **Reclaim is unaffected**: a lapsed run is *ended* and the card re-queued, so the agent that
  re-claims gets a **new run** (new id, new lease epoch) that is its own. The original agent is
  refused by the lease (`409 STALE_LEASE` — "re-claim"), which is what it should act on, not by
  identity.
- An agent's abilities are a **list of capability tags** (`capabilities_json` on the `agents` row),
  set when a human registers it, and they are what `claim` routes on. **⚠️ The A2A AgentCard is not
  implemented**: there is no `agent_card` column, no upload path, and no endpoint that serves one, so
  skills, input/output modes and `capabilities.streaming`/`.pushNotifications` are not modelled.
  Adopting the full AgentCard is design intent.

## 2. Onboarding

1. **Register** the agent to a tenant (human admin action in the UI, or an admin API call):
   name, icon, capability tags, connection type(s), concurrency limit.
2. Kaambaan issues a **bearer token** (`kbn_…`) scoped to the tenant. The plaintext is shown once;
   only its SHA-256 hash is stored. **The same token is the credential on both wires** — MCP agents
   do *not* obtain tokens through an OAuth flow, because there is no authorization server
   ([05 §2](./05-integration-surfaces.md)). A token records `scopes`, but **nothing enforces them
   today**; the tenant and the agent identity are what actually constrain a token.
3. The agent connects: as an **MCP client** to `/mcp`, and/or via **REST** to `/v1/boards/*`, and/or
   by registering a **webhook** endpoint for push dispatch.
4. **Discovery** — **⚠️ not built.** There is no `/.well-known/agent-card.json` and no AgentCard
   endpoint; an agent cannot ask Kaambaan what verbs or skills it offers. Over MCP, `tools/list` and
   `kaambaan_list_work` are the closest thing that exists. Over REST there is nothing: an agent
   learns what it can do by calling `claim`.

## 3. The verbs

Surface-neutral verb set. Each maps to one MCP tool and one REST endpoint with identical
semantics. Signatures are illustrative (finalized as zod schemas in `packages/contract`).

| Verb | Direction | Purpose | Result / effect |
|------|-----------|---------|-----------------|
| ~~`discover`~~ | — | **Not built** — no AgentCard endpoint exists (§2.4); MCP `kaambaan_list_work` is the only board discovery an agent credential can reach | — |
| `claim` | agent → Kaambaan | Atomically pull the next *ready* card in a stage it owns | Task (`working`) + context bundle, or *empty* |
| `getCard` | agent → Kaambaan | Read the card **it holds** — spec, references, stage, handoff metadata | run context (read-only) |
| `heartbeat` | agent → Kaambaan | Keep the run alive | ack; resets stale/reclaim timers |
| `activity` | agent → Kaambaan | Emit typed progress (`thought/action/response/elicitation/error`) | appended (immutable); state derived |
| `requestInput` | agent → Kaambaan | Ask the human a question / present choices (elicitation + signal) | Task → `input-required` |
| `addReference` | agent → Kaambaan | Attach an external link (GitHub PR/issue, repo, doc) | idempotent upsert on `(cardId, url)`. **MCP only** — the REST route is human-auth ([05 §3](./05-integration-surfaces.md)) |
| `submitForReview` | agent → Kaambaan | Hand a gated stage to a human approver | Task → `input-required` (`select` signal) |
| `complete` | agent → Kaambaan | Finish the stage successfully with structured handoff | Task → `completed`; card advances |
| `block` | agent → Kaambaan | Escalate; cannot proceed without human help | Task → `input-required`/blocked |
| `release` / `fail` | agent → Kaambaan | Give the claim back / report failure | Task → `submitted` (reclaim) / `failed` |
| `answerElicitation` | human → Kaambaan | Answer an agent's question (pick an option / free text) | Task → `working`; the asking agent reads the answer off its run |

### Claim semantics (the critical verb)
- **Atomic.** The Board DO's single thread guarantees exactly one agent receives a given card.
- **Filtered.** A claim matches on the agent's **capability tags** vs the stage `owner`, and
  respects **WIP limits** (per stage) and **agent concurrency** (per agent).
- **Pull by default.** Agents pull (`claim`) work. Push (webhook "work available") is an
  optional accelerator that just tells the agent to call `claim` — the claim is still atomic.
- **Returns a self-contained context bundle** so any harness can work statelessly: card spec,
  references, prior-stage handoff metadata, board/stage guidance rules, and the immutable
  history. (Linear's `promptContext` + Hermes's structured handoff.) The agent should **not**
  need N follow-up calls to assemble context.

### Idempotency
- **⚠️ Design intent, not shipped.** Mutating verbs are *specified* to accept an **idempotency key**
  with replays de-duplicated. **No route reads an `Idempotency-Key` header and nothing de-dupes a
  replayed verb**; the `idempotencyKey` field in the contract schemas is accepted and ignored. What
  is idempotent today: reference upsert on `(cardId, url)`, and GitHub delivery dedup. Until this
  lands, a client that retries `complete` after a timeout may apply it twice.
- Agents reconstruct state by reading **activities** (immutable snapshots), never by scraping
  mutable card fields (Principle 4 / Linear's consistency rule).
- Any agent-owned *structured* state (e.g. a task checklist/plan) is updated by **full
  replacement**, not partial patch, to avoid concurrent-step races. Genuinely additive
  collections (references) use add/remove deltas.

## 4. Activity & signal vocabulary

Agents communicate progress as a small, typed set (Linear, adopted verbatim). The Task/Run
**state is derived** from the latest meaningful activity — agents do not set state directly.

| Activity | Fields | Moves the card to *(as shipped)* | Ephemeral allowed? |
|----------|--------|-----------------|--------------------|
| `thought` | `body` | (no change) — reasoning/ack | ✅ yes |
| `action` | `action`, `parameter`, `result?` | (no change) — a tool invocation, for audit | ✅ yes |
| `elicitation` | `body` (+ signal) | `input-required`, or `auth-required` for an `auth` signal | ❌ no |
| `response` | `body` | **(no change)** — see below | ❌ no |
| `error` | `body` | **(no change)** — see below | ❌ no |
| `prompt` | `body` | written by the board when a human answers; not agent-postable | ❌ no |

> **⚠️ "State is derived from activity" is only half-built, and this trips integrators.**
> `postActivity` in the Board DO changes card state for **exactly one** activity type:
> `elicitation`. A `response` or an `error` activity is recorded, meters its usage, and refreshes
> the lease — but **the card stays `working`**. To finish or fail a stage you must call the
> **verb**: `complete` (or `submit`) and `fail`. Posting a terminal `response` and disconnecting
> leaves the card in progress until the heartbeat timeout reclaims it.
>
> The contract package *does* export a `deriveStateFromActivity()` that maps `response → completed`
> and `error → failed`, and it has passing unit tests — but **no production code calls it**. It is a
> pure function tested in isolation, which is why the drift went unnoticed: the tests assert the
> intent, not the behaviour. `apps/api/test/activity-does-not-advance.test.ts` now pins what the
> board actually does.

- **Ephemeral** `thought`/`action` render transiently and are replaced by the next activity —
  this is how we stream "thinking…/running tool X…" without cluttering the permanent record,
  over plain HTTP (no agent-side WebSocket required).
- **Markdown** is allowed in `body`. The permanent record is the non-ephemeral activities.

### Signals (typed overlay on an activity)
Open enum; initial set from Linear, extended for gates:

| Signal | Direction | On | Renders as | Payload (in `parameter`) |
|--------|-----------|----|-----------|----------|
| `stop` | human → agent | `prompt` | "Stop request" delivered to agent; agent must cease and emit `response`/`error` | — |
| `auth` | agent → human | `elicitation` | "Link account to continue" → `auth-required` | `url, userId, providerName` |
| `select` | agent → human | `elicitation` | clickable options (e.g. **Approve / Request changes / Reject**) | `options[]` |
| `approve` / `reject` | human → agent | `prompt` | gate resolution | optional feedback |

A signal's payload travels in the activity's **`parameter`** — `{ "options": [{ "name", "title" }] }`
for `select`. One carrier, not two: a second field (`signalMetadata`) was read by nothing, so an
agent that put its options there had them dropped and the human saw a question with no answers.

> The **approval gate** is literally an `elicitation` with a `select` signal whose options are
> Approve / Request changes / Reject. We did not invent a new gate primitive — gates reuse the
> activity+signal model.

### The elicitation return path (as shipped)

An `elicitation` is a **question with an answer**, not a status change. Posting one persists it
(`elc_…`: the question, its options, the run and agent that asked) and parks the card in
`input-required` — or `auth-required` for an `auth` signal — while the asking run **keeps its
lease**. Nothing about the run ends; the agent is waiting, not finished.

- **The human answers** at `POST /v1/boards/:boardId/elicitations/:elicitationId/answer` with an
  option `name`, free `text`, or both. The card moves by the state machine's own transition —
  `human_reply` out of `input-required`, `account_linked` out of `auth-required` — and the answer is
  appended to the card's replay as a `prompt` activity, the human-authored type that resumes work.
- **The agent collects it** by re-reading the run it holds (`GET /v1/boards/:id/runs/:runId`), whose
  `elicitations` carry each question's `status` and `answer`. Polling is the first mechanism; keep
  heartbeating while you wait, because a question does not pause the heartbeat timeout.
- **Who may answer**: a signed-in human, never the agent that asked (`SEPARATION_OF_DUTIES`) — the
  same rule that stops a gate's producer approving it. An elicitation an agent can answer itself
  would make the whole mechanism decorative.
- **Answering twice** is a typed conflict (`ELICITATION_NOT_PENDING`), never a second transition.
- **A question that outlives its run or its card** (the run ends or is reclaimed, the card is moved,
  a newer question supersedes it) is `cancelled`: it drops out of the board's "needs you" queue
  instead of sitting there unanswerable, and the agent polling it learns to stop waiting.

## 5. SLAs & timeouts (normative)

Two of these are enforced today. The rest are design intent, and an agent must not rely on them.

| SLA | Default | Effect on miss | Status |
|-----|---------|----------------|--------|
| Claim TTL (no heartbeat) | **15 min**, hardcoded (`HEARTBEAT_TIMEOUT_MS`) | Run **reclaimed**, lease epoch bumped, card re-queued | ✅ **enforced** (DO alarm) |
| Circuit breaker | **2** consecutive failed/reclaimed runs (`CIRCUIT_BREAKER_LIMIT`) | Card auto-blocks into `input-required` for a human | ✅ **enforced** |
| First activity after `claim` | ~10s | Run marked *unresponsive* | ❌ **not built** — nothing measures ack latency |
| Stale (no activity, recoverable) | ~30 min | Run *stale*; any activity recovers it | ❌ **not built** — there is no stale state distinct from reclaim |
| Stage max runtime | per-stage, optional | Run → `timed_out` | ❌ **not built** — `StageDef` has no `maxRuntime` |
| Webhook/HTTP ack | ~5s | Delivery retried | ❌ push delivery is at-most-once ([§4](#4-outbound-webhooks-push-dispatch)) |

Both defaults are **constants in `board/board-do.ts`, not per-board configuration** — an operator
cannot tune them, and an agent cannot discover them over the wire. Heartbeat more often than every
15 minutes and treat that as the only liveness rule that exists.

The enforced deadlines run on **Board DO alarms**; there are no Workflows and no Queues in the
deployment ([02](./02-architecture.md)). An agent that dies silently is reclaimed. An agent that is
slow-but-alive is *not* protected by a separate stale window — any activity refreshes the same
heartbeat clock, which is what keeps it alive.

## 6. Surface mapping (preview)

The same verb on two surfaces — full detail in [05 — Integration Surfaces](./05-integration-surfaces.md).
**Every REST agent route is board-scoped**; there is no `/v1/runs/…` prefix.

| Verb | MCP tool (`tools/call`) | REST endpoint |
|------|--------------------------|---------------|
| `claim` | `kaambaan_claim_card` *(not read-only, not idempotent)* | `POST /v1/boards/:id/claims` |
| `getCard` | **none** — no MCP tool reads a run | `GET /v1/boards/:id/runs/:runId` *(run-scoped — [05 §3](./05-integration-surfaces.md))* |
| *(read one card)* | `kaambaan_get_card` *(`readOnlyHint: true`)* | **none** |
| *(list boards with work)* | `kaambaan_list_work` | **none** *(`GET /v1/boards` is human-auth)* |
| `heartbeat` | `kaambaan_heartbeat` | `POST /v1/boards/:id/runs/:runId/heartbeat` |
| `activity` / `requestInput` | `kaambaan_post_activity` *(`type: 'elicitation'` raises a question)* | `POST /v1/boards/:id/runs/:runId/activities` |
| `addReference` | `kaambaan_add_reference` | `PUT /v1/boards/:id/cards/:cardId/references` *(human-auth)* |
| `submitForReview` | `kaambaan_submit_for_review` | `POST /v1/boards/:id/runs/:runId/`**`submit`** |
| `complete` | `kaambaan_complete` | `POST /v1/boards/:id/runs/:runId/complete` |
| `block` / `release` / `fail` | `kaambaan_block` / `_release` / `_fail` | `POST /v1/boards/:id/runs/:runId/{block,release,fail}` |

There is no `kaambaan_request_input` tool — an elicitation is an activity, on both wires.

MCP tools carry honest **annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`)
so harnesses prompt humans appropriately. Business failures return MCP `isError: true`
(visible to the model), not transport errors.

## 7. A reference walk-through (3-stage pipeline)

> Demo target: a `research → review(gate) → publish` board.

1. A human creates a card "Summarize the Q2 incident reports" (owns it).
2. A **research** agent (Claude Code via MCP) calls `claim` → gets Task `T1` + context bundle.
3. It emits `thought` (ack, <10s), several ephemeral `action`s (web fetches), `heartbeat`s,
   then `addReference` (a source doc) and `complete` with handoff `{summary, outputs}`.
4. Card advances to **Review** (gate): `T1`→`completed`, a gate task `input-required` with a
   `select` signal. The human clicks **Approve**.
5. Card advances to **publish**; a **publish** agent (a Worker over REST) `claim`s Task `T2`,
   reads `T1`'s handoff, posts the summary, `addReference`s the published URL, and `complete`s.
6. Card → Done. Its full history (T1, gate, T2 + all runs/activities) is the audit trail.

Every step above is an acceptance test in the conformance suite.

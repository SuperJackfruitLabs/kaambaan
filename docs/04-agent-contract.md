# 04 — Agent Contract

This is the contract every external agent speaks to participate in a Kaambaan board. It is
defined **once**, surface-agnostic, and projected onto two wire surfaces — an **MCP server**
and a **REST + webhook API** (detailed in `05-integration-surfaces`, planned). The contract is
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
- An agent advertises what it can do via an **A2A AgentCard** (skills, input/output modes,
  `capabilities.streaming`, `capabilities.pushNotifications`). Kaambaan stores this as the
  agent's capability registry and uses its `capabilities` tags for routing.

## 2. Onboarding

1. **Register** the agent to a tenant (human admin action in the UI, or an admin API call):
   name, icon, capability tags, connection type(s), concurrency limit.
2. Kaambaan issues a **bearer token** scoped to the tenant (optionally to specific boards /
   capabilities). MCP agents obtain tokens via OAuth 2.1 (Kaambaan is the Resource Server);
   REST agents use issued tokens directly.
3. The agent connects: as an **MCP client** to `/mcp`, and/or via **REST** to `/v1/*`, and/or
   by registering a **webhook** endpoint for push dispatch.
4. **Discovery**: the agent can fetch Kaambaan's AgentCard at
   `/.well-known/agent-card.json` (per board/tenant) to learn the available verbs and skills.

## 3. The verbs

Surface-neutral verb set. Each maps to one MCP tool and one REST endpoint with identical
semantics. Signatures are illustrative (finalized as zod schemas in `packages/contract`).

| Verb | Direction | Purpose | Result / effect |
|------|-----------|---------|-----------------|
| `discover` | agent → Kaambaan | Fetch AgentCard / available boards & stages it may work | capabilities + board list |
| `claim` | agent → Kaambaan | Atomically pull the next *ready* card in a stage it owns | Task (`working`) + context bundle, or *empty* |
| `getCard` | agent → Kaambaan | Read the card **it holds** — spec, references, stage, handoff metadata | run context (read-only) |
| `heartbeat` | agent → Kaambaan | Keep the run alive | ack; resets stale/reclaim timers |
| `activity` | agent → Kaambaan | Emit typed progress (`thought/action/response/elicitation/error`) | appended (immutable); state derived |
| `requestInput` | agent → Kaambaan | Ask the human a question / present choices (elicitation + signal) | Task → `input-required` |
| `addReference` | agent → Kaambaan | Attach an external link (GitHub PR/issue, repo, doc) | idempotent upsert on `(cardId, url)` |
| `submitForReview` | agent → Kaambaan | Hand a gated stage to a human approver | Task → `input-required` (`select` signal) |
| `complete` | agent → Kaambaan | Finish the stage successfully with structured handoff | Task → `completed`; card advances |
| `block` | agent → Kaambaan | Escalate; cannot proceed without human help | Task → `input-required`/blocked |
| `release` / `fail` | agent → Kaambaan | Give the claim back / report failure | Task → `submitted` (reclaim) / `failed` |

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
- Mutating verbs accept an **idempotency key**; replays are de-duplicated.
- Agents reconstruct state by reading **activities** (immutable snapshots), never by scraping
  mutable card fields (Principle 4 / Linear's consistency rule).
- Any agent-owned *structured* state (e.g. a task checklist/plan) is updated by **full
  replacement**, not partial patch, to avoid concurrent-step races. Genuinely additive
  collections (references) use add/remove deltas.

## 4. Activity & signal vocabulary

Agents communicate progress as a small, typed set (Linear, adopted verbatim). The Task/Run
**state is derived** from the latest meaningful activity — agents do not set state directly.

| Activity | Fields | Drives state to | Ephemeral allowed? |
|----------|--------|-----------------|--------------------|
| `thought` | `body` | (no change) — reasoning/ack | ✅ yes |
| `action` | `action`, `parameter`, `result?` | (no change) — a tool invocation, for audit | ✅ yes |
| `elicitation` | `body` (+ signal) | `input-required` | ❌ no |
| `response` | `body` | `completed` | ❌ no |
| `error` | `body` | `failed` | ❌ no |
| `prompt` | `body` | (human→agent) resumes `working` | ❌ no |

- **Ephemeral** `thought`/`action` render transiently and are replaced by the next activity —
  this is how we stream "thinking…/running tool X…" without cluttering the permanent record,
  over plain HTTP (no agent-side WebSocket required).
- **Markdown** is allowed in `body`. The permanent record is the non-ephemeral activities.

### Signals (typed overlay on an activity)
Open enum; initial set from Linear, extended for gates:

| Signal | Direction | On | Renders as | Metadata |
|--------|-----------|----|-----------|----------|
| `stop` | human → agent | `prompt` | "Stop request" delivered to agent; agent must cease and emit `response`/`error` | — |
| `auth` | agent → human | `elicitation` | "Link account to continue" → `auth-required` | `url, userId, providerName` |
| `select` | agent → human | `elicitation` | clickable options (e.g. **Approve / Request changes / Reject**) | `options[]` |
| `approve` / `reject` | human → agent | `prompt` | gate resolution | optional feedback |

> The **approval gate** is literally an `elicitation` with a `select` signal whose options are
> Approve / Request changes / Reject. We did not invent a new gate primitive — gates reuse the
> activity+signal model.

## 5. SLAs & timeouts (normative)

| SLA | Default | Effect on miss |
|-----|---------|----------------|
| Webhook/HTTP ack | ~5s | Delivery retried |
| First activity after `claim` | ~10s | Run marked *unresponsive* |
| Heartbeat interval | ≤ claim TTL | — |
| Claim TTL (no heartbeat) | ~15 min **⚠️ OPEN** | Run **reclaimed**; Task → `submitted` |
| Stale (no activity, recoverable) | ~30 min | Run *stale*; any activity recovers it |
| Circuit breaker | 2 consecutive failed runs **⚠️ OPEN** | Card auto-blocks; needs human resume |
| Stage max runtime | per-stage, optional | Run → `timed_out` |

All deadlines are enforced server-side (Board DO alarms + Workflows). An agent that dies
silently is reclaimed; an agent that is slow-but-alive recovers by emitting activity. This is
the honest-liveness contract (Principle 10).

## 6. Surface mapping (preview)

The same verb on two surfaces — full detail in `05-integration-surfaces` (planned):

| Verb | MCP tool (`tools/call`) | REST endpoint |
|------|--------------------------|---------------|
| `claim` | `kaambaan_claim_card` *(not read-only, not idempotent)* | `POST /v1/boards/:id/claims` |
| `getCard` | `kaambaan_get_card` *(`readOnlyHint: true`)* | `GET /v1/boards/:id/runs/:runId` *(run-scoped — [05 §3](./05-integration-surfaces.md))* |
| `heartbeat` | `kaambaan_heartbeat` | `POST /v1/runs/:id/heartbeat` |
| `activity` | `kaambaan_post_activity` | `POST /v1/runs/:id/activities` |
| `requestInput` | `kaambaan_request_input` | `POST /v1/runs/:id/activities` (elicitation) |
| `addReference` | `kaambaan_add_reference` | `PUT /v1/cards/:id/references` |
| `submitForReview` | `kaambaan_submit_for_review` | `POST /v1/runs/:id/submit` |
| `complete` | `kaambaan_complete` | `POST /v1/runs/:id/complete` |
| `block` / `release` / `fail` | `kaambaan_block` / `_release` / `_fail` | `POST /v1/runs/:id/{block,release,fail}` |

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

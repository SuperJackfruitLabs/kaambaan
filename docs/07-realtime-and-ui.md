# 07 — Realtime & UI

How the board stays live, what the Event log records, and the surfaces the operator sees. The
realtime layer doubles as the **audit/observability** layer — the same event stream that renders
a live card is the immutable trail and the testing assertion target.

## 1. Realtime architecture

- The **Board Durable Object** is the live authority and the **WebSocket hub** (hibernatable
  WebSockets keep idle cost ~zero). UI clients connect through the edge Worker, which authorizes,
  then attaches the socket to the board's DO.
- Every state change is an **Event** appended in the DO and **broadcast** to connected clients.
- Updates are **epoch-stamped** (the run's lease epoch — see
  [08](./08-reliability-and-durable-execution.md)) so a client can **discard stale updates** from a
  reclaimed/zombie attempt.
- The agent-facing stream (an agent's native progress) is bridged to the board via **AG-UI** events
  behind per-harness adapters: *native stream → AG-UI events → board*. Agents never need to speak
  WebSocket; they POST normalized activities ([05 §1](./05-integration-surfaces.md)) and the DO fans
  them out.

```
agent (native stream) ──adapter──► normalized activity ──► Board DO ──WS broadcast──► UI clients
                                                            │ append
                                                            ▼
                                                       Event log (audit)
```

## 2. The Event log = observability vocabulary

The Event/Activity log aligns with the **OTel-GenAI / OpenInference / Langfuse consensus** so it
is both a product feature (live board + audit) and standards-compatible telemetry. Record shape:

```jsonc
{
  // identity & hierarchy
  "traceId": "…", "spanId": "…", "parentId": "…", "path": "/pipeline/stageB/run/tool",
  "sessionId": "card_…",            // a CARD's life = a session (universal grouping key)
  "tenantId": "…", "userId": "…",
  // type — span-KIND enum (not OTel operation-verbs), plus Kaambaan kinds
  "kind": "AGENT | LLM | TOOL | CHAIN | RETRIEVER | GUARDRAIL | STAGE_TRANSITION | PIPELINE",
  "name": "…",
  // Kaambaan audit dimensions (no standard has these — we add them)
  "boardId": "…", "cardId": "…", "stageFrom": "research", "stageTo": "review",
  // agent/tool/model
  "agentId": "…", "toolName": "…", "toolCallId": "…", "model": "…", "provider": "…",
  // I/O (redaction-gated; privacy-sensitive per all standards)
  "input": "…", "output": "…",
  // tokens & cost — input/output naming (not prompt/completion); cost first-class
  "inputTokens": 1200, "outputTokens": 300, "totalTokens": 1500,
  "inputCost": 0.01, "outputCost": 0.02, "totalCost": 0.03, "currency": "USD",
  // status & timing
  "status": "OK | ERROR | UNSET", "errorType": "…", "finishReason": "…",
  "startTime": "…", "endTime": "…", "latencyMs": 820,
  // audit
  "createdAt": "…", "recordedBy": "…", "schemaVersion": 1
}
```
Opinionated choices: **`sessionId` = card-run**; **`tenantId` on every record**; **span-kind enum**
(+ `STAGE_TRANSITION`, `PIPELINE`); **input/output token naming**; **cost stored first-class** and
**estimated** from tokens × model pricing when the agent doesn't report it; **materialized `path`**
beside `parentId` for cheap subtree queries.

## 3. Status taxonomy (per card / run)

The board's value over a chat is a crisp, glanceable status — and a distinct **"Needs your input"**
that drives notifications (Crystal's clearest-in-field model). Mapped to A2A state
([03](./03-card-lifecycle.md)):

| Status chip | Underlying | Notify? |
|---|---|---|
| **Ready** | `submitted` | — |
| **Working** | `working` + recent heartbeat | — |
| **Needs your input** | `input-required` (question) | 🔔 owner |
| **Needs auth** | `auth-required` | 🔔 owner |
| **Review / Gate** | `input-required` (`select`) | 🔔 approver(s) |
| **Went dark / Reclaimed** | heartbeat lost → reclaim | 🔔 owner |
| **Done** | `completed` | optional |
| **Rejected** | `rejected` | 🔔 owner |
| **Failed** | `failed` | 🔔 owner |

Optional **confidence overlay** (Devin's 🟢🟡🔴): an agent may attach a confidence to a `response`;
low confidence can route to a human earlier. **⚠️ OPEN** for v1.

## 4. Board UI surfaces

- **Board view** — columns = pipeline stages; cards show title, owner avatar, **delegate agent**
  badge, status chip, priority, reference counts, a progress pill (`N/M` subtasks/stages),
  WIP-limit indicators.
- **Card drawer** —
  - **Spec & references** (links to GitHub PR/issue, repo, docs).
  - **Activity timeline = session replay**: the time-ordered waterfall of activities/events
    (AgentOps-style), with ephemeral "thinking/running tool…" rendered transiently.
  - **Attempts** (see §5).
  - **Handoff metadata** passed from the prior stage.
  - **Gate panel** when in review: Approve / Request changes / Reject (the `select` signal),
    diff/artifact viewer, and **inline comments that become a follow-up message to the agent**
    (the universal "comment → follow-up" primitive from Vibe Kanban/Conductor/Sculptor —
    generalized beyond code to any artifact).
- **Agent dashboard** — registered agents, online/busy/offline, current load vs concurrency, recent
  runs, capability tags.

## 5. Attempts (compare runs across agents/models)

A Task can have multiple **Attempts** (= Runs, [01](./01-domain-model-and-glossary.md)), each pinned
to a profile `{ harness, model, base ref, prompt snapshot }`. The drawer can show attempts
**side-by-side** (outputs/diffs/cost) so an operator can sample the solution space — "Claude attempt
vs Codex attempt on the same card." Rejecting at a gate **spawns a new attempt** rather than mutating
the old one (immutability, [03](./03-card-lifecycle.md)). This is Vibe Kanban's single best idea.

## 6. Cost, usage & budgets (a deliberate differentiator)

Almost every local-first competitor ships **zero** cost/observability — we make it first-class:
- **Metering** per `tenant · board · card · attempt · agent · model`, summed from activity `usage`
  ([05 §1](./05-integration-surfaces.md)) and estimated when unreported.
- **Budget caps**: per-card / per-tenant ceilings (Devin's `max_acu_limit`, Cursor's spend limit). A
  run that would exceed its cap blocks at a gate instead of proceeding.
- **Show expected cost before running** a stage where possible (Devin's pre-run estimate).
- **Rolling windows** (Factory's 5h/weekly/monthly) for tenant usage views. **⚠️ OPEN**: pricing
  model (pass-through vs credits) — out of scope for the spec, but the metering schema supports both.

### Implementation (P6)

Each agent activity may carry `usage` (`model`, `inputTokens`, `outputTokens`, `costUsd`). The Board
DO records it in `usage_records`; cost is the reported `costUsd` or, when absent, **estimated** from
`tokens × model pricing` (`apps/api/src/metering/pricing.ts`) and flagged `estimated` so operators
see what's modeled vs reported. Surfaces:

- **Per-card cost** (`CardView.costUsd` + `overBudget`) and a **board rollup** (`BoardSnapshot.usage`:
  total, estimated, caps, `overBudget`) in every snapshot/live update; `GET /v1/boards/:id/usage`
  returns the full breakdown (by model · agent · card).
- **Budget caps** via `PUT /v1/boards/:id/budget` (`boardUsdCap`, `cardUsdCap`). Enforced two ways:
  the board cap **stops new claims** (a run can't start work it can't pay for), and once a cap is hit
  `postActivity` **rejects further billable activities** (`BUDGET_EXCEEDED`) so an in-flight run can't
  blow past the ceiling — overrun is bounded to the single activity that crossed it. A per-card cap
  also flags the card red. (Caps are a coarse dollar gate, not exact billing — see the `cost_usd REAL`
  note.) Invalid `usage` (negative/non-finite) is rejected at the DO so every wire shares the guard.
- The board UI shows a `$spent / $budget` header chip and a per-card cost (red when over its cap).

`usage` flows over both wires (REST `runs/:id/activities`, MCP `kaambaan_post_activity`).

**Follow-up slices (delivered):**
- **Attempts** (§5) — `getAttempts(cardId)` lists each run with its agent · model · cost · outcome;
  `CardView.attemptCount` + a click-to-expand comparison on the card. `GET …/cards/:id/attempts`.
- **Rolling windows** (§6) — `getUsage({window})` (`5h`/`7d`) filters the rollup to recent spend
  (`src/metering/window.ts`). Within a board DO; cross-board/tenant aggregation still pending.
- **Pre-run estimate** (§6) — `estimateCardCost(cardId)` averages historical runs at the card's stage
  (`GET …/cards/:id/estimate`).
- **AG-UI adapter** (§1) — `normalizeClaudeStreamLine` translates Claude Code `stream-json` →
  normalized activities (`packages/agent-sdk/src/claude-code.ts`, re-exported from `@kaambaan/agent-sdk`); a bridge POSTs
  each, including usage. It lives in the SDK because that is what a bridge imports — inside the
  Worker it had no caller and could not have had one.
- **In-app notifications** (§7) — notify-worthy transitions (gate opened, failed, reclaimed) record a
  notification for the card owner; `getNotifications`/`markNotificationRead`, a 🔔 unread badge + feed.

- **⚠️ Remaining**: **cross-board/tenant** usage rollup + rolling windows over the D1 catalog;
  **email + Slack** delivery and the **Slack interactive gate-resolve** endpoint (both need an
  operator-configured app: Slack signing secret + bot token, an email provider); and more harness
  adapters (Codex NDJSON, OpenCode SSE).

## 7. Notifications

Triggered by the status chips marked 🔔 above. Channels: in-app, email, and **Slack** (the proven
primary surface for agent HITL — HumanLayer/Devin/Factory all lead with it). A gate notification
carries the typed actions so a human can **Approve / Request changes / Reject directly from Slack**
([08](./08-reliability-and-durable-execution.md) defines the resolve flow).

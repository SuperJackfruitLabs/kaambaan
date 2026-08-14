# 08 — Reliability & Durable Execution

Kaambaan coordinates agents it does **not** run, on machines it does **not** control. So the central
reliability problem is: *track an external, possibly-flaky process as a durable state machine, detect
when it dies, reclaim its work safely, and pause indefinitely for humans without burning resources.*

We borrow **Temporal's** semantics (activity heartbeat + reclaim, timeouts, idempotency, signals as
durable waits) and implement them on **Cloudflare Durable Object alarms**. The DO's single thread is
our serialization point — it gives us atomic claims and sidesteps the "node re-executes on resume"
idempotency hazard that in-process frameworks (LangGraph) have to warn about.

## 1. Where durability lives

| Concern | Home | Why |
|---|---|---|
| Authoritative card/task/run state machine | **Board DO** (SQLite) | Single-writer, strongly consistent, atomic |
| Atomic claim, WIP/concurrency limits | **Board DO** | Single thread = natural lock |
| Lease, heartbeat, reclaim, timeouts | **Board DO alarms** | Per-entity timers that wake an idle DO |
| Gates (pause for human) | **Board DO state** (`input-required`) + alarm for timeout/escalation | Durable, zero-cost wait |
| Webhook delivery, GitHub reconciliation, scheduled cards | **Queues + Workflows** | Multi-step, retrying, idempotent async side-tasks |

> **Why not a Workflow per agent run?** Cloudflare Workflows shine when *we* execute the steps. Here
> the run is an **external** event-driven process (claim → heartbeats → activities → complete) we only
> *observe*, so a DO event-sourced state machine is the truer fit. We still use Workflows for our own
> async side-tasks. (`step.waitForEvent` is the Workflow analog of our DO-held gate; we note it as the
> alternative but choose DO-centric for the core loop.)

## 2. Lease & fencing (safe reclaim)

On `claim`, the DO records a **lease**:
```jsonc
{ "runId":"…", "taskId":"…", "agentId":"…",
  "leaseEpoch": 1,                      // fencing token — bumped on every (re)assignment
  "lastHeartbeatAt":"…", "heartbeatTimeoutMs": 900000 }
```
- The agent includes its `leaseEpoch` on every `heartbeat`/`activity`/`complete`.
- If the lease is **reclaimed**, the DO **bumps `leaseEpoch`**. Any later write from the old
  (zombie) agent carries a stale epoch and is **rejected** — no split-brain. The realtime layer also
  uses the epoch to discard stale UI updates ([07](./07-realtime-and-ui.md)).

## 3. The four timeouts (Temporal mapping → DO alarms)

A DO has **one** alarm; we keep a table of logical deadlines and point the alarm at the **earliest**,
rescheduling in the `alarm()` handler.

| Timeout | Measures | On expiry |
|---|---|---|
| **ScheduleToStart** | ready → claimed (queue wait) | Requeue/notify; **not** a failed attempt |
| **StartToClose** | one attempt's max duration | End attempt → reclaim or `failed` per policy |
| **Heartbeat** | max gap between heartbeats | **Reclaim** (bump epoch); fast death-detection |
| **ScheduleToClose** | total across all attempts | Give up → `failed` (bounds total retries) |

Heartbeats are **throttled client-side** (~0.8× the timeout, Temporal-style) so agents call often but
the DO isn't hammered. On reclaim, the next agent resumes from the **last reported progress**
(Temporal `GetHeartbeatDetails`) carried in the run's persisted activity log.

## 4. Retries, circuit breaker, non-retryable errors

- **Retry policy** for reclaimable failures: exponential backoff (initial ~1s, coefficient 2, capped),
  bounded by `ScheduleToClose` rather than only a max-attempt count.
- **Circuit breaker** (Hermes): after **N** consecutive failed/crashed attempts on a task (default
  **2**, ⚠️ OPEN), the card auto-parks in a **Blocked** state requiring a human to resume — a broken
  agent can never hot-loop a card.
- **Non-retryable errors**: a typed error class (bad input, policy violation, separation-of-duties
  breach) ends the task as `failed` immediately without consuming retries.

## 5. Idempotency (everything is at-least-once)

| Operation | Idempotency key | Enforcement |
|---|---|---|
| Agent dispatch / claim | `${runId}-${leaseEpoch}` | DO rejects duplicate/stale-epoch |
| Verb call (activity, complete, …) | client `Idempotency-Key` header | **⚠️ NOT IMPLEMENTED** — no route reads the header and nothing de-dupes a replayed verb ([05 §3](./05-integration-surfaces.md)) |
| Stage transition | `${cardId}-${stageKey}-${transition}` | `UNIQUE` constraint in DO SQLite → re-apply is a no-op |
| External reference write | `(cardId, url)` | Idempotent upsert ([06](./06-external-references.md)) |
| Webhook delivery | delivery id | Consumer de-dups |

Agents reconstruct state by reading **immutable activities**, never mutable card fields
([04 §3](./04-agent-contract.md)) — the consistency foundation.

## 6. Gates as durable waits

A gate is an `input-required` task ([03](./03-card-lifecycle.md)) held in the DO. The **ApprovalGate**
resource (synthesis of HumanLayer `FunctionCallSpec` + MCP elicitation + LangGraph patterns):

```jsonc
{
  "gateId":"gate_…",          // also the resume token
  "cardId":"…", "runId":"…", "tenantId":"…", "stageKey":"review",
  "kind":"approval | input | choice",
  "state":"pending | approved | declined | edited | expired | cancelled",
  "proposal": { "action":"publish", "args": {…} },   // what the agent wants to do (editable)
  "requestedSchema": {…},                            // MCP restricted flat schema (kind=input)
  "options": [ { "name":"too_risky", "title":"Too risky",
                 "promptFill":"Revise to…", "interactive": true } ],
  "decision": { "action":"accept|decline|cancel|edit", "editedArgs":{…},
                "comment":"…", "optionName":"…", "decidedBy":"user_…", "decidedAt":"…" },
  "policy": { "approvers":[…], "quorum":1, "timeoutMs":86400000,
              "onTimeout":"escalate | reject | auto_approve" },
  "escalation": { "after":"PT4H", "to":[…], "channel":{…} },
  "expiresAt":"…"
}
```

Decisions:
1. **Tri-state-plus**: `accept / decline / cancel / edit` (MCP elicitation's `accept/decline/cancel`
   + LangGraph/HumanLayer **approve-with-edits**). `decline` (informed no → agent gets feedback and may
   retry) ≠ `cancel` (no opinion → card returns to backlog) ≠ `expired` (timeout policy).
2. **Structured options** with `promptFill` (the text fed back to the agent on rejection) and
   `interactive` (allow appended free text) — HumanLayer `ResponseOption`.
3. **Resolve flow** *(as shipped)*: `POST /v1/boards/:boardId/gates/:gateId/resolve` — **board-scoped**,
   behind the human session cookie, **not** CORS-enabled. The DO enforces **separation-of-duties**
   (`403 SEPARATION_OF_DUTIES` — the producer cannot resolve their own gate). A second resolve is a
   typed conflict, `409 GATE_NOT_PENDING`, **not** an idempotent no-op. **⚠️ Approver policy and
   quorum are not implemented.**
4. **Timeout & escalation** are driven by the **DO alarm**, independent of any agent: on `after`,
   widen approvers / notify; on `timeoutMs`, apply `onTimeout`. A slow human never blocks compute; a
   forgotten gate resolves by policy.
5. **Two-tier gates** ([11](./11-prior-art-and-market-scan.md)): a stage may be a *soft* review column
   (advisory) or a *hard* policy gate. **Action-level autonomy** (what an agent may do without asking —
   Factory's Off/Low/Medium/High + allow/deny/blocklist) lives in the agent **profile**
   ([05 §7](./05-integration-surfaces.md)); a denied action surfaces to Kaambaan as an `elicitation`.

## 7. Failure & recovery taxonomy

| Failure | Detected by | Recovery |
|---|---|---|
| Agent crash / VM died | Heartbeat timeout | Reclaim (bump epoch) → re-dispatch from last progress |
| Agent slow but alive | Stale window, recoverable | Any activity recovers it; no reclaim |
| Agent never acknowledges | Ack SLA (~10s) | Marked unresponsive; reclaim on heartbeat timeout |
| Repeated failures | Circuit breaker (N) | Auto-block; human resume |
| Bad input / policy breach | Non-retryable error | `failed` immediately |
| Human never decides a gate | Gate alarm | `onTimeout`: escalate → reject/auto-approve |
| Zombie write after reclaim | Stale `leaseEpoch` | Rejected |
| External state drift (PR merged unseen) | Reconciliation Workflow | Re-sync reference ([06](./06-external-references.md)) |

Every row here is a test in [09 — Testing Strategy](./09-testing-strategy.md).

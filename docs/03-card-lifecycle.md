# 03 — Card Lifecycle & Pipeline

This is the heart of the system. Kaambaan's canonical state machine is the **A2A `TaskState`**
machine; the board's columns are a presentation on top of it, with **human approval gates**
modeled as `input-required`. Reworking finished work creates a *new* task (A2A immutability),
which gives us a free, complete audit history.

## Canonical states (A2A `TaskState`)

| State | Kind | Meaning in Kaambaan |
|-------|------|--------------------|
| `submitted` | active | Task created for a card+stage; not yet picked up by an agent |
| `working` | active | An agent has claimed it and is executing |
| `input-required` | interrupted | Paused, waiting on a human — **clarification OR an approval gate** |
| `auth-required` | interrupted | Paused; the agent needs a credential/account link to proceed |
| `completed` | terminal | Stage work done successfully (artifacts attached) |
| `rejected` | terminal | A human (or agent) **declined** the work at a gate — *not an error* |
| `failed` | terminal | Execution error |
| `canceled` | terminal | An operator pulled the card |

> Terminal states never restart (A2A rule). Advancing a stage, retrying, or reworking always
> creates a **new Task** under the same `contextId`.

## Pipeline columns ⇆ states (the mapping)

A board renders columns; each card sits in a column determined by its current stage and its
current task's state. Finer board columns are *sub-states* carried in `metadata`, never new
top-level states.

| Board column | Underlying state | Notes |
|---|---|---|
| **Backlog** | `submitted` (no task yet) | Card created, awaiting dispatch |
| **Ready** | `submitted` | Eligible for an agent to `claim` in this stage |
| **In Progress** | `working` | Agent executing; activity streams live |
| **Needs Input** | `input-required` (clarification) | Agent asked a question (`elicitation`) |
| **Needs Auth** | `auth-required` | Agent needs account linking (`auth` signal) |
| **Review / Gate** | `input-required` (`select` signal) | **Human approval gate** |
| **Done (stage)** → next stage **Ready** | `completed` → new `submitted` | Handoff to next stage |
| **Rejected** | `rejected` | Declined at a gate (terminal for that task) |
| **Failed** | `failed` | Execution error (terminal) |
| **Canceled** | `canceled` | Operator-pulled (terminal) |

## The pipeline (multi-agent handoff)

A pipeline is an ordered list of stages (see [Domain Model](./01-domain-model-and-glossary.md)).
A card flows stage → stage. **Handoff is a card crossing a stage boundary:**

```
Stage A (owner: research)        Stage B (gate: approval)      Stage C (owner: publish)
 ┌──────────────┐  complete       ┌──────────────┐  approve     ┌──────────────┐
 │ Task A1      │ ───────────────►│ (human gate) │ ────────────►│ Task C1      │
 │ working→done │  + handoff meta │ input-required│  new task    │ working→done │
 └──────────────┘                 └──────────────┘              └──────────────┘
        contextId = card.contextId  (shared across A1, gate, C1, …)
```

1. The card enters Stage A's **Ready** column; a Task `A1` is created (`submitted`).
2. An agent whose capabilities match Stage A's `owner` **claims** `A1` → `working`.
3. The agent works, streaming activities, then calls **`complete`** with a **structured
   handoff** `metadata` payload → `A1` is `completed`.
4. Kaambaan advances the card to Stage B. If Stage B is a **gate**, the card waits in **Review**
   (a task in `input-required` + `select` signal). Otherwise a new Task is created for Stage B
   and becomes claimable.
5. On approve, the card advances to Stage C's **Ready**; a new Task `C1` is created. The Stage
   C agent reads `A1`'s handoff metadata at pickup (Hermes-style structured handoff).

### Structured handoff (between stages)

Every `complete` carries machine-readable context for the next stage — strictly better than a
free-text comment. Shape (illustrative; finalized in the contract):
```json
{
  "summary": "Drafted the migration plan and validated against staging.",
  "outputs": ["artifact://...", "https://github.com/org/repo/pull/42"],
  "verification": ["staging smoke tests passed"],
  "residualRisk": ["prod data volume untested"],
  "next": "Reviewer should confirm rollback steps before approving."
}
```
The next stage's agent receives this as part of its context bundle on `claim`. **⚠️ OPEN**:
how much of the handoff schema is fixed vs free-form per board.

## Approval gates in detail

A gate is the product's signature feature. It is **not** a new state — it is an
`input-required` task carrying a `select` signal that renders typed actions:

- **Approve** → card advances to the next stage (new Task created there).
- **Request changes** → the *same stage* re-opens with the human's feedback delivered to the
  agent as a `prompt`; a new Run (attempt) begins. The task returns to `working`.
- **Reject** → task becomes terminal `rejected`; the card parks in the Rejected column (the
  human owner decides whether to clone/rework it).

Gates may also be **policy gates** (auto-approve under conditions) — **⚠️ OPEN** for v1; the
human gate is the baseline.

There is a second, finer kind of approval — **action-level** approval (which shell commands /
tools an agent may run). That lives on the *agent's* side (its harness's permission model) and
is out of Kaambaan's scope, though an agent may surface it to us via an `elicitation` + signal.

## Rework & immutability

Because terminal tasks never restart:
- "Reopen a Done card" = create a **new Task** under the same `contextId`, in the chosen stage.
- The card's full history is the ordered list of its tasks and their runs — nothing is mutated
  or lost. This is our audit story and our replay foundation.

## Liveness, failure, and reclaim

Borrowed from Hermes, expressed over the wire (since we don't own the agent process):

- **Acknowledgement SLA** — **⚠️ not implemented.** Intended: first activity within ~10s or the run
  is marked *unresponsive*. Nothing measures ack latency today.
- **Heartbeats** — a working run must `heartbeat` periodically. Missing heartbeats past the
  **claim TTL** (**15 min**, hardcoded as `HEARTBEAT_TIMEOUT_MS`) → the run is **reclaimed**: the
  card returns to `submitted` (claimable again) and the prior run is recorded as `reclaimed`, with
  the lease epoch bumped so a zombie write is refused. A new agent picking it up sees the prior
  run's context.
- **Stale (recoverable)** — **⚠️ not implemented** as a distinct state. Any activity refreshes the
  same heartbeat clock, so a slow-but-alive agent stays alive; there is no separate *stale* window.
- **Circuit breaker** — after **2** consecutive failed/reclaimed runs (`CIRCUIT_BREAKER_LIMIT`,
  hardcoded), the card auto-parks in `input-required` requiring a human to resume. Prevents a broken
  agent from hot-looping a card.
- **Timeouts** — **⚠️ not implemented.** `StageDef` has no `maxRuntime` field.

The two enforced deadlines (heartbeat reclaim at 15 min, circuit breaker at 2) are tracked by the
Board DO via its single alarm. There are **no Workflows** in the deployment ([02](./02-architecture.md)).

## State-transition table (normative — feeds TDD)

| From | Event | To | Side effects |
|------|-------|----|--------------|
| (none) | card enters stage | `submitted` | Task created, card in Ready |
| `submitted` | agent `claim` | `working` | Run created, `delegateAgentId` set, ack timer armed |
| `working` | `complete` | `completed` | handoff metadata stored; card advances. **⚠️ `activity(response)` does NOT do this** — it is recorded and the card stays `working` ([04 §4](./04-agent-contract.md)) |
| `working` | `request_input`/`elicitation` | `input-required` | gate/question rendered |
| `working` | `auth` signal | `auth-required` | "link account" rendered |
| `working` | `fail` | `failed` | run outcome `failed`; breaker++. **⚠️ `activity(error)` does NOT do this** — the card stays `working` |
| `working` | heartbeat timeout | `submitted` (reclaim) | run `reclaimed`; breaker++ |
| `working` | operator cancel | `canceled` | run `canceled` |
| `input-required` (gate) | human **approve** | `completed` → next stage `submitted` | advance |
| `input-required` (gate) | human **request changes** | `working` | new run; feedback as `prompt` |
| `input-required` (gate) | human **reject** | `rejected` | terminal; card → Rejected |
| `input-required` (question) | human reply (`prompt`) | `working` | run resumes |
| `auth-required` | account linked | `working` | run resumes |
| terminal (`completed/rejected/failed/canceled`) | rework | new Task `submitted` | same `contextId` |

> Every row in this table is a test case. See [09 — Testing Strategy](./09-testing-strategy.md).

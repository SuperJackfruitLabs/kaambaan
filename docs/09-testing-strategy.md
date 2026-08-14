# 09 — Testing Strategy (TDD)

Kaambaan is built **docs-first → test-first**. The normative tables in the specs are not
documentation flavour — each row is an executable test written **before** its implementation.
This doc defines the method, the layers, and the suites that must exist.

> **⚠️ This is the method and the target, not a description of current coverage.** Where it says a
> suite "must exist", some do and some do not. Known gaps as of today: **§5's conformance kit** is a
> single in-repo test (`apps/api/test/conformance.test.ts`) driving the SDK through the loop, not a
> standalone runner an external author can point at their own agent, and it does not run the agent
> over MCP or report a capability matrix; **KV and R2 bindings named in §2 do not exist**; and the
> **property-based tests** in §6 and the **coverage-by-normative-table** rule in §7 are not
> implemented. The lesson that produced this warning is in the row below: a claim asserted only in a
> pure unit test can pass forever while production does something else — `deriveStateFromActivity`
> did exactly that ([04 §4](./04-agent-contract.md)). **Test the claim where the behaviour lives.**

## 1. The TDD loop

1. Pick a normative statement (a row in a state-transition / gate / failure table, or a contract
   verb). 
2. Write a **failing test** that asserts it (red).
3. Implement the minimum to pass (green).
4. Refactor with the test as a safety net.
5. The spec, the test, and the code stay in lockstep — a spec change starts with a test change.

**Contract-first**: the zod schemas in `packages/contract` are the single source of truth for
shapes. Tests import them; runtime validates against them; we never hand-redefine a payload in a
test.

## 2. Test pyramid

| Layer | Scope | Tooling |
|---|---|---|
| **Unit** | Pure logic: the state-machine reducer, routing/claim selection, gate policy evaluation, zod schema validation, cost estimation | Vitest (node) |
| **Component (DO/Worker)** | A Board DO or Worker in isolation with real bindings (SQLite, KV, R2, alarms) | **`@cloudflare/vitest-pool-workers`** (Miniflare) |
| **Contract** | Each verb over **both** MCP and REST yields identical state changes | Vitest + in-process Worker |
| **Conformance kit** | An external agent's implementation against a live test board (§5) | Standalone runner |
| **Integration** | Multi-component flows: claim→activity→gate→advance; webhook→reconciliation | vitest-pool-workers + mocked GitHub |
| **E2E** | The board UI: drag, live updates, gate approval | Playwright |

Keep the base wide (most logic is pure reducers and schema checks) and the top thin.

## 3. Testing Durable Objects, alarms & Workflows

The reliability model ([08](./08-reliability-and-durable-execution.md)) is alarm- and time-driven,
so deterministic time control is essential.

- **`@cloudflare/vitest-pool-workers`** runs tests *inside* the Workers runtime with real DO/D1/
  R2/KV/Queues bindings. Use `runInDurableObject(stub, (instance, state) => …)` to poke internal
  state and `runDurableObjectAlarm(stub)` to fire alarms on demand.
- **Mock the clock**: inject a clock into the DO (never call `Date.now()` directly in logic) so
  tests can advance time to trip ack/heartbeat/StartToClose/gate-timeout deadlines precisely.
- **Alarm assertions**: assert the single alarm always points at the *earliest* logical deadline
  after each scheduling change ([08 §3](./08-reliability-and-durable-execution.md)).
- **Workflows**: test our async side-tasks (webhook delivery, GitHub reconciliation) as steps with
  injected failures to verify retry/backoff and idempotent re-entry; assert `step.do` memoization
  means a re-run doesn't double-deliver.

## 4. Required suites (mapped to the specs)

| Suite | Asserts | Source |
|---|---|---|
| **State machine** | Every row of the transition table; illegal transitions rejected | [03 §"State-transition table"](./03-card-lifecycle.md) |
| **Atomic claim** | Concurrent claims hand a card to exactly one agent; WIP + concurrency enforced | [02](./02-architecture.md), [04](./04-agent-contract.md) |
| **Pipeline handoff** | Completing a stage advances the card, creates a new Task under the same `contextId`, and delivers prior-stage handoff metadata | [03](./03-card-lifecycle.md) |
| **Gate matrix** | `accept / decline / cancel / edit / expire / escalate`; double-resolve no-ops; **separation-of-duties** (author can't approve own gate) | [08 §6](./08-reliability-and-durable-execution.md) |
| **Lease & reclaim** | Heartbeat timeout reclaims and bumps epoch; **zombie write with stale epoch rejected**; next agent resumes from last progress | [08 §2–3](./08-reliability-and-durable-execution.md) |
| **Idempotency** | Replayed verbs / dispatches / transitions are no-ops; reference upsert dedups on `(cardId,url)` | [08 §5](./08-reliability-and-durable-execution.md) |
| **Circuit breaker** | N consecutive failures auto-block; no hot-loop | [08 §4](./08-reliability-and-durable-execution.md) |
| **Contract parity** | Same verb via MCP and REST → identical state + events; MCP business failure = `isError:true` not transport error | [05](./05-integration-surfaces.md) |
| **GitHub sync traps** | (a) keywords ignored on non-default base ref; (b) `includeClosedPrs:true` needed for merged PRs; (c) CI-approval gate modeled; signature verify + delivery dedup | [06 §3](./06-external-references.md) |
| **Multi-tenant isolation** | No cross-tenant read path; a tenant-scoped token cannot touch another tenant's board/DO; every event carries `tenantId` | [02](./02-architecture.md) |
| **Observability** | Each stage emits a `STAGE_TRANSITION` with correct `stageFrom/stageTo`; LLM-kind records carry token + cost; gate rejection produces the expected record | [07 §2](./07-realtime-and-ui.md) |

## 5. The agent conformance kit

A first-class deliverable: a runnable suite an external agent author points at a throwaway board to
certify **"Kaambaan-compatible"** ([04 conformance](./04-agent-contract.md)). It drives the agent
through: register → claim → ack within SLA → heartbeat → stream activities → request input →
submit for review → handle approve/decline → complete with handoff → behave on reclaim. It runs the
same agent over **MCP and REST** and reports a capability matrix. This both protects the contract
from drift and lowers integration cost for the "any harness" promise.

## 6. Fixtures, factories, determinism

- **Factories** build valid entities from the zod schemas (a `makeCard`, `makeBoard`,
  `makeAgentToken`) so tests state only what they care about.
- **Deterministic clock + ids** injected everywhere (no ambient `Date.now()`/random in logic) — this
  is what makes alarm/timeout tests reliable and replayable.
- **Mocked external services**: a fake GitHub (webhooks + GraphQL) and a scriptable fake agent.
- **Property-based tests** for the reducer and idempotency (random verb sequences must never reach
  an illegal state or double-apply).

## 7. CI gates

- Type-check + lint + `contract` schema build.
- Full unit + DO/component + contract suites on every PR; integration + a smoke E2E on merge.
- The conformance kit runs against the reference worker as a release gate.
- **Coverage is judged on the normative tables**, not a global %: every spec table row must have a
  corresponding test id.

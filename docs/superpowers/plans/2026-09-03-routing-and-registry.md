# Smarter routing and a fuller registry — implementation plan

**Status:** complete. Deviations recorded below.
**Spec:** `docs/superpowers/specs/2026-09-03-routing-and-registry-design.md`

## Global constraints

- Routing stays **exact string equality** on every member. No similarity, no scoring.
- Nothing crosses the Durable Object / catalog boundary. The DO gets a flat set.
- Every new test is reverted and confirmed failing before the fix is accepted.

## Slices, as built

| | what | where |
|---|---|---|
| S1 | `requires: {all,any}` on a stage; shared predicate | contract, `board-do`, `capabilities.ts` |
| S2 | implication edges + transitive closure | migration 0007, `implications.ts`, claim + MCP seams |
| S3 | `inputModes`/`outputModes` columns | migration 0007 |
| S4 | AgentCard projection | `agent-card.ts`, `GET /v1/agents/:id/card` |
| S5 | near-duplicate hint | `similarKeys`, capability create route |
| S6 | editors and the Capabilities tab | `NewBoardDialog`, `BoardSettings`, `CapabilitiesTab` |

## Deviations from the spec

**1. `requires` is a sibling of `owner`, not a union on it.** The spec proposed
this and the reason was confirmed by probe before any code was written: SQLite's
`json_each` returns zero rows over a missing path but raises `malformed JSON`
over a scalar. A union would have made `boardCount` throw on every existing
stage.

**2. Two bugs found mid-build that the spec did not anticipate.**
`capabilityUsage` carried the *same* scalar-only `$.owner` predicate as
`boardCount`, so a capability required only by a set-valued lane reported no
users and could be deleted out from under the board needing it. And adding
implications created a second way to reference a capability, which the same
function did not count — deleting one end of an edge would have left an agent's
effective set holding a capability the registry could not explain. Both fixed,
both pinned by tests.

**3. The AgentCard's degraded-skill case is a unit test, not a REST test.**
Every write path registers and a referenced capability cannot be deleted, so the
state is unreachable through the routes — which is why it is pinned at the
function instead. A card that omits a tag the agent routes on disagrees with the
claim predicate, and "filter out the ones we can't describe" is an easy tidy-up
someone would otherwise make later.

**4. `AGENT_CARD_VERSION` versions the projection, not the agent.** A2A requires
a `version` on the card; kaambaan has no per-agent version and inventing one
would be a field that never changes.

## Not done, deliberately

Fit scoring, a reservation window, `demonstrated` provenance and honest
cross-board concurrency all need run history, and the catalog has no `runs`
table — migration `0005`'s own comment says outcomes are "knowable from `runs`
in the board DO". That boundary deserves its own decision, not a smuggled
crossing inside a routing change.

Federation and an OASF consumer contradict
`decisions/2026-08-15-a-grant-names-an-agent-per-plane.md` and need a charter
record first.

## Verification

- 673 tests (contract 76, web 41, api 556), up from 629
- 38 e2e passing
- `pnpm -r typecheck`, `pnpm -r build`, `svelte-check` all clean
- migration 0007 executed against a 0006-shaped database before being wired up
- the `boardCount` fix reverted and confirmed to fail all four of its tests

## Known gap

The editors' requirement round-trip lives in `.svelte` components and `apps/web`
still has no component render harness, so it is covered by typecheck and by hand
rather than by a test. The predicate underneath is tested in the contract
package, which is where the routing decision lives.

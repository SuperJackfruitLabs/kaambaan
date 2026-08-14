# Kaambaan — Documentation

> **Kaambaan** is a multi-tenant Kanban board that orchestrates **external AI agents**.
> The board is the control plane; the agents bring their own runtime. Work flows
> through pipeline stages with human approval gates.
>
> *Name:* **काम** (*kaam*, "work") + **बाण** (*bāṇ*, "arrow") — the arrows of work you fire
> toward Done; also a nod to **Kanban**. Pronounced ~"kaam-baan".

## Start here

**Integrating from outside this repo?** Read **[05 §2 and §3](./05-integration-surfaces.md)** and
nothing else first. That is the only place that describes the wire as it actually is, including what
does not exist. Then [04](./04-agent-contract.md) for the loop and the elicitation return path.

Two things to know before you design anything:

- **`@kaambaan/agent-sdk` and `@kaambaan/contract` are `private: true` and unpublished.** Nothing
  outside this repo can depend on them. You will be making HTTP calls yourself.
- **`/mcp` has no OAuth authorization server.** It is a Resource Server *shell* over a bearer token.
  Configure your client with a `kbn_` token; do not build an authorization flow.

## How to read these documents

Every document here is one of three things, and the table says which. This matters because a
document that describes behaviour far from its code, with no check on it, drifts silently — which is
how the OAuth, magic-link and idempotency claims survived long enough to be cited by an external
team as though they were true.

| Kind | What it means | How much to trust it |
|---|---|---|
| 📐 **Spec** | Normative design intent. Some of it is built, some is not. | Only where it is marked ✅ shipped or ⚠️ not built. Assume nothing in between. |
| 🗓 **Decision** | What was decided, when, and why. A record, not a status. | Trust it as history. It does not claim to describe today. |
| 🔍 **Description** | What the code does now, written beside the code and cheap to re-verify. | Trust it, and report drift as a bug. |

Where a document mixes kinds — most do — the shipped parts are called out inline as
**"as shipped"**, **✅ enforced**, or **⚠️ not built / not implemented**. An unmarked normative
sentence in a 📐 Spec is an *intention*, not a promise about the running system.

**⚠️ OPEN** marks a decision deliberately left unresolved.

## The documents

| # | Doc | Kind | What it answers | Drift status |
|---|-----|:----:|-----------------|--------------|
| 00 | [Vision & Principles](./00-vision-and-principles.md) | 🗓 | Why Kaambaan exists, what it is and isn't, the 10 principles | Stable — a statement of intent, not of state |
| 01 | [Domain Model & Glossary](./01-domain-model-and-glossary.md) | 📐 | The nouns: Tenant, Board, Card, Run, Agent, Activity, Signal, Elicitation, Reference | ⚠️ **Task is not implemented** — the A2A state lives on the Card. Flagged inline |
| 02 | [Architecture](./02-architecture.md) | 📐 | Cloudflare topology, multi-tenancy, auth | ⚠️ Only D1 + the Board DO + ASSETS are bound. R2/KV/Queues/Workflows are intent. Auth table is now ✅ accurate |
| 03 | [Card Lifecycle & Pipeline](./03-card-lifecycle.md) | 📐 | The A2A state machine, stages, gates, handoff, rework | Transition table ✅ corrected; ack-SLA / stale / stage-timeout marked ⚠️ not built |
| 04 | [Agent Contract](./04-agent-contract.md) | 📐 + 🔍 | The verbs, identity, activities, signals, SLAs, the elicitation return path | ✅ §1 identity, §4 elicitation and §5 SLAs are current. `discover` and idempotency marked ⚠️ not built |
| 05 | [Integration Surfaces](./05-integration-surfaces.md) | 🔍 + 📐 | **MCP + REST as they actually are**; harness adapters; push; triggers | ✅ §2–§3 are the verified surface. §5–§7 are intent with implementation notes |
| 06 | [External References](./06-external-references.md) | 📐 + 🔍 | Linking GitHub issues/PRs; draft-PR sub-state; webhook + GraphQL reconciliation | Has an "Implementation (P5)" section with ⚠️ remaining work |
| 07 | [Realtime & UI](./07-realtime-and-ui.md) | 📐 + 🔍 | WebSocket board, AG-UI adapters, status taxonomy, attempts, cost/metering | Has an "Implementation (P6)" section with ⚠️ remaining work |
| 08 | [Reliability & Durable Execution](./08-reliability-and-durable-execution.md) | 📐 | Heartbeat + fenced reclaim, the four timeouts, idempotency, gates as durable waits | ⚠️ **Largely unbuilt.** Heartbeat reclaim + circuit breaker + fencing are real; the four-timeout model, retry policy, gate policy/quorum/escalation and `Idempotency-Key` are not |
| 09 | [Testing Strategy](./09-testing-strategy.md) | 📐 | The TDD loop, test pyramid, DO/alarm testing, required suites, conformance kit | Method is followed; the conformance kit and several named suites do not exist yet |
| 10 | [Roadmap](./10-roadmap.md) | 🗓 | Phased delivery P0→P7 and what shipped as v0.0.1 | Historical record; P0–P14 shipped |
| 11 | [Prior Art & Market Scan](./11-prior-art-and-market-scan.md) | 🗓 | The landscape and what we took from it | Dated research; not a status document |
| 12 | [Deploy (Cloudflare)](./12-deploy.md) | 🔍 | One Worker, same-origin; continuous deploy, bindings, secrets, D1 migrations | ✅ Current runbook |
| 13 | [Linear Parity Program](./13-linear-parity-program.md) | 🗓 | The proposed post-v0.0.1 program (P15+) | Proposed, not started |

Also documentation, and treated as such: the **header comments** on `apps/api/src/index.ts`,
`apps/api/src/mcp/auth.ts`, `apps/api/src/board/elicitation.ts`, `packages/contract/src/activity.ts`
and `packages/agent-sdk/src/index.ts`. They sit beside their code (🔍) and are the first thing to
correct when behaviour changes.

## What is checked, not just written

Preferring a check over a claim is the point of this section — it lists the places where a
documented statement will fail CI if it stops being true.

| Claim | Check |
|---|---|
| Run verbs and the run read refuse another agent's run with `403 NOT_RUN_OWNER`, distinct from `409 STALE_LEASE` | `apps/api/test/agent-run-identity.test.ts` (all seven verbs, REST + MCP) |
| An agent reads only the run it holds; the board snapshot and card list are not agent-readable | `apps/api/test/agent-run-context.test.ts` |
| A tenant's external mapping is both-or-neither, non-unique, and never widens isolation | `apps/api/test/tenant-external-mapping.test.ts` (runs the real migration) |
| An elicitation's options ride in `parameter`; `signalMetadata` does not exist | `packages/contract/test/activity.test.ts` |
| Only a human may answer, never the asking agent; answering twice conflicts | `apps/api/test/elicitations-rest.test.ts`, `board-elicitations.test.ts` |
| The whole ask→answer→collect loop works over the wire | `apps/api/test/sdk-elicitation.test.ts`, `apps/web/e2e/elicitation.spec.ts` |
| Dev auth is off unless `DEV_AUTH=true`, and is not set in `wrangler.jsonc` | `apps/api/test/dev-auth.test.ts` |
| MCP and REST agree on the verbs both expose | `apps/api/test/mcp-parity.test.ts` |
| **`/mcp` serves no authorization server, and no `agent-card.json` exists** | `apps/api/test/oauth-surface.test.ts` |
| **A `response`/`error` activity does not advance the card; only the verbs do** | `apps/api/test/activity-does-not-advance.test.ts` |

CI (`.github/workflows/ci.yml`) runs `pnpm typecheck` + `pnpm test`, and the Playwright e2e, on
every PR. Both must pass before merge.

## The one-paragraph design

Kaambaan's contract is anchored on the **A2A protocol** (Linux Foundation) — its `Task`
object and state machine model "dispatch long-running work to a remote agent, stream
artifacts, pause for human input." On top of that spine we layer **Linear's** accountability
and UX model (delegate-not-owner, an append-only typed activity log, signals for
human-in-the-loop) and **Hermes's** operational semantics (durable board, structured stage handoff,
heartbeats, stale-reclaim, circuit breaker). The same contract is exposed two ways — an **MCP
server** and a **REST + webhook API** — and live activity streams to the board over a WebSocket.
External resources (GitHub issues/PRs, repos, docs) are first-class **references**. Everything is
**hard multi-tenant**.

## Prior art credits

Design ideas adapted from [Linear's agent platform](https://linear.app/developers/aig),
[Nous Research's Hermes kanban](https://hermes-agent.nousresearch.com/docs/), the
[A2A protocol](https://a2a-protocol.org), [MCP](https://modelcontextprotocol.io), and
[AG-UI](https://docs.ag-ui.com). See the team memory `kaambaan-research-sources` for the
full reference list.

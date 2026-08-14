# 10 — Roadmap

Phased delivery. Each phase is a **working, tested vertical slice** — not a horizontal layer — so
there is always something runnable, and every phase lands with the tests from
[09 — Testing Strategy](./09-testing-strategy.md). The **demo milestone** (P4) is the north star for
v1: *point Claude Code at Kaambaan's MCP endpoint and drive a card through a 3-stage pipeline with a
human gate, live on a multi-tenant board.*

## P0 — Foundations
- Monorepo (`apps/api`, `apps/web`, `packages/contract`), `wrangler` config, CI.
- **D1 catalog** schema: tenants, users, memberships/roles, boards, agents, tokens, webhooks.
- **Auth**: human login (GitHub OAuth → session; magic-link was never built); per-agent bearer tokens; the edge
  `{principal, tenant}` resolver + **hard-isolation guard** (with the isolation tests first).
- **`packages/contract`**: zod schemas for the A2A-aligned types, verbs, and the normalized activity
  envelope — plus their first (failing) tests. *Contract before code.*

## P1 — Live boards (humans only)
- **Board DO**: stages/cards/tasks/runs/events in DO SQLite; the **state-machine reducer**
  ([03](./03-card-lifecycle.md)) with its full transition-table test suite.
- **WebSocket hub** (hibernatable) + event log ([07](./07-realtime-and-ui.md)).
- **Board UI** (shipped as SvelteKit/Svelte 5, not React): columns, cards, drag-and-drop, card drawer, live updates. Humans move cards
  manually — proves the real-time multi-tenant core end to end.

## P2 — Agent contract over REST
- Verbs: `claim` (atomic, WIP/concurrency, capability-tag routing), `heartbeat`, `activity`,
  `complete`, `block`, `release/fail`, `getCard`.
- **Lease + fencing epoch + heartbeat-timeout reclaim** via DO alarms; ack SLA; circuit breaker
  ([08](./08-reliability-and-durable-execution.md)) — with the lease/reclaim/idempotency suites.
- **Conformance kit v0** + a **reference worker** (a Cloudflare Agent) that drives the loop.

## P3 — Pipeline + gates
- Multi-stage handoff; **structured handoff metadata** delivered to the next stage on `claim`.
- **Approval gates**: `input-required` + `select`, the `accept/decline/cancel/edit` resolve flow,
  `promptFill` options, **separation-of-duties**, alarm-driven timeout/escalation/quorum.
- Comment-→-follow-up primitive; request-changes re-opens a stage as a new attempt.

## P4 — MCP server  🎯 **DEMO MILESTONE**
- `/mcp` Streamable HTTP, OAuth Resource Server *shell* (bearer only — no AS shipped), tools with honest annotations, `isError`
  semantics, elicitation-as-gate.
- **Contract-parity tests** (MCP ≡ REST).
- Ship the demo: Claude Code over MCP runs a `research → review(gate) → publish` pipeline live.

## P5 — External references + GitHub sync
- Reference model + idempotent upsert; **draft-PR sub-state machine**.
- GitHub webhooks (signature verify, delivery dedup) + **GraphQL reconciliation Workflow**; the
  three correctness-trap tests ([06](./06-external-references.md)).
- Reference-based stage gating (e.g. require a merged PR to exit).

## P6 — Realtime polish, observability & metering
- AG-UI adapters (native stream → board) for Claude Code / Codex / OpenCode.
- **Attempts** comparison UI (run the same card across agents/models).
- **Cost/usage metering** per tenant·board·card·attempt·agent·model; **budget caps**; pre-run cost
  estimates; rolling-window usage views.
- Notifications (in-app / email / **Slack** gate buttons).

## P7 — Push, triggers, profiles, multi-harness hardening
- Outbound webhooks (`work.available`, A2A PushNotificationConfig + signing) via Queues/Workflows.
- **Inbound trigger adapters** (GitHub issue, Slack, API, schedule) → one `createCard` path.
- **Agent profiles** as data (GUI + checked-in file); per-stage routing strategy (`pipeline` vs
  `manager`).
- **ACP** bridge; harden Codex/OpenCode/Cloudflare-Agents adapters; expand the conformance matrix.

## P8–P14 — shipped (v0.0.1)
Frontend "agent flight deck", card drawer, real auth + deploy, usability, pipeline builder,
budgets, richer cards, settings, templates, and the Linear-style **List view + filters** landed
across P8→P14 — tagged **[v0.0.1 "First Flight"](../CHANGELOG.md)**.

## P15+ — Linear parity
The post-v0.0.1 program — reaching feature parity with Linear (card depth, comments, command
palette, teams/states, projects, the contested planning machinery) — is planned in
[13 — Linear Parity Program](./13-linear-parity-program.md), which continues this phase numbering.

## Beyond v1 (candidate backlog)
Policy/auto gates · action-level autonomy levels (allow/deny/blocklist) · confidence routing ·
board/pipeline templates · MCP resources/prompts (board snapshots) · deeper doc-provider
integrations · per-tenant DBs if isolation needs harden · "materialize attempt locally" escape
hatch · billing.

## Open decisions tracked across the specs
The **⚠️ OPEN** markers (claim-TTL default, circuit-breaker N, DO sharding threshold, handoff-schema
rigidity, reference-gate expression language, ACP-in-v1, monorepo tooling, pricing model) are
deferred until their phase. None blocks P0.

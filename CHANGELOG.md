# Changelog

All notable changes to Kaambaan are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] — 2026-06-21

**"First Flight."** The first tagged milestone, spanning the work since the
project's first commit on 2026-06-20 — **P0 → P14, 21 merged PRs, 72 commits**.
Every phase was built docs-first and TDD-first (RED → GREEN) and code-reviewed
before merge.

Kaambaan is a multi-tenant Kanban board that orchestrates **external** AI agents
through pipeline stages with human approval gates. It is the orchestration
**control plane**, not an agent runtime — agents run anywhere, under any harness,
and connect over one shared contract (MCP **and** REST/webhook) to pull work,
stream progress, and pass cards through stages.

### Platform foundation (P0–P1)
- Cloudflare-native architecture: edge Worker (API / auth / routing / UI host),
  **one Durable Object per board** as the live authority (atomic claims,
  append-only event log, WIP limits, hibernatable WebSocket hub), D1 tenant
  catalog, R2 artifacts, KV sessions.
- **Hard multi-tenant isolation** — no unscoped query path; users are global and
  scoped via memberships; boards routed by `idFromName(tenant:board)`.
- **Contract-first** `@kaambaan/contract`: Zod schemas, the A2A-aligned task
  **state machine**, and a normalized **activity envelope**, shared across API,
  web, and SDK.

### Agent orchestration (P2)
- Atomic, capability-routed **claim** with a lease + fencing epoch; the full run
  loop — `heartbeat` / `postActivity` / `complete` / `block` / `fail` / `release`.
- Reliability: heartbeat-timeout **reclaim** via a single DO alarm, **circuit
  breaker** on repeated failures, and an ack SLA.
- **Structured stage handoff** (summary + metadata JSON) carried between stages.
- `@kaambaan/agent-sdk` — a dependency-free client (injectable `fetch`) with a
  `runOnce` reference driver and a conformance kit that drives a card end-to-end
  over the public REST contract only.

### Approval gates (P3)
- Human-review stages open a pending **gate**; cards sit `input-required` and are
  not claimable until resolved.
- Resolve as **approve** (advance, carrying handoff), **request-changes** (return
  to the prior stage, merging prior handoff + feedback), or **reject** (terminal).
- **Separation-of-duties**, including across chained gates.

### Integrations & references (P4–P5, P7)
- **MCP server** over Streamable HTTP (OAuth 2.1 resource server) mirroring the
  REST verbs — self-describing, with work discovery.
  > *Correction (2026-08-14): "OAuth 2.1 resource server" overstated what shipped. `/mcp` is a
  > Resource Server **shell** — a `401` + RFC 9728 metadata over a bearer token. No authorization
  > server, PKCE, or audience validation was ever built. See
  > [docs/05 §2](./docs/05-integration-surfaces.md). Left as written above because a changelog is a
  > dated record; this note corrects it rather than rewriting it.*
- **REST + webhook API** over the one shared contract.
- **First-class external references** (GitHub issue / PR / repo / docs) —
  idempotent upsert keyed `(card, url)`, with GitHub **webhook sync** and a
  draft-PR sub-state machine (draft → ready → merged).
- Inbound **issue-trigger** funnel; **outbound push** notifications
  (`work.available`) with SSRF guards and retry.

### Cost, budgets & telemetry (P6)
- Per-activity **token/cost metering** rolled up to card and board.
- **Budget caps** enforced on in-flight runs; **pre-run cost estimates** from
  rolling historical windows.
- Attempts/runs history; AG-UI event adapter; in-app notifications.

### Web app — "the agent flight deck" (P8–P14)
- SvelteKit 2 / Svelte 5 (runes) SPA on Cloudflare; **live board** over WebSocket.
- **Board (Kanban)** + **List view** with Linear-style filters, grouping, and
  sorting.
- **Card drawer**: session replay of the typed activity stream; edit
  title/priority/description; add references; delete.
- **Approval-gate UI** (approve / request-changes / reject); **budget controls**
  and cost estimates.
- **Board switcher**, **agent management** (mint / revoke tokens with MCP connect
  snippet), **custom pipeline builder**, **7 domain templates**, and **board
  settings** (rename, GitHub webhook secret, agent profiles).
- Sign-in (GitHub OAuth), onboarding, connect-an-agent; notifications panel;
  responsive to mobile; the "flight deck" visual identity (indigo-ink +
  marigold/teal/coral, Space Grotesk + IBM Plex).

### Auth & deploy (P10, CI)
- **GitHub OAuth** sessions + per-agent **bearer tokens** with scopes; a dev-auth
  header path for local development.
- Live on Cloudflare (`kaambaan-api.mail-88a.workers.dev`), single-worker
  same-origin; CI with separate `test` and `e2e` jobs and auto-deploy.

### Quality
- 110+ unit/integration tests (contract + API running in real `workerd` via
  `@cloudflare/vitest-pool-workers`) plus Playwright E2E specs.

### Known gaps
Tracked toward Linear parity (see the Linear-parity program in `docs/`): no
full-text search or command palette, no saved views, no sub-cards / card
relations, no human↔human comments / @mentions, no labels-management UI, and no
due dates. These are the next milestones, not regressions.

[0.0.1]: https://github.com/rakeshgangwar/kaambaan/releases/tag/v0.0.1

# 02 — Architecture

Kaambaan runs on **Cloudflare**.

> **⚠️ What is actually bound today.** `apps/api/wrangler.jsonc` binds exactly three things: **D1**
> (`DB`), the **Board Durable Object** namespace (`BOARD_DO`), and the static **ASSETS** for the SPA.
> **R2, KV, Queues and Workflows are not bound and not used** — the diagram and the component
> sections below describe the intended topology, and the paragraphs marked ⚠️ say what stands in for
> each today. Treat this document as design intent with the gaps called out, not as a deployment
> description.

The shape of the platform maps unusually well onto the
problem: Durable Objects give us a single-threaded, strongly-consistent live authority per
board (atomic claims for free), D1 gives us a queryable multi-tenant catalog, Workflows/Queues
give us durable webhook delivery and timeouts, and Workers give us a global edge for auth and
routing.

## Topology at a glance

```
                         ┌─────────────────────────────────────────────┐
   Humans (browser) ─────►                  Edge Worker                 │
   Agents (MCP/REST) ────►   authn + authz + tenant routing + UI host   │
   GitHub/webhooks  ─────►                                              │
                         └───────┬───────────────┬───────────────┬──────┘
                                 │               │               │
                    route to board DO     read/write catalog   enqueue
                                 │               │               │
                    ┌────────────▼─────┐   ┌─────▼─────┐   ┌─────▼─────────┐
                    │  Board Durable   │   │    D1     │   │ Queues /      │
                    │     Object       │   │ (catalog) │   │ Workflows     │
                    │ • live state     │   └───────────┘   │ • webhook     │
                    │ • atomic claims  │                   │   delivery    │
                    │ • WebSocket hub  │   ┌───────────┐   │ • schedules   │
                    │ • activity log   │   │    R2     │   │ • stale/timeout│
                    └──────────────────┘   │ artifacts │   └───────────────┘
                                           └───────────┘
                                           ┌───────────┐
                                           │    KV     │  sessions, hot config
                                           └───────────┘
```

## Components

### Edge Worker — the front door
A single Worker that:
- **Serves the SvelteKit SPA** (static assets from `apps/web/build`) and the API, same-origin.
- **Terminates auth**: resolves a request to `{principal, tenant}` *before* anything else.
  Humans → a signed session cookie (**stateless HMAC, not KV-backed** — there is no session
  store). Agents → a `kbn_` bearer token, the **same credential on REST and on `/mcp`**. `/mcp`
  is an OAuth Resource Server *shell* only — no authorization server, no PKCE, no audience
  validation ([05 §2](./05-integration-surfaces.md)).
- **Authorizes**: pins the tenant, which is always derived from the credential and never from a
  client-supplied value, and compares the authenticated agent against `run.agentId` on run verbs.
  **⚠️ Membership `role` and token `scopes` are stored but never checked** — that authorization
  layer is design intent, not a control that exists.
- **Routes** to the correct **Board Durable Object** (by `boardId → DO id`) and to the MCP
  endpoint. The DO trusts the Worker's authorization decision — it never re-authenticates.

### Board Durable Object — the live authority
**One DO instance per board.** Because a DO is single-threaded, it is the natural place to:
- Hold authoritative live state: stages, cards, current tasks, runs, the activity log.
- Enforce **atomic claims**: when an agent calls `claim`, the DO hands out exactly one ready
  card — no locks, no races, no double-claims. *(This is the property Hermes needed a DB
  transaction for; a DO gives it for free.)*
- Enforce **WIP limits** and **agent concurrency** at the moment of claim.
- Host the **hibernatable WebSocket hub** that broadcasts events to connected UI clients.
- Persist via **DO SQLite** (durable, transactional, co-located with the logic).

What lives in the DO vs D1:
| In the Board DO (hot, live, per-board) | In D1 (catalog, cross-board, relational) |
|---|---|
| Stages, cards, tasks, runs, activities, events | Tenants, users, memberships, roles |
| WebSocket connections | Boards index, pipelines/templates |
| Atomic-claim + WIP/concurrency state | Registered agents, tokens, scopes, capabilities |
| | Webhook subscriptions, GitHub installation links |
| | Cross-board queries ("all my boards", "all agents in tenant") |

> **⚠️ OPEN — DO granularity.** One DO per board is the default. If a single board can hold
> very large numbers of cards/agents, we may shard (e.g. an activity-log DO). Decide when we
> have load numbers; the contract doesn't depend on it.

### D1 — the tenant catalog
Relational, queryable, the system of record for everything that must be queried *across*
boards or that defines identity/authz. Hard tenant isolation is enforced here: every row
carries `tenantId`, and the data-access layer refuses any query without a resolved tenant
scope. **⚠️ OPEN**: whether to also adopt per-tenant DBs or row-level enforcement only —
default is row-level with a mandatory tenant guard in the data layer.

`tenants` additionally carries an optional `external_id` + `external_source` pair — where the
same real organisation is known outside kaambaan — under an all-or-nothing CHECK
(`tenants_external_pair`, migration 0002). It is a *record*, never an input to isolation: no
query, DO name, or authorization check reads it.

### R2 — artifacts — **⚠️ not bound**
*Intended*: large agent outputs (files, diffs, generated docs, build logs) referenced by A2A
`Artifact`s via `FileWithUri`. *Today*: there is no R2 binding and no artifact model. A card's
outputs are whatever JSON the agent puts in its `complete` handoff, stored in the DO.

### KV — sessions & hot config — **⚠️ not bound**
*Intended*: session tokens and hot caches. *Today*: there is no KV binding. The session is a
**stateless** base64url payload + HMAC signature in a cookie — nothing is stored server-side, which
is also why there is no way to revoke one before it expires.

### Queues / Workflows — durable async — **⚠️ not bound**
*Intended*: retrying webhook delivery, scheduled/recurring cards, multi-step timeout bookkeeping.
*Today*: neither is bound. What stands in for each:
- **Webhook delivery** is a table in the DO drained by an explicit `POST …/push/dispatch`, signed
  with HMAC, and **at-most-once** — a failed delivery is terminal ([05 §4](./05-integration-surfaces.md)).
- **Scheduled/recurring cards** do not exist.
- **Timeouts**: the DO alarm enforces the heartbeat/reclaim deadline and the circuit breaker. The
  ack SLA, stale window and per-stage max runtime are **not** enforced ([04 §5](./04-agent-contract.md)).

## Multi-tenancy & isolation

- **Boundary = Tenant.** A Board belongs to exactly one tenant. A Board DO id is derived from
  `(tenantId, boardId)` so a DO can never serve two tenants.
- **The boundary is local, not an authority.** kaambaan enforces isolation; it does not decide
  who anyone is. Principal, Team, Role and authority belong to the Organization plane, which
  does not exist yet — so kaambaan models none of them and instead records an *optional*
  mapping (`external_source` + `external_id`) to the same organisation elsewhere. kaambaan runs
  standalone with no mapping at all, and the mapping never widens a scope: isolation is always
  computed from `tenantId`.
- **Humans**: session → membership lookup → role check. No membership ⇒ no access, full stop.
- **Agents**: a per-tenant **app-actor** registration with bearer tokens scoped to that tenant
  (optionally to specific boards/capabilities). An agent token is meaningless outside its
  tenant. Agents are always badged distinctly in the UI.
- **The DO trusts the edge.** Authorization is computed once at the Worker; the DO assumes the
  caller is already authorized for *this* board's tenant. This keeps the hot path fast and the
  isolation logic in one place.

## Authentication summary

| Principal | Mechanism *(as shipped)* | Carrier |
|---|---|---|
| Human | **GitHub OAuth only** → stateless HMAC-signed session (30d). No Google, no magic-link, no password | Cookie `kaambaan_session` |
| Agent (REST **and** MCP) | Per-agent `kbn_` token, stored as a SHA-256 hash; carries tenant + agent identity + capabilities | `Authorization: Bearer` on `/v1/boards/*` and `/mcp` |
| Human or agent, **dev only** | `X-Tenant-Id` / `X-Agent-Id` / `?tenant=`, or an MCP `<tenant>:<agent>:<caps>` bearer — self-asserted, no secret. Requires `DEV_AUTH=true`; a deploy rejects them | Headers / query |
| Inbound webhook (GitHub) | HMAC-SHA256 signature verify, in the DO | `X-Hub-Signature-256` |
| Outbound webhook (to agents) | HMAC-SHA256 over the exact body | `X-Kaambaan-Signature: sha256=…` |

**Not implemented**: any authorization server, `/authorize`, `/token`, dynamic client
registration, PKCE, JWTs, audience (`aud`) claims, token expiry or rotation, role/scope checks,
rate limiting, and CSRF tokens (`SameSite=Lax` is the only CSRF defense).

## Key data flows (textual sequence)

**Card claim (pull):**
1. Agent → Edge Worker: `claim(boardId, capabilities)` with bearer token.
2. Worker authz → routes to Board DO.
3. DO atomically selects the top *ready* card in a stage the agent owns, within WIP +
   concurrency limits; creates a Task (`working`) + Run; sets `delegateAgentId`.
4. DO returns the card spec + structured context bundle; broadcasts an Event over WebSocket.

**Progress streaming:**
1. Agent emits `activity` (thought/action/...) → Worker → DO appends to Run (immutable).
2. DO derives Task state from the latest activity; broadcasts to UI (ephemeral ones replace).

**Approval gate:**
1. Agent calls `submit_for_review` → DO sets Task `input-required` with a `select` signal;
   card sits in the gate column; UI renders Approve / Request changes / Reject.
2. Human resolves → DO advances the card (new Task, next stage) or rejects (terminal).

**Webhook dispatch (push):**
1. DO emits an Event → enqueues to Queue → Workflow delivers to subscribed agent endpoints
   with retries + signature; agent may then `claim`.

## Repository shape (proposed)

```
kaambaan/
├── docs/                      # this spec set (source of truth)
├── packages/
│   └── contract/              # zod schemas + types for the shared contract (A2A-aligned)
│   └── agent-sdk/             # client for the agent REST surface (private, unpublished)
├── apps/
│   ├── api/                   # Cloudflare Worker: edge, REST, MCP server, Board DO
│   └── web/                   # SvelteKit (Svelte 5) board UI, built to static assets
└── pnpm-workspace.yaml / package.json
```
Resolved: **pnpm workspaces** (`packageManager: pnpm@11.5.2`, Node ≥ 22). There is no top-level
`test/` directory — contract/conformance tests live in `apps/api/test` and `packages/contract/test`.

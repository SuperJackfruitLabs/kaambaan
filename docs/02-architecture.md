# 02 — Architecture

Kaambaan runs on **Cloudflare**. The shape of the platform maps unusually well onto the
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
- **Serves the React app** (static assets) and the API.
- **Terminates auth**: resolves a request to `{principal, tenant}` *before* anything else.
  Humans → session cookie (KV-backed). Agents → bearer token (MCP `Authorization` header or
  REST). MCP auth follows OAuth 2.1 with Kaambaan as the **Resource Server** (see
  Integration Surfaces, planned).
- **Authorizes**: checks the principal's membership/role or the agent's tenant + scopes.
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

### R2 — artifacts
Large agent outputs (files, diffs, generated docs, build logs) referenced by A2A `Artifact`s
via `FileWithUri`. Tasks/cards store the R2 keys; blobs never bloat the DO.

### KV — sessions & hot config
Human session tokens, short-lived caches (e.g. resolved tenant routing), feature flags.

### Queues / Workflows — durable async
- **Webhook delivery** with retries + backoff and HMAC signing (push side of the contract).
- **Scheduled/recurring cards** (cron-style task creation).
- **Timeouts**: ack/stale/heartbeat deadlines, circuit-breaker bookkeeping (see
  [Card Lifecycle](./03-card-lifecycle.md)). The DO sets alarms; Workflows handle multi-step
  retrying delivery.

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

| Principal | Mechanism | Carrier |
|---|---|---|
| Human | OAuth (GitHub/Google) or email magic-link → session | Cookie (KV-backed) |
| Agent (MCP) | OAuth 2.1; Kaambaan = Resource Server; audience-validated bearer | `Authorization: Bearer` on `/mcp` |
| Agent (REST) | Per-agent bearer token, tenant+capability scoped | `Authorization: Bearer` on `/v1/*` |
| Inbound webhook (GitHub) | HMAC-SHA256 signature verify | `X-Hub-Signature-256` |
| Outbound webhook (to agents) | Signed delivery (A2A PushNotificationConfig pattern: JWT/HMAC) | `Authorization` / signature header |

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
├── apps/
│   ├── api/                   # Cloudflare Worker: edge, REST, MCP server, Board DO
│   └── web/                   # React + Vite board UI
├── test/                      # cross-cutting contract/conformance tests
└── wrangler.* / package.json
```
**⚠️ OPEN — monorepo tooling** (pnpm workspaces vs bun vs turborepo) — decide at scaffold time.

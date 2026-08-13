# 01 — Domain Model & Glossary

This document defines the **nouns** of Kaambaan and how they relate. Terminology here is
binding: code, APIs, and tests should use exactly these names.

## The three-level work hierarchy (read this first)

The single most important distinction in Kaambaan is **Card vs Task vs Run**. Conflating them
is the most likely source of design bugs.

- **Card** — the *durable unit of work* on the board (e.g. "Add OAuth login"). It persists for
  its whole life, moves across stages, has a human owner, and accumulates references and a
  full history. A card is long-lived and mutable (it advances stages).
- **Task** — *one unit of agent work on a card at a particular stage*, modeled on the **A2A
  `Task`**. A task is **immutable once terminal**: when a card advances to the next stage, or
  is reworked, a **new Task** is created under the same `contextId`. The card therefore owns a
  *sequence* of tasks over its lifetime (one or more per stage).
- **Run** *(a.k.a. Session)* — *one execution attempt of a Task by one agent*, modeled on
  Linear's **Agent Session** and Hermes's **task_run**. A task may be attempted multiple times
  (crash, reclaim, retry). A run owns the live activity stream and the heartbeat.

```
Card ──< Task (one per stage / rework, A2A-immutable) ──< Run (one per attempt) ──< Activity
  │                                                                                     
  └──< Reference (external link)        contextId groups all Tasks of one Card
```

> **Rule of thumb:** durable board state lives on the **Card**; the canonical state machine
> lives on the **Task**; ephemeral live progress lives on the **Run**.

## Entities

### Tenant *(a.k.a. Workspace)*
kaambaan's **local hard isolation boundary** — and only that. All data, auth, and agent
registrations are scoped to exactly one tenant. Fields: `id`, `slug`, `name`, `createdAt`,
`externalId`, `externalSource`, settings, billing. There is no cross-tenant read path;
isolation is enforced at the edge, not by a query filter.

**It is deliberately not an Org.** Principal, Team, Role and authority belong to the
Organization plane, which does not exist yet; a product that grows its own org model has to
migrate it later. So kaambaan owns the boundary and nothing about who anyone *is*.

**The external mapping.** `externalSource` names the system a tenant is also known to
(`agentpod` today, `org-plane` later) and `externalId` is that system's id, kept opaque
because it is not kaambaan's id space. **Both or neither**, enforced by a database CHECK
(`tenants_external_pair`) — an id recorded without the system it came from cannot be joined
against anything, and a wrong join is harder to notice than a missing one. AgentPod carries
the same pair with the same CHECK on its own rows.

Absent is the normal, complete state: a **standalone kaambaan** — a plain kanban board for
someone's agents, with no organisation layer anywhere — never sets either column. When the
Organization plane mints canonical ids, both products map to them: a data move, not a schema
change. The mapping is deliberately **not unique** — kaambaan is one-tenant-per-user, so two
people in one real organisation legitimately map two local boundaries onto one external id.
A shared mapping never becomes a shared keyspace; isolation stays local, on `tenantId`.

### User & Membership
A human principal and their role within a tenant. `Membership(userId, tenantId, role)` where
`role ∈ {owner, admin, member, viewer}`. Humans authenticate via OAuth / magic-link → session.

### Agent *(registered worker)*
An external worker registered to a tenant. It is an **app-actor identity** (per Linear's
`actor=app`), *not* a human user, and is always badged as an agent in the UI. Fields:
- `id`, `tenantId`, `name`, `iconUrl`
- `capabilities` — tags it can service (e.g. `research`, `code`, `review`); drives routing
- `agentCard` — its A2A AgentCard (skills, input/output modes, streaming/push support)
- `tokens` — per-agent bearer credentials, with `scopes` (capability flags)
- `concurrency` — max simultaneous claimed cards
- `status` — `online | busy | offline` (derived from recent heartbeats/claims)
- `connection` — how it integrates: `mcp | rest | webhook` (may support several)

### Board
A named workspace surface within a tenant containing one pipeline and its cards. Fields:
`id`, `tenantId`, `name`, `pipelineId`, `createdAt`. **One Board = one Durable Object** (see
[Architecture](./02-architecture.md)).

### Pipeline & Stage *(column)*
A **Pipeline** is the ordered list of **Stages** a card flows through. Each **Stage** (rendered
as a board column) declares:
- `key`, `name`, `order`
- `owner` — which agents work this stage: a **capability tag** (e.g. `code`) or a specific
  `agentId`, or `human` (no agent; human-only column)
- `gate` — `none | approval` (an `approval` stage requires a human ✅ before the card advances)
- `wipLimit` — max cards concurrently in this stage (the real Kanban constraint)
- `entry`/`exit` hints — optional structured-handoff requirements (e.g. "a PR reference must
  be attached before exit"). **⚠️ OPEN**: how rich stage entry/exit conditions should be in v1.

### Card
The durable unit of work. Fields:
- `id`, `boardId`, `tenantId`, `title`, `spec` (opaque JSON input — domain-agnostic)
- `ownerUserId` — the accountable **human owner** (never an agent)
- `currentStageKey`, `priority`, `labels`
- `delegateAgentId` — the agent currently executing (the *delegate*; nullable)
- `references[]` — external links (see below)
- `currentTaskId` — the active A2A Task, if any
- timestamps, `archivedAt`

### Task *(A2A-aligned)*
One unit of agent work on a card at a stage. Fields mirror A2A:
- `id`, `cardId`, `contextId` (shared across all tasks of the card), `stageKey`
- `state` — the A2A `TaskState` (see [Card Lifecycle](./03-card-lifecycle.md))
- `artifacts[]` — outputs produced (A2A `Artifact`; may reference R2 blobs)
- `history[]` — A2A `Message`s (the durable conversational record)
- `metadata` — structured handoff payload for the next stage (Hermes-style)
- timestamps, terminal-ness

### Run *(Session / attempt)*
One attempt to execute a Task. Fields (Linear Session × Hermes task_run):
- `id`, `taskId`, `agentId`, `startedAt`, `endedAt`
- `outcome` — `completed | blocked | rejected | crashed | timed_out | reclaimed | canceled`
- `lastHeartbeatAt`, `workerRef` (opaque agent-side identifier)
- `activities[]` — the typed activity stream

### Activity
A typed, append-only progress event emitted by an agent (or human) onto a Run. Types (Linear
verbatim): `thought | action | response | elicitation | error` (plus `prompt` = human input).
`thought`/`action` may be **ephemeral** (rendered transiently, replaced by the next activity).
The Task/Run state is **derived** from the latest meaningful activity. Fields: `id`, `runId`,
`type`, `body`/`action`/`parameter`/`result`, `ephemeral`, `signal?`, `signalMetadata?`,
`authorKind` (`agent | human`), `createdAt`. Activities are **immutable snapshots** — the
source of truth agents read back from (never read mutable card fields mid-run).

### Signal
Optional typed metadata attached to an activity that tells the recipient how to interpret/
render it. Initial set (Linear): `stop` (human→agent: halt now), `auth` (agent→human: link an
account/credential), `select` (agent→human: choose from options — **this is how an approval
gate renders Approve / Request changes / Reject**). Signals are an **open enum**; Kaambaan adds
`approve`/`reject` semantics on top of `select` as needed. Fields: `signal`, `signalMetadata`.

### Gate / Approval
A pause where a human decision is required before a card advances. Realized as a Task in state
`input-required` carrying a `select` signal. A human resolves it (approve → advance; request
changes → back to the agent with feedback; reject → terminal `rejected`). See
[Card Lifecycle](./03-card-lifecycle.md).

### Reference *(external link / attachment)*
A first-class link from a card to an external resource. Modeled on Linear's idempotent
attachments. Fields: `id`, `cardId`, `url` (**dedup key** within a card), `title`, `subtitle`,
`provider` (`github | gitlab | docs | url | …`), `sourceType`
(`issue | pull_request | repo | branch | commit | doc | url`), `externalId` (e.g. GitHub
`node_id` or `owner/repo#n`), `metadata` (JSON: state, merged, draft, refs…), `syncState`
(`synced | stale | error`), `lastSyncedAt`. Upsert is idempotent on `(cardId, url)`. Detailed
in `06-external-references` (planned).

### Event
The append-only audit + realtime feed for a board. Every meaningful change (card created,
stage advanced, agent claimed, activity emitted, gate resolved, reference added) is an Event.
Events drive the WebSocket broadcast to UI clients and the webhook dispatch to subscribers.

## Glossary (quick reference)

| Term | One-line meaning |
|------|------------------|
| **Tenant / Workspace** | kaambaan's *local* hard isolation boundary; everything is scoped to one. Not an authority — the Organization plane owns Principal/Team/Role |
| **External mapping** | Optional `externalSource` + `externalId` on a tenant: the same real organisation, as known to another system. Both or neither |
| **Board** | A pipeline + its cards; one Durable Object |
| **Pipeline / Stage** | The ordered columns a card flows through |
| **Card** | The durable unit of work; has a human owner |
| **Task** | A2A-style unit of agent work on a card at a stage; immutable when terminal |
| **Run / Session** | One attempt to execute a Task by one agent |
| **contextId** | Groups all Tasks belonging to one Card (A2A) |
| **delegate** | The agent currently executing a card (never the owner) |
| **owner** | The accountable human for a card |
| **Activity** | Typed append-only progress event (thought/action/response/elicitation/error) |
| **Signal** | Typed overlay on an activity (stop/auth/select/approve/reject) |
| **Gate** | Human-approval pause; a Task in `input-required` |
| **Reference** | First-class external link (GitHub issue/PR, repo, doc) |
| **AgentCard** | A2A capability/discovery document for an agent |
| **Capability tag** | A skill string used to route cards to agents |
| **Structured handoff** | The `metadata` an agent passes to the next stage |
| **Event** | Append-only audit record + realtime/webhook feed item |

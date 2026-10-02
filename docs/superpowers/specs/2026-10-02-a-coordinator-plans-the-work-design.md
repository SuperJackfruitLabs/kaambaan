# A coordinator plans the work

**Status:** accepted 2026-10-02 · operator decision on the gate boundary recorded below
**Follows:** `2026-10-02-an-agent-queues-work-design.md`

## The problem

A coordinator agent's whole reach today is three read routes: list boards, read a board, read one
card, plus gate reads. Measured live against production:

    supi boards          -> 10 boards
    supi project list    -> 401
    supi label list      -> 401
    supi capabilities    -> 401
    supi agents          -> 401

So the agent whose job is "who is free, what is stuck, what needs deciding" cannot see the project
list, the label catalogue, the capability registry, or the agent roster. It can see every card on
every board — the snapshot carries them — but not the card list route beside it.

**None of this is a decision about coordinators.** `resolveAgent` and `resolveHubAgent` are called
in exactly ONE place in the Worker, inside the `/v1/boards` router. Every other route resolves a
human. An agent credential does not reach `/v1/projects` and get refused; it never arrives. The only
credential question that route ever asked was about a hub JWT carried by a *person*:

> "`supi project ...` sends a hub JWT, never a session cookie, so `resolveUser` alone cannot
> authenticate it."

That is absence, not judgement — the same shape as the two defects this estate found in one day: a
surface nobody extended, which then reads as policy.

The cost is not symmetry. A coordinator that can queue a card but cannot set its project produces
work that falls out of every rollup: `cardsTotal` and `costUsd` silently under-count, which is
exactly the failure `overBudget` exists to prevent.

## What opens

### 1. `read` covers the read surface

Today `read` reaches the board list, one board, one card. It extends to everything a coordinator
must read to answer a question about the workspace:

| route | why |
|---|---|
| `GET /v1/projects`, `/v1/projects/:id`, `/v1/projects/:id/milestones`, `/v1/projects/:id/rollup` | "what body of work is this part of" |
| `GET /v1/labels` | a card's labels are ids until this resolves them |
| `GET /v1/capabilities`, `/v1/capabilities/implications` | half of the routing diagnosis |
| `GET /v1/agents` | the other half: who declares what |
| `GET /v1/boards/:id/cards/:id/{activities,attempts,estimate}` | what actually happened on a card |

`GET /v1/agents` returns `tokenIds` and the queueing policy, never a token. Reading which
credentials exist is not holding one.

### 2. New scope: `plan`

Managing the planning layer, which is the thing the operator asked for by name:

- `POST|PATCH /v1/projects`, `POST|PATCH /v1/projects/:id/milestones`, `PATCH /v1/milestones/:id`
- `PATCH /v1/boards/:id/cards/:cardId` — title, spec, priority, dueAt, labels, projectId, milestoneId
- `POST /v1/boards/:id/cards/:cardId/move`
- `POST|DELETE /v1/boards/:id/links` — a coordinator's main tool for saying "this waits on that"

Separate from `queue` because they are different trusts: `queue` spends other agents' time, `plan`
rearranges work that already exists. An agent may hold either without the other, and most should
hold neither.

### 3. Moving a card is DISPATCHING it

`moveCard` stamps `queued_by` and `queued_grant`: "whoever moves a card into a dispatchable stage is
the one dispatching it now". So an agent moving a card must stamp its OWN grant, through the same
`authorizeAgentQueue` path a create goes through — board allowlist, owner, grant, hourly ceiling.
Anything less lets an agent launder authority: move a card it could not have queued, and the card
carries the last human's grant.

`queued_by_agent_id` is set, and cleared on a human move, exactly as it already is.

### 4. Four routes would 500 rather than refuse

`cards` POST, `move`, `notifications` and schedule creation assert `user!.userId`. They are
unreachable by an agent today; each becomes a live crash the moment the door widens. Fixed as part
of this, not after it.

`notifications` are per-recipient and keyed on a user id. An agent has none, so the route stays
human-only rather than inventing one.

## What stays human, and why

Each of these has an argument, not an omission:

- **Resolving a gate.** The human half of the control pair. If an agent approves gates, every "a
  human decided this" record in the estate becomes unverifiable — including the record of the
  agent's own work. This is the boundary the whole audit trail hangs from.
- **Minting a token, linking an agent to a principal.** charter
  `decisions/2026-08-13-ecosystem-identity.md` Decision 3. `resolveHubAgent` finds an agent BY its
  `external_id`, so a credential that can write that field grants itself identities.
- **Deleting** a card, project, board or label. Unrecoverable, and shaping work does not require
  erasing records.
- **Editing stages.** Changes routing for every card on the board and can strand work — a gateless
  human terminal stage did exactly that to seven cards, found the same day.
- **Members and tenant.** Who may act in this workspace, and which fleet it answers to.

## Raising a decision: a card, not a gate

**Operator decision, 2026-10-02:** gates stay human-only, and the coordinator gets a way to *ask*
for a decision — "he sets the agenda, the operator holds the pen."

Implemented as a **card on a human-owned stage**, not as an ad-hoc gate. Two reasons, and the first
is a hazard:

- **Resolving a gate calls `advanceCard`.** An ad-hoc gate opened on a card sitting in a capability
  stage would, on approval, advance the card past the work that stage exists to do. A gate is a
  stage-transition review; it is not a general question.
- **Elicitations cannot carry it either.** `elicitations.run_id` is NOT NULL and a pending one is
  retired when its run ends — the primitive is strictly mid-run, and a coordinator has no run.

A decision card needs no new primitive, and inherits what already works: it appears on a board, it
carries `queuedByAgentId` so the record says the coordinator asked, it has an activity timeline, and
it completes when the operator moves it to a terminal stage. To halt something pending the decision,
the coordinator adds a `blocks` link — the enforced kind, which the claim query already honours.

So: no new verb. `queue` + `plan` already express it, and that is the argument for them.

## The credential gap this does not close

An `spa_` token carries no claims, so it carries no dispatch grant. `read` and `plan` work with one
today. `queue`, and now `move`, do not — they refuse `DISPATCH_GRANT_UNKNOWN` until a station token
can name superpipeline's audience (`station-token.ts` mints with no `audiences`; the
`HUB_OAUTH_CLIENTS` fix does not reach that route). Stated here so the split is deliberate: this
spec delivers the read and planning half immediately and leaves the dispatch half blocked on a
decision in another repo.

## Testing

The tests that matter are refusals, as before:

- a `['claim','run']` worker token is refused `read` and `plan` — the grandfather regression, again
- a `['read']` token reads projects and is refused creating one
- a `['plan']` token may not create a card (`queue`) and may not resolve a gate, ever
- an agent moving a card stamps ITS own grant, never the previous human's
- an agent moving a card onto a board it may not queue to is refused
- `PATCH /v1/agents/:id` and token routes still refuse every agent credential
- the four `user!` sites answer a refusal, not a 500

## What this does not do

- No agent gains gate resolution, deletion, stage editing, membership or tenancy.
- No change to the MCP tool surface; `split_card` remains the only work-creating tool there.
- `POST /v1/projects` is open to `plan`, but a project is a commitment about what the lab is doing —
  worth revisiting whether that should be the operator's alone.

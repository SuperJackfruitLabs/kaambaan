# An agent queues work

**Status:** scoped; authority decisions settled by the operator 2026-10-02; not yet implemented
**Date:** 2026-10-02

## The problem

Super Chotu is the coordination layer between the operator and a thirty-agent guild across ten
boards. He is supposed to turn intent into shaped work, route it to the right specialist, track
dependencies, and verify that work ran before calling it done.

He cannot see a single board.

There is no credential that lets him. The two that exist both fail, for opposite reasons:

| credential | what happens |
|---|---|
| hub/fleet token | `resolveHubUser` refuses anything where `claims.principalKind !== 'human'`. A token that passes **is** a human — "nothing downstream can tell which credential arrived". Chotu holding one acts as the operator: cards carry the operator's `userId` and the operator's whole `mayDispatch` as their grant. (It is also rejected today: superpipeline answers 401 on audience.) |
| `spa_` agent token | Reaches only `claims`, `runs/*` and gate reads. `isAgentRoute` is the gate, and board reads and card creation are not in it. |

So the choice today is: Chotu acts as the operator, or Chotu is blind. Neither is acceptable for
an agent whose entire value is telling the truth about what the guild is doing — a coordinator
whose every action is recorded as the operator's cannot be audited, and his verification claims
become worthless the moment they are indistinguishable from the operator's own.

## What already exists

The authorization model is most of the way there, which is why this is a small change rather than
a new subsystem.

- **Agents are principals.** `charter → decisions/2026-08-30-an-agent-is-a-principal.md`.
  `resolveAgent` returns an `AgentPrincipal` with `tenantId`, `agentId`, `scopes` and
  `concurrency`.
- **Scopes are real and enforced.** `AgentScope = 'claim' | 'run'`, compared in `scopePermits`,
  with a documented grandfather clause (`claim` implies `run`) that is deliberately NOT extended
  to verbs that create work (`CREATES_WORK`, `mcp/tools.ts`).
- **The board router already has an agent branch** (`index.ts` ~1390) that resolves the agent,
  checks `requiredScope(rest)` and sets `tenantId` from the agent.
- **The control pair already decides who may be dispatched.** `queuedGrant` is recorded on the
  card and outlives the token that carried it; `mayDispatch` is per-principal and agents are
  principals, so an agent can already *have* one.

What is missing is narrow: which routes an agent may reach, which scopes name them, and what
authority an agent-queued card carries.

## Design

### 1. Two new scopes, separately grantable

```
AgentScope = 'claim' | 'run' | 'read' | 'queue'
```

- **`read`** — list boards, read a board, read a card. The whole point of Chotu.
- **`queue`** — create a card.

They are separate because the first is almost harmless and the second is not, and because an
agent that should only observe — a verifier, an auditor — should be grantable exactly that. They
are *shipped* together (see "The CLI is an agent surface"), but they are two grants, and most
agents in the guild should never hold `queue`.

**No grandfathering, in either direction.** `scopePermits`' existing clause maps `claim → run` and
its argument is entirely about *finishing* work already claimed. Reading the whole workspace and
creating work are not finishing anything. Every existing `['claim','run']` token must gain
nothing, and the test for that is a regression test, not a comment.

### 2. Which routes open

`isAgentRoute` grows, and `requiredScope` names the scope for each:

| route | method | scope |
|---|---|---|
| `/v1/boards` | GET | `read` |
| `/v1/boards/:id` | GET | `read` |
| `/v1/boards/:id/cards/:cardId` | GET | `read` |
| `/v1/boards/:id/cards` | POST | `queue` |

Everything else stays human-only — stages, gates decisions, projects, labels, capabilities,
agents, tokens, deletion. A coordinator needs to see the board and add to it. It does not need to
restructure it, and the blast radius of this change should be legible in one table.

### 3. What an agent-queued card carries

This is the part that is currently wrong rather than merely absent. `createCard` does:

```ts
ownerUserId: body.ownerUserId ?? user?.userId ?? 'usr_dev',
queuedGrant: user?.mayDispatch ?? null,
```

For an agent caller `user` is undefined, so a card would be owned by the literal string `usr_dev`
and carry a **null grant** — which under `ENFORCE_CONTROL_PAIR` is refused at claim time. An agent
could create cards today that nothing can ever claim. Three changes:

- **`queuedGrant` comes from the AGENT's own `mayDispatch`.** This is the whole safety model and
  it needs no new machinery: an agent may queue work only for principals it is itself permitted to
  dispatch. Chotu with an empty grant can queue nothing that runs. Chotu granted dispatch over the
  Planning & Roadmap cast can queue work for exactly them. The operator sets the blast radius with
  a tool that already exists (`fleet grants set`).
- **`ownerUserId` must never fall back to `usr_dev` for an agent.** An agent-queued card is owned
  by the human who owns the agent — resolved from the agent row — or the route refuses.
- **`queuedByAgentId` is recorded on the card.** A card queued by an agent must be
  distinguishable from one queued by a person, forever, in the row rather than in a log. Without
  it the audit trail says the operator asked for work they never asked for.

### 4. What refuses

- **Which boards: `mayQueueTo` on the agent, defaulting to its rostered boards when unset.**
  Roster-derived alone was the first proposal and it fails on the exact agent this spec exists for:
  a coordinator holds no roster row — no stage asks for `command` — so roster-derived would give
  Chotu zero boards and he could queue nowhere. A worker that gains `queue` should still be bounded
  by where it works, so that stays the default; a coordinator is named explicitly. Unset and
  unrostered means no board, never every board.
- An agent may not set `ownerUserId` to another user.
- An agent with `queue` but an empty `mayDispatch` gets a clear refusal at creation
  (`NO_DISPATCH_AUTHORITY`) rather than a card that silently never runs. A card nobody can claim
  is the failure mode this estate has hit repeatedly: it looks queued and is dead.
- Rate: a per-agent ceiling on cards queued per hour. `CREATES_WORK` exists because an agent that
  can spend the guild's time unasked is the hazard; a scope alone does not bound volume.

### 5. Migration

- `AgentScope` is a union in `@superpipeline/contract`; adding members is additive.
- Existing tokens keep `['claim','run']` and gain nothing.
- Minting already accepts a `scopes` array (`POST /v1/agents/:id/tokens`), so a read-only token is
  `{"scopes":["read"]}` with no API change.
- No migration on `cards` beyond the additive `queued_by_agent_id` column.

## Testing

The tests that matter are refusals, because every bug in this area grants more than intended:

- a `['claim','run']` token is refused `read` and `queue` — the grandfather regression
- a `['read']` token reads boards and is refused card creation
- a `['queue']` token creating a card produces `queuedGrant` = the agent's `mayDispatch`, never
  null, never the operator's
- an agent with an empty grant is refused at creation with a named error
- an agent queueing onto a board it is not rostered on is refused
- `ownerUserId` never becomes `usr_dev` on an agent path
- a card queued by an agent is distinguishable from one queued by a person after the fact

And for the UI, because a provenance field nothing renders is the defect this estate has hit eight
times — a value written on one side of a boundary whose consumer was never built:

- a card with `queuedByAgentId` renders the agent's NAME on the tile and in the drawer (U2, U3, U4)
- a card queued by a human and one queued by an agent are visually distinct in a board snapshot
- reassigning the owner leaves `queuedBy` unchanged (U5)
- `displayPrincipal` resolves an agent principal, not just a user id (U2)

## What this does not do

- It does not let an agent decide a gate, edit stages, or delete anything.
- It does not let an agent mint tokens or change capabilities.
- It does not change `CREATES_WORK` for the MCP tool surface. `superpipeline_split_card` remains
  the only work-creating MCP tool; this spec is about the REST surface a coordinator uses, not
  about widening what a *working* agent can do mid-run.

## The CLI is an agent surface, not a human one

Operator decision, 2026-10-02: **the human will not drive `supi` routinely.** Work is asked for and
answered through agents, and Super Chotu is the co-CEO those requests land on. That reverses an
assumption buried in the current design — that an agent credential is a narrow thing for a worker
mid-run, and the rich surface belongs to a person at a terminal.

Two consequences:

- **`read` alone is not a useful first release.** A coordinator who can only describe the board,
  while every actual change waits on the operator opening a terminal, is a commentator. The thing
  that makes him a co-CEO is being able to put the shaped card on the board and then be answerable
  for it. `read` and `queue` ship together.
- **`supi` must authenticate with an `spa_` token for the routes in this spec.** Today its
  credential is a human session or a fleet token, so an agent cannot use the CLI at all. Agents are
  the expected callers; the CLI needs to accept the agent credential and refuse, clearly, on the
  routes that remain human-only.

## What the UI must show

A card now has **three** identities and the UI renders two of them. From the live API:

    ownerUserId       who is answerable for the card
    queuedBy          who authorised its dispatch      <- NOT RENDERED
    delegateAgentId   which agent is working it now

`CardDrawer.svelte` shows `owner ·` and `· delegate` with an agent avatar. `queuedBy` is carried on
every card, is deliberately preserved when ownership is reassigned — the code says so: "who is
answerable for a card and who authorised its dispatch" are different questions — and then appears
nowhere a person can see it.

That gap is survivable while every card is queued by the same human. It stops being survivable the
moment an agent can queue work: "Super Chotu asked for this" and "the operator asked for this" must
be distinguishable at a glance, or the audit trail silently credits the operator with work they
never requested.

### Acceptance criteria

These are requirements, not suggestions, and each one is checkable on a real card:

**U1 — all three identities are visible on a card, at once.** Owner, queued-by, and delegate.
Today two are rendered and `queuedBy` is not. A reader must be able to answer "who asked for this,
who is answerable for it, and who is doing it" without opening a terminal.

**U2 — a principal is shown as a name, never an id.** `queuedBy` resolves through the same path
`owner` already uses (`displayPrincipal`), extended to agent principals so an agent-queued card
reads `queued by Super Chotu` with his avatar, not `prn_d8178f4a…`.

**U3 — agent-queued and human-queued are distinguishable at a glance**, on the card tile as well
as in the drawer. Not by hovering, not by reading an id. This is the whole audit requirement: if
the operator cannot see which cards they did not ask for, the provenance field is decoration.

**U4 — the card tile shows it too.** A board full of cards is where someone notices that an agent
has queued twenty things. The drawer is where they go afterwards.

**U5 — reassigning the owner still does not touch `queuedBy`.** Existing behaviour; a regression
test, because the whole distinction collapses if ownership edits overwrite authorship.

**U6 — the activity timeline opens with provenance.** The timeline already exists and is good; it
should begin with who queued the card and who holds it, so the first thing read is the frame for
everything after it.

**U7 — `queuedGrant` is inspectable, not just stored.** A card carrying a 55-principal grant and a
card carrying a 3-principal grant are very different objects, and today both render identically.
At minimum: how many principals, and whether the queuer could dispatch the agent that ended up
working it.

**The per-card activity timeline already exists** and does not need building:
`CardDrawer.svelte` renders `groupActivities(cardDetail.activities, drawerAttempts)`, with
narrative grouping because "showing everything by default buries the 1.4% that tells the story" —
a real run posted 67 activities. What it should gain is the provenance above at the head of the
timeline, so the first thing read is who asked for this and who is doing it.

(`operate/Activity.svelte` is a different thing — the board-level notification feed, "what
happened" rather than "what should I do". It is not a card timeline and should not be conflated
with one.)

## Open questions for the operator

1. ~~Does Chotu get `queue`, or `read` first?~~ **Settled: both.** The operator does not drive the
   CLI, so a read-only coordinator leaves every change blocked on a human at a terminal — which is
   the problem this spec exists to remove.
2. ~~What is Chotu's `mayDispatch`?~~ **Settled: the thirty guild agents, and only those.**
   He commands the guild. He must NOT hold dispatch over the operator's personal ashram team
   (annapurna, buddhimaan, ganesha, hanuman, indra, krishna, kubera, saraswati, surya,
   vishwakarma), the canaries, or the unnamed machine-handle principals. A co-CEO of the lab is
   not a co-CEO of the operator's private life, and the grant is where that line is drawn rather
   than in an instruction he could reinterpret.
3. ~~Board allowlist or roster-derived?~~ **Settled: `mayQueueTo`, defaulting to rostered boards.**
   Chotu is named explicitly for all ten. See "What refuses".

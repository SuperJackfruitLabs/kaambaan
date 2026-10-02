# A question leaves the board

**Status:** proposed, 2026-10-02
**Companion spec:** `agentpod → docs/superpowers/specs/2026-10-02-a-question-reaches-the-room-design.md`

This is the superpipeline half of a two-repo change. superpipeline is the source of
truth for boards, gates and elicitations; it emits facts. agentpod's hub turns those
facts into a room a person can answer from their phone. Neither half is useful alone,
and each repo's spec covers only what it owns.

## The two problems

**1. A board room is called "superpipeline".** Every board's Matrix room carries the
literal name `superpipeline` because the hub has no way to learn what the board is
called. Four live board rooms share that one name today, so the room list is
unreadable and gets worse with every board.

The hub cannot ask. `/v1/members` resolves a user *session*, which is why the hub's
`humansFor` is injected rather than fetched — the same wall applies to a board's name.
The board, however, already knows: `this.getMeta('name')`.

**2. An approval is answerable from a phone; an agent's question is not.** A gate
reaches a room and comes back as a tap, because `gate.pending` is pushed. An
elicitation — an agent blocked mid-run asking the operator something, which is what
every permission prompt is — is only visible in the web app. The operator's own words:
"for all the permissions I have to go to superpipeline".

Everything needed to answer one already exists here:

- `elicitations` table, ids `elc_…`, statuses `pending | answered | cancelled`
- `parseElicitationOptions`, which already accepts the `{id,label}` spelling the Matrix
  side uses
- `POST /v1/boards/:id/elicitations/:elicitationId/answer` taking `{ option?, text? }`
- separation of duties at the only place it matters: `answeredBy === elicitation.agentId`
  is refused inside the DO, on every surface

What is missing is that **nobody is told a question was asked.** `openElicitation`
emits `elicitation.opened` internally and files an in-app notification. There is no
push event, so nothing outside the web app can know.

## Scope

In: the board's name travelling with a gate; an `elicitation.pending` push; a
pending-elicitation read for the hub's sweep.

Out: free-text answers over Matrix. Decided with the operator on 2026-10-02 — **buttons
only**. An elicitation whose agent offered no options stays a web-app answer, and the
hub says so rather than pretending. Out also: any change to how the web app answers, to
`answerElicitation`'s semantics, or to gate behaviour.

## Global constraints

- **Additive on the wire.** A board and a hub are deployed separately and neither waits
  for the other. Every new field is optional to the reader; every new event is ignorable.
  The precedent is `handoffSummary`, documented as optional "because a board that has
  not shipped … yet sends none".
- **Product vocabulary only.** No local workspace or agent names in code, comments,
  fixtures or docs. The product word is *workspace*.
- The wire names `id`/`label` for an option, not the board's internal `name`/`title`.
  `gatePendingBody` already says why: those names are pinned by agentpod's
  `fixtures/ecosystem-identity/matrix_gate_events.json`, which three repos validate
  against. The board's own vocabulary stops at that boundary.
- superpipeline stays on the `0.0.x` series.

## Design

### 1. A gate carries its board's name

`gatePendingBody` gains one field:

```ts
boardName: this.getMeta('name'),
```

Optional to the reader, as `handoffSummary` is. Nothing else changes: the hub decides
what to do with it, and a hub that does not know the field ignores it.

Why on `gate.pending` rather than a new endpoint: it is the message the hub already
receives per board, it costs one field, and it needs no new credential — the open
question of how the hub reads board membership with a service credential stays open and
untouched.

**A board renamed later.** The name travels on every gate, so the room's name converges
on the next gate rather than at rename time. That is a deliberate limit: a push on
rename would be a new event with no other reader, and a board whose name is stale in
Matrix until its next approval is a cosmetic lag, not a wrong answer. Recorded here so
the next reader does not treat it as an oversight.

### 2. `elicitation.pending`

A new push body, built from the elicitation's own row, mirroring `gatePendingBody`
field for field where the two coincide:

```ts
export interface ElicitationPendingBody {
  event: 'elicitation.pending';
  boardId: string;
  boardName: string;         // same reason as above, same optionality to the reader
  cardId: string;
  cardTitle: string;
  elicitationId: string;     // elc_…
  runId: string;
  stageKey: string;
  agentId: string;           // who is blocked — and who may not answer
  question: string;          // the elicitation's `question`; may be empty
  options: Array<{ id: string; label: string }>;   // from options_json, `name`→id, `title`→label
  ts: string;                // created_at
}
```

`options` may be **empty**, and the body is still sent. An elicitation with no options
cannot be answered with a button, and the hub needs to know one exists in order to say
where it can be answered. A body that omitted the unanswerable case would make silence
mean two different things.

Read from the row, not from the activity that produced it, for the reason
`gatePendingBody` gives: a question must keep the options it was asked with.

**Emitted from `openElicitation`**, next to the existing `emit` and `notify`, and gated
on subscription exactly as `notifyGatePending` is:

```ts
this.notifyElicitationPending(id);
```

Fan-out is **by subscription only** — never by capability. `notifyGatePending` already
explains why at length: a question addressed to a human must not be matched against
agents advertising a stage's capability.

**Supersession is already correct and must stay visible.** `openElicitation` calls
`cancelElicitationsForCard` first, so a second question retires the first. The hub
therefore has to be able to discover that a question it posted is no longer pending —
which is what §3 is for. No new event is added for the cancellation: absence from the
pending list is the signal, the same mechanism the gate sweep already relies on.

### 3. `pendingElicitationDeliveries()`

```ts
async pendingElicitationDeliveries(): Promise<ElicitationPendingBody[]>
```

Every `status = 'pending'` elicitation, oldest first, in the push body's shape — the
mirror of `pendingGateDeliveries()`, and for the same stated reason: push is retried
five times and then dead-lettered, at which point the fact is silent on both sides.
This is what lets the hub ask instead of waiting to be told.

It is also what makes the rollout in §4 non-blocking, and what lets the hub settle a
room card for a question answered in the web app or superseded by a newer one: a
question the hub posted that is absent from this list is a question that is over.

Exposed on the same route family the gate sweep already uses, with the same credential.

### 4. Rollout

Push configs are **per board** and carry an explicit `events` list
(`POST /v1/boards/:id/push-configs`). An existing config does not gain a new event by
itself, so each board's config must be re-registered to include `elicitation.pending`.

This is deliberately not a migration. §3 means a board whose config has not been
updated is still served — later, by sweep, rather than immediately by push. So the
rollout is: ship, let the sweep carry it, update configs per board, and the only
observable difference is latency.

## Testing

Unit, against the DO, no network:

1. `gatePendingBody` carries `boardName` from the board's meta — and a board with no
   name set produces a body that still validates.
2. `openElicitation` queues an `elicitation.pending` delivery for a config subscribed to
   it, and **none** for a config that is not. (The second half is the test that would
   have caught the capability-fan-out mistake.)
3. An elicitation with zero options still produces a body, with `options: []`.
4. Options keep the spelling they were asked with: `name`→`id`, `title`→`label`, order
   preserved, duplicates already dropped by `parseElicitationOptions`.
5. A second question on the same card cancels the first, and
   `pendingElicitationDeliveries()` then returns only the second.
6. `pendingElicitationDeliveries()` excludes `answered` and `cancelled`, and orders by
   `created_at`.
7. `answerElicitation` still refuses the asking agent by identity, and still refuses an
   option that was not offered — pinned here because the hub is about to become a second
   caller of it.

Each test must fail before its implementation exists. A test that passes on first write
is not evidence.

## What this does not do

- No free-text answer path. Buttons only, by decision.
- No event on board rename; the name converges on the next gate (§1).
- Nothing about how the hub holds, renders or answers any of this — that is the
  companion spec.
- No change to the push retry or dead-letter policy.

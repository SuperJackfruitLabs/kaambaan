# An agent composes a board

**Status:** accepted 2026-10-02 (operator)
**Follows:** `2026-10-02-a-coordinator-plans-the-work-design.md`

## Why this reverses part of the last spec

That spec put "editing stages" on the human-only side, with this reason:

> Changing a stage re-routes every card on it and can strand work — a gateless human terminal stage
> did exactly that to seven cards, found the same day.

That argument is sound and it is about **editing an existing pipeline**. It was then applied to
board *creation* as well, and there it does not hold: **a new board has no cards**, so getting its
routing wrong strands nothing. The operator identified the conflation; this separates the two.

It also answers a measured gap. Of ten boards, **four have no stage instructions at all** — fourteen
agent-owned stages with no runbook:

| | boards | agent stages without a runbook |
|---|---|---|
| uninstructed | Planning & Roadmap, Developer Experience, Client Quality, Research & Intelligence | **14** |
| instructed | the other six (Agent Onboarding alone carries 15,895 characters) | 0 |

Client Quality shows the cost. Four agents took a card from audit to a verified commit with nothing
but a stage NAME to go on — good work — and then it drifted exactly where no instruction spoke: no
pull request was opened, and the verify handoff read "verification is in progress" on a run that had
completed. Writing fourteen runbooks is agent work, and no agent could do it.

## The line

| act | who | why |
|---|---|---|
| **create a board** | agent (`compose`) | it has no cards; bad routing strands nothing, and `#135`'s lane header shows a capability nobody declares |
| **write a stage's `instructions`** | agent (`compose`) | prose handed to whoever claims there. Wrong is *bad work* — visible in a handoff, recoverable, one card at a time |
| change `ownerKind`/`owner`/`requires`/`order`/`gate`/`wipLimit` on an existing board | **human** | routing. Wrong is *silent stranding*, across every card in the lane |
| replace a pipeline (`POST …/stages`) | **human** | the same, wholesale — and it has already destroyed instructions once |
| rename or **delete** a board | **human** | a board is a commitment about what the lab does, and delete takes every card with it |

The operator's words on the boundary: agents create, agents never delete.

## New scope: `compose`

```
AgentScope = 'claim' | 'run' | 'read' | 'queue' | 'plan' | 'compose'
```

Its own scope rather than part of `plan`, for the reason the vocabulary already follows — "a verifier
wants `read` and must never have `queue`". Most `plan` holders should not create boards, and the
agent who should write runbooks (keeper-karen, whose declared capability is `documentation`) needs
neither card edits nor moves to do it.

`compose` reaches exactly two things:

- `POST /v1/boards` — create one
- `PATCH /v1/boards/:id/stages/:key` — **`instructions` only**

Everything else on those routes stays refused, including every other field of that PATCH.

### Field-level authorisation is a new pattern, and that is a cost

Scopes in this codebase have always gated route + method. "May PATCH a stage, but only
`instructions`" is the first field-level grant, and it is recorded here as a precedent rather than
slipped in: a reviewer should know that a scope can now permit a route and still refuse a body. The
refusal names the field, so a caller that sends `owner` learns which key was the problem rather than
that the route is closed.

## Provenance: a board must say who made it

`boards` records **no creator at all** today — not the human, not an agent. An agent-created board
would appear in the workspace with nothing saying it was not the operator's. That is the gap
`cards.queued_by_agent_id` exists to close, and the same answer applies.

Migration 0016, additive, NULL on every existing row:

```
boards.created_by           the user answerable for it
boards.created_by_agent_id  the agent that composed it, when one did
```

NULL on both is honest for every board that exists now: nobody recorded it, and inventing the
operator would be a lie the audit trail cannot distinguish from a fact.

## What bounds it

- **Owner.** An agent-created board is owned by the agent's `owner_user_id`, and the route refuses
  when the agent has none — the same rule, and the same refusal, as queueing a card
  (`AGENT_HAS_NO_OWNER`). A board nobody is answerable for is not a board.
- **A daily ceiling**, `agents.board_ceiling_per_day`, default 3. Counted from
  `boards.created_by_agent_id` — the provenance column IS the ledger, so there is no second table to
  keep in step. Boards are rare; a loop that makes five hundred of them is the hazard, and a scope
  alone bounds nothing.
- **No pipeline validation beyond shape.** Deliberately: `POST /v1/boards` already validates that
  `stages` is a non-empty array of objects with string keys, and the board itself normalises owners
  and routing. Duplicating that here is how a route starts refusing what the board would accept. A
  lane whose capability nobody declares is now VISIBLE (`#135`) rather than silent, which is the
  right place for that problem.

## Testing

Refusals first, as always:

- a `['read','plan']` token — Chotu's today — is refused board creation, and `plan` does not imply
  `compose` in either direction
- a `['claim','run']` worker token gains nothing (the grandfather regression, a fourth time)
- a `compose` token PATCHing `instructions` succeeds; the same token sending `owner`, `requires`,
  `gate`, `order` or `wipLimit` is refused, and the refusal names the field
- `POST …/stages` (replace the pipeline) and `DELETE` a board are refused on every scope
- a created board records `created_by_agent_id`, and a human-created one records NULL for it
- an agent with no owner is refused `AGENT_HAS_NO_OWNER`
- the daily ceiling refuses the fourth board and the count is per-agent, not per-workspace

## What this does not do

- No delete, for any agent, ever — the operator's line.
- No rename, no pipeline replacement, no routing change on an existing board.
- No validation of whether a new board's capabilities are staffed. `#135` shows it; refusing it here
  would stop an operator composing a board before its agents exist, which is the ordinary order.
